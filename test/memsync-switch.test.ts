// SPDX-License-Identifier: AGPL-3.0-only
// The memory-sync kill switch (docs/memory-sync.md, "Turning it off"): memsync.corrections,
// memsync.change_feed and memsync.quiz in policy.yaml, each on unless set to false. Off, nothing
// of that part leaves the hub through any door (MCP, /v1, /b); on again, it resumes where it was.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain, saveNote } from "../src/brain";
import * as ms from "../src/memsync";

const OLD = { as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-06-01" };
beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

function brain(): string {
  const root = makeBrain();
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD }] };
  saveNote(root, jane);
  return root;
}
const setSync = (root: string, memsync: Record<string, boolean> | undefined) => {
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  if (memsync) p.memsync = { ...(p.memsync ?? {}), ...memsync }; else delete p.memsync;
  writeFileSync(f, YAML.stringify(p));
};
async function call(root: string, token: string, method: string, path: string, body?: unknown) {
  const res = await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${token}` } }));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, text, json };
}
const mcpCheck = async (root: string, token: string) =>
  JSON.parse((await call(root, token, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_check", arguments: {} } })).json.result.content[0].text);

// A drift answer the owner approved: one correction waiting for helper.
async function approvedCorrection(root: string, tok: string) {
  ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  const q = (await call(root, tok, "GET", "/v1/memory-check")).json.questions[0];
  await call(root, tok, "POST", "/v1/memory-check", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  const c = ms.state(root).corrections.at(-1)!;
  ms.approve(root, c.id);
  return c.id;
}

test("corrections off: an approved correction stays at the hub, through MCP and /v1, and goes out once it's back on", async () => {
  const root = brain();
  const tok = issueToken(root, "helper");
  const id = await approvedCorrection(root, tok);
  setSync(root, { corrections: false });
  const v1 = (await call(root, tok, "GET", "/v1/memory-check")).json;
  const viaMcp = await mcpCheck(root, tok);
  for (const c of [v1, viaMcp]) {
    expect(c.corrections).toEqual([]);
    expect(c.off).toContain("corrections");
  }
  expect(ms.state(root).corrections.find((c) => c.id === id)!.state).toBe("approved"); // not marked delivered
  setSync(root, { corrections: true });
  expect((await mcpCheck(root, tok)).corrections.map((c: any) => c.id)).toEqual([id]);
});

test("change feed off: a changed fact isn't listed, and nothing is recorded as shown; back on, the change comes through", async () => {
  const root = brain();
  const tok = issueToken(root, "helper");
  await mcpCheck(root, tok); // baseline
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  (jane.fm.facts!.role as any).value = "Program director";
  saveNote(root, jane);
  setSync(root, { change_feed: false });
  const off = await mcpCheck(root, tok);
  expect(off.changes).toBeUndefined();
  expect(off.off).toEqual(["change_feed"]);
  expect(ms.state(root).feeds).toHaveLength(0);
  setSync(root, { change_feed: true });
  expect((await mcpCheck(root, tok)).changes.items.map((i: any) => i.now)).toEqual(["Program director"]);
});

test("quiz off: no question is made or handed out, by the nightly pass or after a reply", async () => {
  const root = brain();
  const tok = issueToken(root, "helper");
  ms.quiz(root, "helper", 1, ["people/jane-roy#role"]); // asked before the switch
  setSync(root, { quiz: false });
  expect(ms.quiz(root, "helper", 3)).toEqual([]);
  expect(ms.syncPass(root).helper?.quizzed ?? 0).toBe(0);
  const c = (await call(root, tok, "GET", "/v1/memory-check")).json;
  expect(c.questions).toEqual([]);
  expect(c.off).toEqual(["quiz"]);
});

test("all on by default: no memsync block, nothing is off", async () => {
  const root = brain();
  const tok = issueToken(root, "helper");
  setSync(root, undefined);
  ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  const c = await mcpCheck(root, tok);
  expect(c.questions).toHaveLength(1);
  expect(c.off).toBeUndefined();
});

test("pocketbrain memsync off|on prints the policy.yaml edit for the owner and changes nothing itself", () => {
  const root = brain();
  setSync(root, { quiz_budget: true } as any);
  const before = readFileSync(join(root, "rules/policy.yaml"), "utf8");
  const off = ms.switchEdit(root, "off", []);
  expect(off).toContain("memsync:");
  expect(off).toMatch(/corrections: false/);
  expect(off).toMatch(/change_feed: false/);
  expect(off).toMatch(/quiz: false/);
  expect(off).toMatch(/quiz_budget: true/); // what's there stays
  expect(ms.switchEdit(root, "off", ["quiz"])).toMatch(/quiz: false/);
  expect(ms.switchEdit(root, "off", ["quiz"])).not.toMatch(/corrections: false/);
  expect(() => ms.switchEdit(root, "off", ["everything"])).toThrow(/corrections, change_feed or quiz/);
  expect(readFileSync(join(root, "rules/policy.yaml"), "utf8")).toBe(before);
});
