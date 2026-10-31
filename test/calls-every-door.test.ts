// SPDX-License-Identifier: AGPL-3.0-only
// Every door logs every call (docs/refusals.md): MCP by header, MCP with the token in the path,
// the API and the browser door each add one line per call to log/calls.jsonl, for every read
// that lands in log/reads.jsonl.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";

const lines = (root: string, f: string) => existsSync(join(root, "log", f)) ? readFileSync(join(root, "log", f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const mcpBody = (name: string, args: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("each door: one calls line per agent call, as many as the reads it made", async () => {
  const root = makeBrain();
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^  helper: \{ /m, "  helper: { browser: true, "));
  const tok = { planner: issueToken(root, "planner"), helper: issueToken(root, "helper"), steward: issueToken(root, "steward") };
  const call = (path: string, init: RequestInit) => handle(root, new Request(`http://pb${path}`, { redirect: "manual", ...init }));
  // MCP with the token in a header (a token in the path is refused, G419)
  await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${tok.planner}`, "content-type": "application/json" }, body: mcpBody("context_pack", { topic: "course" }) });
  await call("/mcp", { method: "POST", headers: { authorization: `Bearer ${tok.planner}`, "content-type": "application/json" }, body: mcpBody("search", { query: "course" }) });
  // the API
  await call("/v1/context?topic=course", { headers: { authorization: `Bearer ${tok.steward}` } });
  await call("/v1/notes/projects/course-a", { headers: { authorization: `Bearer ${tok.steward}` } });
  // the browser door
  const login = await call("/b/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ agent: "helper", password: tok.helper }).toString() });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  await call("/b/context?topic=course", { headers: { cookie } });
  await call("/b/search?q=course", { headers: { cookie } });

  const calls = lines(root, "calls.jsonl").map((l) => `${l.agent} ${l.tool}`);
  expect(calls).toEqual(["planner context_pack", "planner search", "steward GET /v1/context", "steward GET /v1/notes", "helper GET /b/context", "helper GET /b/search"]);
  const readers = (f: string) => [...new Set(lines(root, f).map((l) => l.agent))].sort();
  expect(readers("calls.jsonl")).toEqual(readers("reads.jsonl"));
});

test("connecting is a call, not an orientation read: initialize logs `initialize` and a connect read", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "planner");
  await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) }));
  await handle(root, new Request("http://pb/v1", { headers: { authorization: `Bearer ${tok}` } }));
  expect(lines(root, "calls.jsonl").map((l) => l.tool)).toEqual(["initialize", "GET /v1"]);
  expect(lines(root, "reads.jsonl").map((l) => l.op)).toEqual(["connect", "connect"]);
});

test("reads with no call lines are found: the call log is missing a door", async () => {
  const { uncalled } = await import("../src/calls");
  const root = makeBrain();
  const tok = issueToken(root, "planner");
  await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: mcpBody("search", { query: "course" }) }));
  expect(uncalled(root, Date.now() - 86_400_000)).toEqual([]);
  // reads logged by a path that skipped the call log
  const now = new Date().toISOString();
  writeFileSync(join(root, "log", "reads.jsonl"), readFileSync(join(root, "log", "reads.jsonl"), "utf8") + [1, 2, 3].map(() => JSON.stringify({ at: now, agent: "helper", op: "search", ids: [] })).join("\n") + "\n" + JSON.stringify({ at: now, agent: "steward", op: "connect", ids: [] }) + "\n");
  expect(uncalled(root, Date.now() - 86_400_000)).toEqual([{ agent: "helper", reads: 3 }]);
});

test("doctor warns when an agent read the brain in the last day with no call lines", async () => {
  const { doctor } = await import("../src/doctor");
  const root = makeBrain();
  const now = new Date().toISOString();
  const area = async () => (await doctor(root, { offline: true })).filter((x) => x.area === "call log");
  expect((await area()).map((f) => f.level)).toEqual(["ok"]);
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "reads.jsonl"), [1, 2, 3].map(() => JSON.stringify({ at: now, agent: "helper", op: "context_pack", ids: [] })).join("\n") + "\n");
  const f = await area();
  expect(f.map((x) => x.level)).toEqual(["warn"]);
  expect(f[0].text).toContain("helper");
});
