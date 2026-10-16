// SPDX-License-Identifier: AGPL-3.0-only
// whats_new / GET /v1/changes (docs/push-vs-pull.md): hosted assistants can't be pushed to, so
// each one asks what changed since it last looked. The hub keeps the cursor; the answer stays
// inside the caller's slice and names no other assistant.
import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadRules } from "../src/rules";
import { standingInstruction } from "../src/orientation";

const SRC = { as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" };
afterEach(() => { delete process.env.PB_NOW; });

async function call(root: string, token: string, method: string, path: string, body?: unknown) {
  const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, text, json };
}
const mcp = async (root: string, token: string, method: string, params: Record<string, unknown> = {}) =>
  (await call(root, token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method, params })).json;
const tick = () => Bun.sleep(1100); // git dates are to the second

test("an agent sees what changed in its slice since it last asked, and nothing it can't see", async () => {
  const root = makeBrain();
  const steward = issueToken(root, "steward"), planner = issueToken(root, "planner"), helper = issueToken(root, "helper");
  // The first call looks a week back and sets the cursor.
  expect((await call(root, helper, "GET", "/v1/changes")).json.changes).toEqual([]);
  await tick();
  expect((await call(root, planner, "POST", "/v1/remember", { id: "projects/course-a", attribute: "next_step", value: "Publish grades", ...SRC })).json.outcome).toBe("committed");
  expect((await call(root, steward, "POST", "/v1/remember", { id: "money/main-bank", attribute: "branch", value: "Downtown", ...SRC })).json.outcome).toBe("committed");

  const r = await call(root, helper, "GET", "/v1/changes");
  expect(r.status).toBe(200);
  expect(r.json.changes.map((c: any) => c.id)).toEqual(["projects/course-a"]); // not the money note
  expect(r.json.changes[0]).toMatchObject({ attrs_changed: ["next_step"], by: "an assistant", title: expect.any(String) });
  expect(r.json.changes[0].markdown).toContain("Publish grades");
  expect(r.text).not.toContain("planner");
  expect(r.text).not.toContain("Downtown");

  // The writer doesn't get its own write back.
  expect((await call(root, planner, "GET", `/v1/changes?since=${encodeURIComponent(r.json.since)}`)).json.changes).toEqual([]);

  // Asked again: nothing new. The cursor lives on the hub, in the read log.
  expect((await call(root, helper, "GET", "/v1/changes")).json.changes).toEqual([]);
  const ops = readFileSync(join(root, "log/reads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.op === "whats_new");
  expect(ops.map((o) => o.agent)).toEqual(["helper", "helper", "planner", "helper"]);
  expect(ops.every((o) => /^[0-9a-f]{40}$/.test(o.head))).toBe(true);

  // An explicit since still works.
  expect((await call(root, helper, "GET", `/v1/changes?since=${encodeURIComponent(r.json.since)}`)).json.changes.map((c: any) => c.id)).toEqual(["projects/course-a"]);
  expect((await call(root, helper, "GET", "/v1/changes?since=yesterday")).status).toBe(400);
});

test("a note in view whose changed fact is hidden doesn't show up", async () => {
  const root = makeBrain();
  const steward = issueToken(root, "steward"), planner = issueToken(root, "planner");
  expect((await call(root, steward, "POST", "/v1/remember", { title: "Ann Lee", type: "person", area: "personal", attribute: "role", value: "Neighbour", ...SRC })).json.outcome).toBe("committed");
  const first = await call(root, planner, "GET", "/v1/changes");
  expect(first.json.changes.map((c: any) => c.title)).toContain("Ann Lee"); // role is in contacts-basic
  await tick();
  const id = first.json.changes.find((c: any) => c.title === "Ann Lee").id;
  expect((await call(root, steward, "POST", "/v1/remember", { id, attribute: "birthday", value: "1980-02-03", ...SRC })).json.outcome).toBe("committed");
  const r = await call(root, planner, "GET", "/v1/changes");
  expect(r.json.changes).toEqual([]);
  expect(r.text).not.toContain("1980");
});

test("over MCP it is listed right after orientation, says when nothing is new, and the standing block asks for it", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  const names = (await mcp(root, planner, "tools/list")).result.tools.map((t: any) => t.name);
  expect(names.slice(0, 2)).toEqual(["orientation", "whats_new"]);
  await mcp(root, planner, "tools/call", { name: "whats_new", arguments: {} });
  await tick();
  const r = await mcp(root, planner, "tools/call", { name: "whats_new", arguments: {} });
  expect(r.result.isError).toBe(false);
  expect(r.result.content[0].text).toStartWith("Nothing new since ");
  expect(standingInstruction(loadRules(root), "mcp")).toContain("whats_new");
  expect(standingInstruction(loadRules(root), "api")).toContain("then /v1/changes");
  expect((await call(root, planner, "GET", "/v1/orientation")).text).toContain("GET /v1/changes at the start of each conversation");
});
