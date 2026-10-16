// SPDX-License-Identifier: AGPL-3.0-only
// Per-agent request budget (backlog 240): a runaway agent gets a plain 429 with when to retry on
// every door, one alert reaches the owner, and other agents are untouched.
import { test, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { resetBudgets } from "../src/budget";

beforeEach(() => resetBudgets());

const setPolicy = (root: string, fn: (p: any) => void) => {
  const f = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8")); fn(p); writeFileSync(f, YAML.stringify(p));
};
const alerts = (root: string) => {
  const f = join(root, "log", "alerts.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const rpc = (name: string, args: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });

test("over its requests per minute an agent gets 429 with Retry-After, one alert, and other agents still get in", async () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.budget = { requests_per_minute: 3 }; });
  const tok = issueToken(root, "planner"), other = issueToken(root, "steward");
  const get = (t: string) => handle(root, new Request("http://pb/v1/search?q=plans", { headers: { authorization: `Bearer ${t}` } }));
  for (let i = 0; i < 3; i++) expect((await get(tok)).status).toBe(200);
  const r = await get(tok);
  expect(r.status).toBe(429);
  expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await r.json()).error).toMatch(/too many requests.*try again in \d+ s/i);
  expect((await get(tok)).status).toBe(429);
  expect((await get(other)).status).toBe(200);
  const mine = alerts(root).filter((a) => a.check === "request_budget");
  expect(mine).toHaveLength(1);
  expect(mine[0].agent).toBe("planner");
});

test("writes have their own hourly budget, on the API and on MCP tools, and a per-agent setting wins", async () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.budget = { writes_per_hour: 2 }; p.agents.steward.budget = { writes_per_hour: 50 }; });
  const tok = issueToken(root, "planner"), stew = issueToken(root, "steward");
  const H = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  const log = (t: string, i: number) => handle(root, new Request("http://pb/v1/logs", { method: "POST", headers: H(t), body: JSON.stringify({ text: `session ${i}` }) }));
  expect((await log(tok, 1)).status).toBeLessThan(400);
  const viaMcp = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: H(tok), body: rpc("log_session", { text: "session 2" }) }));
  expect((await viaMcp.json()).result.isError).toBe(false);
  const third = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: H(tok), body: rpc("log_session", { text: "session 3" }) }));
  const j = await third.json();
  expect(j.result.isError).toBe(true);
  expect(j.result.content[0].text).toMatch(/too many writes.*try again in \d+ s/i);
  expect((await log(tok, 4)).status).toBe(429);
  // Reads still work while writes wait.
  expect((await handle(root, new Request("http://pb/v1/search?q=plans", { headers: H(tok) }))).status).toBe(200);
  for (let i = 0; i < 4; i++) expect((await log(stew, i)).status).toBeLessThan(400);
});

test("the defaults are generous: 100 reads in a row pass", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "planner");
  for (let i = 0; i < 100; i++) {
    const r = await handle(root, new Request("http://pb/v1/search?q=x", { headers: { authorization: `Bearer ${tok}` } }));
    expect(r.status).toBe(200);
  }
});

test("the browser door has the same budget: a page past it says when to come back", async () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.budget = { requests_per_minute: 2 }; p.agents.steward.browser = true; });
  const tok = issueToken(root, "steward");
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(`http://pb${path}`, { redirect: "manual", ...init }));
  const login = await call("/b/login", { method: "POST", body: new URLSearchParams({ agent: "steward", password: tok }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  for (let i = 0; i < 2; i++) expect((await call("/b/changes", { headers: { cookie } })).status).toBe(200);
  const r = await call("/b/changes", { headers: { cookie } });
  expect(r.status).toBe(429);
  expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
  expect(await r.text()).toMatch(/try again in \d+ s/);
});

test("slice audit 240: a reader token can't spend the resolver's budget, and the owner's channel is never turned away", async () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.budget = { requests_per_minute: 3, writes_per_hour: 1 }; });
  const reader = issueToken(root, "steward", "reader"), resolver = issueToken(root, "steward", "resolver");
  const get = (t: string, path: string) => handle(root, new Request(`http://pb${path}`, { headers: { authorization: `Bearer ${t}` } }));
  for (let i = 0; i < 4; i++) await get(reader, "/v1/search?q=x");
  expect((await get(reader, "/v1/search?q=x")).status).toBe(429);
  for (let i = 0; i < 6; i++) expect((await get(resolver, "/v1/disputes")).status).toBe(200);
});

test("slice audit 240: only a write that lands is counted; a 404 or a refused form spends nothing", async () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.budget = { writes_per_hour: 2 }; });
  const tok = issueToken(root, "planner");
  const H = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
  for (let i = 0; i < 5; i++) expect((await handle(root, new Request("http://pb/v1/nope", { method: "POST", headers: H, body: "{}" }))).status).toBe(404);
  for (let i = 0; i < 2; i++) expect((await handle(root, new Request("http://pb/v1/logs", { method: "POST", headers: H, body: JSON.stringify({ text: `s ${i}` }) }))).status).toBeLessThan(400);
  expect((await handle(root, new Request("http://pb/v1/logs", { method: "POST", headers: H, body: JSON.stringify({ text: "s 3" }) }))).status).toBe(429);
});

test("slice audit 240: a budget alert is not a leak and is not texted; 0 means none; Retry-After follows a lowered cap", async () => {
  const { measures } = await import("../src/measure");
  const { openItems } = await import("../src/textline/items");
  const { spend } = await import("../src/budget");
  const root = makeBrain();
  setPolicy(root, (p) => { p.agents.planner.budget = { writes_per_hour: 0 }; });
  const t0 = Date.now();
  expect(spend(root, "planner", "write", t0)).toBe(3600);
  const today = new Date().toISOString().slice(0, 10);
  expect(measures(root, [today])[0].leaks).toBe(0);
  expect(openItems(root).some((i) => /request_budget/.test(i.title))).toBe(false);
  // Ten requests over ten seconds, then the cap drops to 5: the next free slot is when the 6th-newest ages out.
  setPolicy(root, (p) => { p.agents.helper.budget = { requests_per_minute: 10 }; });
  for (let i = 0; i < 10; i++) spend(root, "helper", "request", t0 + i * 1000);
  setPolicy(root, (p) => { p.agents.helper.budget = { requests_per_minute: 5 }; });
  expect(spend(root, "helper", "request", t0 + 10_000)).toBe(55);
});

test("re-audit 240: parallel writes can't all slip under the cap, and the resolver has room but a limit", async () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.budget = { requests_per_minute: 3, writes_per_hour: 2 }; });
  const tok = issueToken(root, "planner");
  const H = { authorization: `Bearer ${tok}`, "content-type": "application/json" };
  setPolicy(root, (p) => { p.budget.requests_per_minute = 1000; });
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => handle(root, new Request("http://pb/v1/logs", { method: "POST", headers: H, body: JSON.stringify({ text: `p ${i}` }) }))));
  expect(rs.filter((r) => r.status < 400).length).toBe(2);
  expect(rs.filter((r) => r.status === 429).length).toBe(18);
  setPolicy(root, (p) => { p.budget.requests_per_minute = 3; });
  const resolver = issueToken(root, "steward", "resolver");
  const codes: number[] = [];
  for (let i = 0; i < 31; i++) codes.push((await handle(root, new Request("http://pb/v1/disputes", { headers: { authorization: `Bearer ${resolver}` } }))).status);
  expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
  expect(codes[30]).toBe(429);
});

test("re-audit 240 N5: a paused agent's open browser session sees Paused, not Slow down, and raises no budget alert", async () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.budget = { requests_per_minute: 2 }; p.agents.steward.browser = true; });
  const tok = issueToken(root, "steward");
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(`http://pb${path}`, { redirect: "manual", ...init }));
  const login = await call("/b/login", { method: "POST", body: new URLSearchParams({ agent: "steward", password: tok }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  setPolicy(root, (p) => { p.agents.steward.status = "paused"; });
  for (let i = 0; i < 4; i++) expect((await call("/b/changes", { headers: { cookie } })).status).toBe(403);
  expect(alerts(root).filter((a) => a.check === "request_budget")).toHaveLength(0);
});
