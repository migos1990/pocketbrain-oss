// SPDX-License-Identifier: AGPL-3.0-only
// What an agent is told on connect must match what the server enforces, and must not name
// what it can't see.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { decideProposal } from "../src/write";
import { loadBrain } from "../src/brain";

function setup() {
  const root = makeBrain();
  const tok: Record<string, string> = { helper: issueToken(root, "helper"), planner: issueToken(root, "planner"), steward: issueToken(root, "steward") };
  const call = async (agent: string | null, method: string, path: string, body?: unknown) => {
    const res = await handle(root, new Request(`http://pb${path}`, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: agent ? { authorization: `Bearer ${tok[agent]}` } : {},
    }));
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, text, json };
  };
  const mcp = async (agent: string, method: string, params?: unknown) => (await call(agent, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params })).json;
  return { root, call, mcp };
}

test("MCP initialize carries the five-line contract; the orientation tool holds the full guide", async () => {
  const { mcp } = setup();
  const init = (await mcp("helper", "initialize", {})).result.instructions as string;
  expect(init.startsWith("# You are helper")).toBe(true);
  expect(init).toContain("context_pack");
  expect(init).toContain("each one waits for");
  expect(init).toContain("[withheld]");
  // Facts outside the cut leave no marker, so finding nothing is never proof there is nothing.
  expect(init).toContain('Found nothing? Say "not in my view".');
  expect(init).toContain("anything durable you learned");
  expect(init).toMatch(/stale fact you can check at its source/);
  // What the owner says in chat is cited as the agent's own word, never as an owner ref without its id.
  expect(init).toContain("is agent:helper, never an owner: ref");
  expect(init.length).toBeLessThan(950); // ~160 tokens
  const tool = (await mcp("helper", "tools/call", { name: "orientation", arguments: {} })).result.content[0].text;
  expect(tool.startsWith("# You are helper")).toBe(true);
  expect(tool).toContain("Not shared with you: money.");
  expect(tool).toContain("every write is a proposal");
  expect(tool).toContain("retire");
  expect(tool).toMatch(/or nothing found: .* Say it isn't in your view, never that it doesn't exist/);
  expect(tool).toMatch(/stale or due and you can open its source/);
  const tools = (await mcp("helper", "tools/list")).result.tools;
  expect(tools.find((t: any) => t.name === "context_pack").description).toMatch(/stale.*check it at its source/);
  const names = (await mcp("helper", "tools/list")).result.tools.map((t: any) => t.name);
  expect(names[0]).toBe("orientation");
  expect(names).toContain("retire");
  expect(tool.length).toBeLessThan(6000); // a hosted assistant reads it in full
});

test("the orientation follows policy.yaml: tier, owned areas, resolver, status", async () => {
  const { root, call } = setup();
  const planner = (await call("planner", "GET", "/v1/orientation?format=json")).json;
  expect(planner.writes.direct_areas).toEqual(["work"]);
  expect(planner.resolver).toBe(false);
  expect(planner.text).toContain("You write directly in the work area");
  expect(planner.text).toContain("POST /v1/retire");
  const ins = (await call("steward", "GET", "/v1/orientation?format=json")).json;
  expect(ins.resolver).toBe(true);
  expect(ins.text).toContain("You are the resolver");
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("planner: { tier: core,", "planner: { tier: core, status: read-only,"));
  const ro = (await call("planner", "GET", "/v1/orientation?format=json")).json;
  expect(ro.writes.refused).toBe(true);
  expect(ro.text).toContain("read-only");
});

test("Helper's orientation names no other agent, no hidden note and no carved value", async () => {
  const { call } = setup();
  const o = (await call("helper", "GET", "/v1/orientation")).text;
  for (const s of ["steward", "planner", "Planbot", "main-bank", "Maple", "paul-advisor", "finance"]) expect(o.toLowerCase()).not.toContain(s.toLowerCase());
});

test("GET /v1 answers with who you are and where to start; no token gets a hint, not a guess", async () => {
  const { call } = setup();
  const root = (await call("helper", "GET", "/v1")).json;
  expect(root.you_are).toBe("helper");
  expect(root.read_first).toBe("/v1/orientation");
  expect(root.orientation).toContain("You are helper");
  const anon = await call(null, "GET", "/v1/orientation");
  expect(anon.status).toBe(401);
  expect(anon.json.hint).toContain("/v1/orientation");
  expect(anon.text).not.toContain("helper");
  const oa = (await call(null, "GET", "/openapi.json")).json;
  expect(oa.paths["/v1/orientation"]).toBeDefined();
  expect(oa.paths["/v1/retire"]).toBeDefined();
});

test("retire: an owner's retire moves the value to history with its source; a trial agent's is a proposal", async () => {
  const { root, call, mcp } = setup();
  const r = (await call("planner", "POST", "/v1/retire", { id: "people/jane-roy", attribute: "role", as_of: "2026-10-05", sources: ["gmail:f000000000000009"], verification: "verified-by-source" })).json;
  expect(r.outcome).toBe("committed");
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  expect(jane.fm.facts?.role).toBeUndefined();
  const h = jane.fm.history!.role.at(-1)!;
  expect(h.value).toBe("Course coordinator");
  expect(h.valid_to).toBe("2026-10-05");
  expect(h.ended_by?.sources).toEqual(["gmail:f000000000000009"]);

  const m = JSON.parse((await mcp("helper", "tools/call", { name: "retire", arguments: { id: "people/jane-roy", attribute: "phones", value: "+15145550100", as_of: "2026-10-06", sources: ["gmail:f00000000000000a"] } })).result.content[0].text);
  expect(m.outcome).toBe("inbox");
  expect(loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts?.phones).toBeDefined();
  const acc = decideProposal(root, m.file, "accept");
  expect(acc.outcome).toBe("committed");
  const item = (loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts?.phones as any).items[0];
  expect(item.valid_to).toBe("2026-10-06");

  const hidden = (await call("helper", "POST", "/v1/retire", { id: "money/main-bank", attribute: "bank", as_of: "2026-10-06", sources: ["gmail:f00000000000000b"] })).json;
  const missing = (await call("helper", "POST", "/v1/retire", { id: "money/no-such", attribute: "bank", as_of: "2026-10-06", sources: ["gmail:f00000000000000b"] })).json;
  expect(hidden.outcome).toBe(missing.outcome);
});

test("the standing instruction tells an agent when to use the brain, under 120 words, with no key", async () => {
  const { root, mcp } = setup();
  const { loadRules } = await import("../src/rules");
  const { standingInstruction } = await import("../src/orientation");
  for (const t of ["mcp", "api"] as const) {
    const s = standingInstruction(loadRules(root), t, "https://brain.example");
    expect(s.split(/\s+/).filter((w) => /\w/.test(w)).length).toBeLessThan(120);
    expect(s).toContain("Before answering anything about");
    expect(s).toContain("from your brain");
    expect(s).not.toContain("pb_");
    expect(s).toContain(t === "api" ? "https://brain.example/v1" : "orientation tool");
  }
  // The tool descriptions carry the same "when", since many hosts never show initialize instructions.
  const tools = (await mcp("helper", "tools/list")).result.tools as { name: string; description: string }[];
  expect(tools.find((x) => x.name === "context_pack")!.description).toContain("before answering anything about the owner's life");
  expect((await mcp("helper", "initialize", {})).result.instructions).toContain("even unasked");
});
