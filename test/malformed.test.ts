// SPDX-License-Identifier: AGPL-3.0-only
// Malformed input is the caller's error, never the server's (backlog #143): a 4xx or a tool
// error, never a 500. And one bad line in rules/tokens.yaml must not lock every agent out.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";

const rpc = (name: string, args: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const POSTS: [string, string][] = [
  ["/mcp", "null"], ["/mcp", "1"], ["/mcp", '"x"'], ["/mcp", "[]"],
  ["/mcp", rpc("log_session", { text: "hi", title: 5 })],
  ["/mcp", rpc("log_session", { text: "hi", channel: null, title: ["a"] })],
  ["/mcp", rpc("log_session", { turns: [{ role: 5, text: null }] })],
  ["/mcp", rpc("remember", "str")],
  ["/mcp", rpc("capture", { text: 5 })],
  ["/mcp", rpc("retire", { id: 5 })],
  ["/mcp", rpc("search", { query: "x", limit: -1 })],
  ["/mcp", rpc("memory_check_reply", { answers: 5 })],
  ["/mcp", rpc("memory_check_reply", { answers: [null, 5], corrections: "x" })],
  ["/mcp", rpc("read_log", { id: 5 })],
  ["/mcp", rpc("whats_new", { since: {} })],
  ["/v1/remember", "null"], ["/v1/remember", "[1]"], ["/v1/retire", "null"],
  ["/v1/logs", JSON.stringify({ text: "x", title: 1 })], ["/v1/logs", "null"],
  ["/v1/capture", "null"], ["/v1/memory-check", "null"], ["/v1/memory-check", JSON.stringify({ answers: 5 })],
  ["/v1/disputes/c-1/answer", "null"], ["/v1/owner/x", "null"],
];
const GETS = ["/v1/notes/%E0%A4%A", "/v1/logs/%ZZ", "/v1/changes?since=zzz", "/v1/changes?limit=-5", "/v1/search?q=a&limit=abc"];

test("malformed bodies, arguments and %-escapes get a 4xx or a tool error, never a 500", async () => {
  const root = makeBrain();
  const bad: string[] = [];
  for (const agent of ["planner", "steward"]) {
    const tok = issueToken(root, agent);
    const H = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
    for (const [p, body] of POSTS) {
      const r = await handle(root, new Request("http://pb" + p, { method: "POST", headers: H, body }));
      const t = await r.text();
      if (r.status >= 500 || /"code":\s*-32603|internal error/.test(t)) bad.push(`${agent} POST ${p} ${body.slice(0, 60)} -> ${r.status}`);
    }
    for (const q of GETS) {
      const r = await handle(root, new Request("http://pb" + q, { headers: H }));
      if (r.status >= 500) bad.push(`${agent} GET ${q} -> ${r.status}`);
    }
  }
  expect(bad).toEqual([]);
});

test("a hand-mangled hash in tokens.yaml is skipped; every other token still works", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  const steward = issueToken(root, "steward");
  const f = join(root, "rules", "tokens.yaml");
  const t = YAML.parse(readFileSync(f, "utf8"));
  t.agents.planner.unshift({ hash: "deadbeef", issued: "2026-10-01" }, { issued: "2026-10-01" }, null);
  writeFileSync(f, YAML.stringify(t));
  const get = (tok: string) => handle(root, new Request("http://pb/v1/search?q=course", { headers: { authorization: `Bearer ${tok}` } }));
  expect((await get(planner)).status).toBe(200);
  expect((await get(steward)).status).toBe(200);
  expect((await get("pb_nobody_x")).status).toBe(401);
});

// From the slice audit of #143.
test("a bad %-escape answers the same for a hidden note and a missing one", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "helper");
  const get = async (p: string) => { const r = await handle(root, new Request("http://pb" + p, { headers: { authorization: `Bearer ${tok}` } })); return `${r.status} ${await r.text()}`; };
  expect(await get("/v1/notes/money%2Fmain-bank%ZZ")).toBe(await get("/v1/notes/money%2Fno-such%ZZ"));
});

test("a stored hash that is short, long or not a string never serves anyone's token", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  const f = join(root, "rules", "tokens.yaml");
  const t = YAML.parse(readFileSync(f, "utf8"));
  const real = t.agents.planner[0].hash as string;
  t.agents.planner = [{ hash: real.slice(0, 62), issued: "2026-10-01" }, { hash: real + "00", issued: "2026-10-01" }, { hash: 123, issued: "2026-10-01" }];
  writeFileSync(f, YAML.stringify(t));
  const r = await handle(root, new Request("http://pb/v1/search?q=course", { headers: { authorization: `Bearer ${planner}` } }));
  expect(r.status).toBe(401);
});

test("junk in a memory-check reply gets no 500 and commits nothing", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "planner");
  const before = Number(Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: root }).stdout.toString());
  for (const body of [{ memory_dump: [] }, { memory_dump: "x" }, { answers: [null, 1, "a", { id: 5 }] }, { corrections: [{ id: null, done: "yes" }] }]) {
    const r = await handle(root, new Request("http://pb/v1/memory-check", { method: "POST", body: JSON.stringify(body), headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } }));
    expect(r.status).toBeLessThan(500);
  }
  expect(Number(Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: root }).stdout.toString())).toBe(before);
});
