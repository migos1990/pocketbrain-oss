// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken, revokeTokens } from "../src/auth";
import { write } from "../src/write";
import { confirmHeldAnswer } from "../src/core";
import { loadBrain, type FactRecord } from "../src/brain";

const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr] as FactRecord & { dispute?: string };

function setup() {
  const root = makeBrain();
  const tok = { helper: issueToken(root, "helper"), planner: issueToken(root, "planner"), steward: issueToken(root, "steward") };
  const call = async (agent: keyof typeof tok | null, method: string, path: string, body?: unknown) => {
    const res = await handle(root, new Request(`http://pb${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: agent ? { authorization: `Bearer ${tok[agent]}` } : {},
    }));
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
  };
  const mcp = (agent: keyof typeof tok, method: string, params?: unknown) => call(agent, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params });
  return { root, tok, call, mcp };
}

test("no token or a revoked token gets nothing", async () => {
  const { root, call } = setup();
  expect((await call(null, "GET", "/v1/context")).status).toBe(401);
  revokeTokens(root, "helper");
  expect((await call("helper", "GET", "/v1/context")).status).toBe(401);
  expect(readFileSync(join(root, "rules/tokens.yaml"), "utf8")).not.toContain("pb_");
});

test("dropping an agent from policy.yaml cuts its token off", async () => {
  const { root, call } = setup();
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^  helper:.*\n/m, ""));
  expect((await call("helper", "GET", "/v1/search?q=course")).status).toBe(401);
});

test("Helper's context and search never contain money; a hidden note reads like a missing one", async () => {
  const { call } = setup();
  const ctx = await call("helper", "GET", "/v1/context");
  expect(ctx.status).toBe(200);
  expect(ctx.text).toContain("Course A");
  expect(ctx.text).not.toContain("Maple Trust");
  expect(ctx.text).toContain("[[redacted]]");
  expect(ctx.text).toContain("Paid through [withheld], per the contract.");
  expect((await call("helper", "GET", "/v1/search?q=maple")).json).toEqual([]);
  const s = await call("helper", "GET", "/v1/search?q=bank");
  expect(s.json.map((h: any) => h.id)).not.toContain("money/main-bank");
  const hidden = await call("helper", "GET", "/v1/notes/money%2Fmain-bank");
  const missing = await call("helper", "GET", "/v1/notes/money%2Fno-such");
  expect(hidden.status).toBe(404);
  expect(hidden.json.error.replace("main-bank", "X")).toBe(missing.json.error.replace("no-such", "X"));
  expect((await call("steward", "GET", "/v1/notes/money%2Fmain-bank")).json.facts.bank.value).toBe("Maple Trust Bank");
});

test("MCP: initialize, list tools, call them; identity comes from the token", async () => {
  const { root, mcp } = setup();
  const init = await mcp("planner", "initialize", { protocolVersion: "2025-06-18" });
  expect(init.json.result.serverInfo.name).toBe("pocketbrain");
  expect((await mcp("planner", "tools/list")).json.result.tools.map((t: any) => t.name)).toEqual(["orientation", "whats_new", "context_pack", "search", "who_is", "read", "why", "remember", "retire", "log_session", "capture", "search_logs", "read_log", "memory_check", "memory_check_reply", "hand_off", "handoff_done"]);
  const read = await mcp("planner", "tools/call", { name: "read", arguments: { id: "people/jane-roy" } });
  expect(read.json.result.content[0].text).toContain("Course coordinator");
  // Planner claims to be steward in the body; the write is still Planner's.
  const w = await mcp("planner", "tools/call", { name: "remember", arguments: { agent: "steward", id: "projects/course-a", attribute: "next_step", value: "Publish grades", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" } });
  expect(JSON.parse(w.json.result.content[0].text).outcome).toBe("committed");
  expect(fact(root, "projects/course-a", "next_step").by).toBe("planner");
  const author = Bun.spawnSync(["git", "log", "-1", "--format=%an"], { cwd: root }).stdout.toString().trim();
  expect(author).toBe("planner");
});

test("Helper writing a carved value through the server is refused and alerted", async () => {
  const { root, call } = setup();
  const r = await call("helper", "POST", "/v1/remember", { id: "projects/course-a", attribute: "funding", value: "Maple Trust Bank", as_of: "2026-10-07", sources: ["gmail:f000000000000006"] });
  expect(r.status).toBe(422);
  expect(readFileSync(join(root, "log/alerts.jsonl"), "utf8")).toContain("helper");
});

test("disputes are the resolver's only; weak evidence is refused, an exact newer source settles it", async () => {
  const { root, call } = setup();
  write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Something else", as_of: "2026-10-07", as_of_approx: true, sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect((await call("planner", "GET", "/v1/disputes")).status).toBe(403);
  const list = await call("steward", "GET", "/v1/disputes");
  expect(list.json.map((d: any) => d.id)).toEqual(["c-0001"]);
  const weak = await call("steward", "POST", "/v1/disputes/c-0001/resolve", { value: "Grade the midterm", as_of: "2026-10-08", sources: ["instinct-mem:abc"] });
  expect(weak.status).toBe(422);
  const ok = await call("steward", "POST", "/v1/disputes/c-0001/resolve", { value: "Grade the midterm", as_of: "2026-10-08", sources: ["gcal:evt123"] });
  expect(ok.json.status).toBe("resolved");
  const f = fact(root, "projects/course-a", "next_step");
  expect(f.value).toBe("Grade the midterm");
  expect(f.dispute).toBeUndefined();
  expect((await call("steward", "GET", "/v1/disputes/c-0001")).json.status).toBe("resolved");
});

test("private disputes can't be resolved by Steward; Robin's relayed answer is held until he confirms", async () => {
  const { root, call } = setup();
  write(root, { agent: "steward", id: "money/main-bank", attribute: "bank", value: "Other Bank", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  const d = (await call("steward", "GET", "/v1/disputes")).json[0];
  expect(d.louis_only).toContain("private");
  expect((await call("steward", "POST", `/v1/disputes/${d.id}/resolve`, { value: "Other Bank", as_of: "2026-10-08", sources: ["gcal:x"] })).status).toBe(403);
  expect((await call("steward", "POST", `/v1/disputes/${d.id}/answer`, { choice: 2 })).status).toBe(400);
  await call("steward", "POST", `/v1/disputes/${d.id}/escalate`, { suggested: 1 });
  const a = await call("steward", "POST", `/v1/disputes/${d.id}/answer`, { choice: 2, message_id: "phonemsg-01FAKE0000000000000000000Z" });
  expect(a.json.status).toBe("answer-held");
  expect((fact(root, "money/main-bank", "bank") as any).dispute).toBe(d.id);
  confirmHeldAnswer(root, d.id, "confirm");
  const f = fact(root, "money/main-bank", "bank");
  expect(f.value).toBe("Other Bank");
  expect(f.verification).toBe("confirmed-by-owner");
});

test("an ordinary relayed answer settles at once as confirmed-by-louis", async () => {
  const { root, call } = setup();
  write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Something else", as_of: "2026-10-07", as_of_approx: true, sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  const a = await call("steward", "POST", "/v1/disputes/c-0001/answer", { choice: 2, message_id: "phonemsg-01FAKE0000000000000000000Q" });
  expect(a.json.status).toBe("resolved");
  const f = fact(root, "projects/course-a", "next_step");
  expect(f.value).toBe("Something else");
  expect(f.verification).toBe("confirmed-by-owner");
});

test("MCP clients that can't send headers can put the token in the path", async () => {
  const { root, tok } = setup();
  const r = await handle(root, new Request(`http://pb/mcp/${tok.helper}`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  expect(r.status).toBe(200);
  expect((await handle(root, new Request("http://pb/mcp/pb_helper_wrong", { method: "POST", body: "{}" }))).status).toBe(401);
});

test("/mcp answers with a trailing slash too", async () => {
  const { tok, call } = setup();
  const r = await call("helper", "POST", "/mcp/", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(r.status).toBe(200);
  expect(r.json.result.tools.length).toBeGreaterThan(0);
  const p = await call(null, "POST", `/mcp/${tok.helper}/`, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(p.status).toBe(200);
});

// G18: a core agent's token split into a reader and a resolver token.
test("token roles: only the resolver or owner channel gets a resolver token; an unknown role in the file is refused", async () => {
  const { root } = setup();
  expect(() => issueToken(root, "helper", "resolver")).toThrow(/resolver/);
  expect(() => issueToken(root, "helper", "boss" as never)).toThrow(/role/);
  const r = issueToken(root, "helper", "reader");
  expect(readFileSync(join(root, "rules/tokens.yaml"), "utf8")).toContain("role: reader");
  const f = join(root, "rules/tokens.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace("role: reader", "role: admin"));
  expect((await handle(root, new Request("http://pb/v1/context", { headers: { authorization: `Bearer ${r}` } }))).status).toBe(401);
});

test("token roles: the reader's cap holds through queued writes and never shrinks the no-role token's cell", async () => {
  const { root, call } = setup();
  const reader = issueToken(root, "steward", "reader");
  const as = (tok: string, method: string, path: string, body?: unknown) => handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok}` } }));
  // A private note answers like a missing one, to a read and to a write by id.
  const read = await as(reader, "GET", "/v1/notes/money%2Fmain-bank");
  const missing = await as(reader, "GET", "/v1/notes/money%2Fno-such-note");
  expect(read.status).toBe(404);
  expect((await read.json()).error.replace("main-bank", "X")).toBe((await missing.json()).error.replace("no-such-note", "X"));
  const w = await (await as(reader, "POST", "/v1/remember", { id: "money/main-bank", attribute: "bank", value: "Other Bank", as_of: "2026-10-04", sources: ["gmail:f000000000000007"] })).json();
  expect(w.outcome).toBe("refused");
  expect(w.message).toMatch(/no note money\/main-bank/);
  // The no-role token still reads it, cells or not.
  expect((await call("steward", "GET", "/v1/notes/money%2Fmain-bank")).status).toBe(200);
  const reads = readFileSync(join(root, "log/reads.jsonl"), "utf8");
  expect(reads).toContain('"token":"reader"');
});

test("a whole-view context_pack from an agent that asks by topic alerts the owner", async () => {
  const { root, call } = setup();
  for (let i = 0; i < 5; i++) await call("planner", "GET", "/v1/context?topic=session");
  await call("planner", "GET", "/v1/context");
  expect(readFileSync(join(root, "log/alerts.jsonl"), "utf8")).toMatch(/whole_view_read.*planner took its whole view/);
});
