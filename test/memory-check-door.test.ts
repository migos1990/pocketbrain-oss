// SPDX-License-Identifier: AGPL-3.0-only
// memory_check tells each door how to reply (docs/memory-sync.md, "The loop"): an agent on the
// JSON API has no memory_check_reply tool, so its text names POST /v1/memory-check and the
// changes_seen field, or it fetches changes and never confirms them (Instinct, 2026-10-24).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import * as ms from "../src/memsync";
import { readJsonl } from "../src/util";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

// A baseline check, then a change in helper's view, so the next check carries a change list.
function changed(): string {
  const root = makeBrain();
  ms.memoryCheck(root, "helper");
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  (jane.fm.facts!.role as { value: string }).value = "Head of programme";
  saveNote(root, jane);
  return root;
}

test("over the JSON API, the reply is named as POST /v1/memory-check with changes_seen, never a tool it lacks", () => {
  const c = ms.memoryCheck(changed(), "helper", "api");
  expect(c.changes).toBeDefined();
  for (const t of [c.how, c.changes!.instruction]) {
    expect(t).toContain("POST /v1/memory-check");
    expect(t).not.toContain("memory_check_reply");
  }
  expect(c.changes!.instruction).toContain(`{"changes_seen": "${c.changes!.id}"}`);
});

test("over MCP the reply is the memory_check_reply tool, as before", () => {
  const c = ms.memoryCheck(changed(), "helper");
  expect(c.how).toContain("memory_check_reply");
  expect(c.changes!.instruction).toContain("memory_check_reply");
  expect(c.changes!.instruction).toContain(c.changes!.id);
});

test("on the browser door the reply is the page's own box and Send button", () => {
  const c = ms.memoryCheck(changed(), "helper", "browser");
  expect(c.changes!.instruction).toMatch(/tick the box below and press Send/);
  expect(c.how).not.toContain("memory_check_reply");
});

// Instinct's routine says only "call pocketBrain's memory_check and do what it says": a client
// that reads nothing but the GET response must still be able to confirm the change list.
test("a literal API client that only follows the response confirms the change list", async () => {
  const root = changed();
  const tok = issueToken(root, "helper");
  const call = async (method: string, path: string, body?: unknown) => (await handle(root, new Request(`http://pb${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok}` } }))).json() as Promise<any>;
  const got = await call("GET", "/v1/memory-check");
  expect(got.reply).toEqual({ method: "POST", path: "/v1/memory-check", body: { changes_seen: got.changes.id }, or_get: `/v1/memory-check?changes_seen=${got.changes.id}` });
  expect((await call(got.reply.method, got.reply.path, got.reply.body)).changes_seen).toMatch(/up to date/);
  expect(ms.state(root).feeds.find((f) => f.id === got.changes.id)!.state).toBe("seen");
  // Nothing left to confirm: no reply template.
  expect((await call("GET", "/v1/memory-check")).reply).toBeUndefined();
});

// Instinct, 2026-10-25: its routine sent one GET and stopped, every hour, with an open list.
test("an API client that can only send GETs confirms with GET ?changes_seen=, once; a repeat changes nothing", async () => {
  const root = changed();
  const tok = issueToken(root, "helper");
  const get = async (path: string) => (await handle(root, new Request(`http://pb${path}`, { headers: { authorization: `Bearer ${tok}` } }))).json() as Promise<any>;
  const got = await get("/v1/memory-check");
  expect(got.reply.or_get).toBe(`/v1/memory-check?changes_seen=${got.changes.id}`);
  expect(got.changes.instruction).toContain(`GET /v1/memory-check?changes_seen=${got.changes.id}`);
  expect((await get(got.reply.or_get)).changes_seen).toMatch(/up to date/);
  expect(ms.state(root).feeds.find((f) => f.id === got.changes.id)!.state).toBe("seen");
  expect((await get(got.reply.or_get)).changes_seen).toMatch(/no such change list/);
});

test("a read-only agent's confirming GET is refused and confirms nothing", async () => {
  const root = changed();
  const tok = issueToken(root, "helper");
  const get = async (path: string) => handle(root, new Request(`http://pb${path}`, { headers: { authorization: `Bearer ${tok}` } }));
  const got = await (await get("/v1/memory-check")).json() as any;
  const f = join(root, "rules/policy.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/(\n  helper: \{)/, "$1 status: read-only,"));
  expect((await get(got.reply.or_get)).status).toBe(403);
  expect(ms.state(root).feeds.find((x) => x.id === got.changes.id)!.state).toBe("open");
});

test("every check logs what it handed out, counts and ids only: a re-handed list and an empty check both show", () => {
  const root = changed();
  const a = ms.memoryCheck(root, "helper", "api");
  ms.memoryCheck(root, "helper", "api");
  const served = readJsonl<Record<string, any>>(join(root, "log", "memsync.jsonl")).filter((e) => e.ev === "served" && e.agent === "helper");
  expect(served).toHaveLength(3); // the baseline check, then the same open list twice
  expect(served[0]).toMatchObject({ door: "mcp", changes: 0, questions: 0 });
  expect(served[1]).toMatchObject({ door: "api", changes: a.changes!.items.length, feed: a.changes!.id });
  expect(served[2]).toMatchObject({ feed: a.changes!.id });
  expect(JSON.stringify(served)).not.toContain("Head of programme");
});
