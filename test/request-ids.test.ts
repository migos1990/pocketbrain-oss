// SPDX-License-Identifier: AGPL-3.0-only
// Request ids end to end (backlog #300, docs/request-ids.md): every door answers with an
// X-Request-Id the hub made, a write carries it in its commit trailer and its log lines,
// log/requests.jsonl holds one line per request, and `pocketbrain trace <id>` shows that
// request's path without printing note contents. Temp brains removed after.
import { test, expect, afterAll } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { REQUEST_ID, withRequest } from "../src/reqid";
import { queueAftercheck, drainAftercheck } from "../src/aftercheck";
import { write } from "../src/write";
import { trimRequestLog } from "../src/growth";
import { secretIn } from "../src/backup";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const APP = join(import.meta.dir, "..");
const VALUE = "Publish grades by Friday";
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();
const lines = (root: string, f: string) => readFileSync(join(root, "log", f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function setup() {
  const root = makeBrain(); roots.push(root);
  const tok = issueToken(root, "planner");
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${tok}` }) =>
    handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }));
  return { root, tok, call };
}
const remember = { id: "projects/course-a", attribute: "next_step", value: VALUE, as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" };

test("an API write: the answer, the commit trailer, the write log and the request log share one hub-made id", async () => {
  const { root, call } = setup();
  const res = await call("POST", "/v1/remember?x=1", remember, { authorization: `Bearer ${issueToken(root, "planner")}`, "x-request-id": "req_00000000000000000000" });
  expect(res.status).toBe(200);
  const id = res.headers.get("x-request-id")!;
  expect(id).toMatch(REQUEST_ID);
  expect(id).not.toBe("req_00000000000000000000"); // a client's own id is never taken as the hub's
  expect(git(root, "log", "-1", "--format=%(trailers:key=Request-Id,valueonly)")).toBe(id);
  expect(lines(root, "writes.jsonl").at(-1).request_id).toBe(id);
  const r = lines(root, "requests.jsonl").find((l) => l.request_id === id);
  expect(r).toMatchObject({ door: "api", method: "POST", route: "/v1/remember", agent: "planner", status: 200 });
  expect(typeof r.ms).toBe("number");
});

test("MCP calls record the tool; a token in the path never reaches the request log; refusals get an id too", async () => {
  const { root, tok, call } = setup();
  const res = await call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remember", arguments: remember } });
  const id = res.headers.get("x-request-id")!;
  expect(lines(root, "requests.jsonl").find((l) => l.request_id === id)).toMatchObject({ door: "mcp", tool: "remember", agent: "planner" });
  expect(git(root, "log", "-1", "--format=%(trailers:key=Request-Id,valueonly)")).toBe(id);
  const inPath = await call("POST", `/mcp/${tok}`, { jsonrpc: "2.0", id: 2, method: "ping" }, {});
  expect(inPath.status).toBe(401); // a token in the path is refused (G419), and still never logged
  expect(inPath.headers.get("x-request-id")).toMatch(REQUEST_ID);
  const denied = await call("GET", "/v1/context", undefined, {});
  expect(denied.status).toBe(401);
  expect(denied.headers.get("x-request-id")).toMatch(REQUEST_ID);
  const log = readFileSync(join(root, "log", "requests.jsonl"), "utf8");
  expect(log).not.toContain(tok);
  expect(log).not.toContain(VALUE);
});

test("a commit made outside any request carries no Request-Id", () => {
  const { root } = setup();
  write(root, { ...remember, agent: "planner", value: "Grade the midterm" } as never);
  expect(git(root, "log", "-1", "--format=%s")).toContain("next_step");
  expect(git(root, "log", "-1", "--format=%(trailers:key=Request-Id,valueonly)")).toBe("");
});

test("pocketbrain trace shows the request, its log lines and its commit, never the value; a bad or unknown id is refused", async () => {
  const { root, call } = setup();
  const id = (await call("POST", "/v1/remember", remember)).headers.get("x-request-id")!;
  const run = (arg: string) => { const p = Bun.spawnSync(["bun", "src/cli.ts", "trace", arg, "--brain", root], { cwd: APP }); return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }; };
  const t = run(id);
  expect(t.code).toBe(0);
  expect(t.out).toContain("api POST /v1/remember");
  expect(t.out).toContain("planner");
  expect(t.out).toContain("writes.jsonl");
  expect(t.out).toContain(git(root, "log", "-1", "--format=%h"));
  expect(t.out).toContain("projects/course-a#next_step");
  expect(t.out).not.toContain(VALUE);
  expect(run("not-an-id").code).not.toBe(0);
  const unknown = run("req_ffffffffffffffffffff");
  expect(unknown.code).not.toBe(0);
  expect(unknown.out).toContain("no request");
});

test("an after-check picked up later runs under the id of the request that queued it, not the one that drained it", async () => {
  const { root } = setup();
  const a = "req_aaaaaaaaaaaaaaaaaaaa", b = "req_bbbbbbbbbbbbbbbbbbbb";
  withRequest({ id: a }, () => queueAftercheck(root, "planner", "projects/course-a#next_step"));
  // One drain runs at a time in the process; another file's background drain may still hold it.
  for (let i = 0; i < 100 && lines(root, "aftercheck.jsonl").length < 2; i++) {
    await withRequest({ id: b }, () => drainAftercheck(root, { conflicts: null, classify: null }));
    if (lines(root, "aftercheck.jsonl").length < 2) await Bun.sleep(50);
  }
  const q = lines(root, "aftercheck.jsonl");
  expect(q.map((l) => [l.event, l.request_id])).toEqual([["queued", a], ["done", a]]);
});

test("the night's housekeeping keeps 30 days of request lines", () => {
  const { root } = setup();
  const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "requests.jsonl"), [40, 31, 2].map((d) => JSON.stringify({ at: day(d), request_id: `req_${String(d).padStart(20, "0")}`, door: "api", method: "GET", route: "/v1/context", status: 200, ms: 1 }) + "\n").join(""));
  expect(trimRequestLog(root)).toBe(2);
  expect(lines(root, "requests.jsonl").map((l) => l.request_id)).toEqual(["req_00000000000000000002"]);
  expect(trimRequestLog(root)).toBe(0);
});

test("G337: a secret-shaped path is never written to log/requests.jsonl or any commit, whether or not log is added", async () => {
  const { root, call } = setup();
  const k = "sk-" + "proj-" + crypto.randomUUID().replace(/-/g, "") + "Ab12";
  const ghp = "ghp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 30) + "ABCDEF";
  for (const p of [`/${k}`, `/v1/notes/${k}`, `/b/${ghp}/x`, `/mcp/oauth/${k}`, `/v1/${k}`]) expect((await call("GET", p, undefined, {})).status).toBeGreaterThanOrEqual(400);
  const log = readFileSync(join(root, "log", "requests.jsonl"), "utf8");
  expect(log.trim().split("\n").length).toBe(5);
  expect(secretIn(log)).toBeUndefined();
  expect(log).not.toContain(k.slice(8, 24));
  expect(log).not.toContain(ghp.slice(4, 20));
  // known prefixes stay readable, unknown segments are templated
  expect(JSON.parse(log.split("\n")[1]).route).toBe("/v1/notes/:x");
  git(root, "add", "-A", "log");
  git(root, "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "log");
  expect(secretIn(git(root, "log", "-p", "--all"))).toBeUndefined();
  // and a brain made by init keeps the file out of git altogether
  expect(readFileSync(join(APP, "src", "init.ts"), "utf8")).toContain("log/requests.jsonl\\n");
});
