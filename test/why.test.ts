// SPDX-License-Identifier: AGPL-3.0-only
// Backlog 291 (docs/why.md): where a fact came from. An agent sees the provenance of a fact in
// its own view only, never earlier values, refused writes or other agents' names; the owner
// sees all of it.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import * as core from "../src/core";
import { useCells } from "../src/cell";
import { LANE_CELLS, restoreCells } from "./cells";
import { whyText } from "../src/why";
import { dashboardHandler } from "../src/dashboard/server";

afterEach(restoreCells);

function setup() {
  const root = makeBrain({ git: false });
  const course = join(root, "projects/course-a.md");
  // An earlier value in history, and a private fact on the same note.
  writeFileSync(course, readFileSync(course, "utf8").replace(
    "---\nCourse logistics.",
    "history:\n  next_step: [{ value: Write the syllabus, as_of: 2026-08-01, sources: [\"gmail:f000000000000009\"], verification: verified-by-source, by: steward, recorded: 2026-08-02 }]\n---\nCourse logistics.",
  ).replace(
    "facts:\n",
    "facts:\n  fee_owed: { value: Owes Grandpa 900, as_of: 2026-10-01, sources: [\"gmail:f000000000000004\"], verification: verified-by-source, sensitivity: private, by: steward, recorded: 2026-10-01 }\n",
  ));
  mkdirSync(join(root, "log"), { recursive: true });
  const w = (e: object) => appendFileSync(join(root, "log/writes.jsonl"), JSON.stringify(e) + "\n");
  w({ at: "2026-10-01T10:00:00Z", agent: "planner", kind: "fact", key: "projects/course-a#next_step", outcome: "committed", step: 1, checks: [] });
  w({ at: "2026-10-02T10:00:00Z", agent: "helper", kind: "fact", key: "projects/course-a#next_step", outcome: "refused", checks: ["source"] });
  w({ at: "2026-10-02T11:00:00Z", agent: "steward", kind: "fact", key: "projects/course-a#next_step", outcome: "refused", checks: ["pii_warn"] });
  w({ at: "2026-10-02T12:00:00Z", agent: "helper", kind: "fact", key: "projects/course-a#next_stepX", outcome: "committed", checks: [] });
  w({ at: "2026-10-03T10:00:00Z", agent: "steward", kind: "fact", key: "projects/course-a#next_step", outcome: "inbox", checks: [] });
  return root;
}

test("an agent sees the source and strength of a fact in its view, and no other agent's name", () => {
  const root = setup();
  const w = core.why(root, "helper", "projects/course-a#next_step");
  expect(w.current).toHaveLength(1);
  expect(w.current[0].value).toBe("Grade the midterm");
  expect(w.current[0].sources).toEqual([{ ref: "gmail:f000000000000003", kind: "gmail" }]);
  expect(w.current[0].strength).toBe("checked at its source");
  expect(w.current[0].by ?? "another assistant").toBe("another assistant");
  expect(JSON.stringify(w)).not.toContain("planner");
});

// Known gap G802: read through a cell, a fact carries no writer (agentRecord in src/view.ts drops
// `by`), so why never says "another assistant" and never tells the caller its own write is its own.
// Passes from the hub; must still fail in the cells lane until G802 is decided.
(LANE_CELLS ? test.failing : test)("why names the caller's own write as its own and another's as another assistant (G802 in the cells lane)", () => {
  const root = setup();
  expect(core.why(root, "helper", "projects/course-a#next_step").current[0].by).toBe("another assistant");
  expect(core.why(root, "planner", "projects/course-a#next_step").current[0].by).toBe("planner");
});

test("an agent never sees earlier values or anyone else's writes; its own writes are its own", () => {
  const root = setup();
  const w = core.why(root, "helper", "projects/course-a#next_step");
  expect(w.earlier).toBeUndefined();
  expect(JSON.stringify(w)).not.toContain("syllabus");
  // Only its own refused attempt: not planner's commit, steward's refusal or held write, nor another key.
  expect(w.events.map((e) => `${e.by} ${e.outcome} ${e.checks}`)).toEqual(["helper refused source"]);
  expect(whyText(w)).not.toContain("pii_warn");
  expect(core.why(root, "planner", "projects/course-a#next_step").events.map((e) => e.outcome)).toEqual(["committed"]);
});

test("a prototype name is no fact", () => {
  const root = setup();
  for (const a of ["constructor", "toString", "__proto__"]) {
    expect(() => core.why(root, "helper", `projects/course-a#${a}`)).toThrow("no fact");
    expect(() => core.ownerWhy(root, `projects/course-a#${a}`)).toThrow("no fact");
  }
});

test("a hidden fact, a hidden note and a missing one answer the same", () => {
  const root = setup();
  const err = (key: string) => { try { core.why(root, "helper", key); return "no error"; } catch (e) { return `${(e as core.CoreError).status} ${(e as Error).message.replace(key, "K")}`; } };
  const missing = err("projects/course-a#nothing");
  expect(missing).toBe("404 no fact K in your view");
  expect(err("projects/course-a#fee_owed")).toBe(missing); // private, above helper's level
  expect(err("money/main-bank#bank")).toBe(missing); // a note outside its slice
  expect(err("not a key")).toBe(missing);
  // The core agent with a private ceiling sees the private fact.
  expect(core.why(root, "steward", "projects/course-a#fee_owed").current[0].value).toBe("Owes Grandpa 900");
});

test("the owner sees everything: earlier values, every write and every writer", () => {
  const root = setup();
  const w = core.ownerWhy(root, "projects/course-a#next_step");
  expect(w.current[0].by).toBe("planner");
  expect(w.earlier?.map((r) => r.value)).toEqual(["Write the syllabus"]);
  expect(w.events.map((e) => `${e.by} ${e.outcome}`)).toEqual(["planner committed", "helper refused", "steward refused", "steward inbox"]);
  const t = whyText(w);
  expect(t).toContain("before: \"Write the syllabus\"");
  expect(t).toContain("helper: fact refused; checks: source");
});

test("a disputed fact says so; only the owner gets the dispute id", () => {
  const root = setup();
  const jane = join(root, "people/jane-roy.md");
  writeFileSync(jane, readFileSync(jane, "utf8").replace(
    /  role: \{[^\n]*\}\n/,
    "  role: { dispute: c-0007, candidates: [{ value: Course coordinator, as_of: 2026-09-01, sources: [\"gmail:f000000000000001\"], verification: verified-by-source, by: planner }, { value: Department chair, as_of: 2026-10-01, sources: [\"agent:helper\"], verification: self-reported, by: helper }] }\n",
  ));
  const a = core.why(root, "helper", "people/jane-roy#role");
  expect(a.disputed).toBe(true);
  expect(a.current.map((r) => r.value)).toEqual(["Course coordinator", "Department chair"]);
  expect(JSON.stringify(a)).not.toContain("c-0007");
  expect(core.ownerWhy(root, "people/jane-roy#role").disputed).toBe("c-0007");
});

test("the why tool and GET /v1/why serve the same, and the read is logged", async () => {
  const root = setup();
  const tok = issueToken(root, "helper");
  const call = (path: string, body?: unknown) => handle(root, new Request(`http://pb${path}`, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined, headers: { authorization: `Bearer ${tok}` } }));
  const r = await call(`/v1/why?key=${encodeURIComponent("projects/course-a#next_step")}`);
  expect(r.status).toBe(200);
  expect((await r.json()).current[0].sources[0].ref).toBe("gmail:f000000000000003");
  expect((await call(`/v1/why?key=${encodeURIComponent("projects/course-a#fee_owed")}`)).status).toBe(404);
  const m = await (await call("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "why", arguments: { key: "projects/course-a#next_step" } } })).json();
  const text = m.result.content[0].text as string;
  expect(text).toContain("gmail:f000000000000003");
  expect(text).toContain("checked at its source");
  expect(text).not.toContain("syllabus");
  const reads = readFileSync(join(root, "log/reads.jsonl"), "utf8");
  expect(reads).toContain('"op":"why"');
});

test("with cells on, the agent's answer comes from its cell", () => {
  const root = setup();
  useCells(true);
  const w = core.why(root, "helper", "projects/course-a#next_step");
  expect(w.current[0].value).toBe("Grade the midterm");
  expect(JSON.stringify(w)).not.toContain("planner");
  expect(JSON.stringify(w)).not.toContain("syllabus");
  expect(w.events.every((e) => e.by === "helper")).toBe(true);
  expect(() => core.why(root, "helper", "projects/course-a#fee_owed")).toThrow("no fact");
});

test("a value hidden elsewhere in the agent's view is withheld here too, as its read shows it", () => {
  const root = setup();
  const course = join(root, "projects/course-a.md");
  writeFileSync(course, readFileSync(course, "utf8").replace("value: Grade the midterm", "value: Ask Maple Trust Bank about the grant"));
  const read = core.readNote(root, "helper", "projects/course-a").facts.next_step as { value: string };
  const w = core.why(root, "helper", "projects/course-a#next_step");
  expect(read.value).toContain("[withheld]");
  expect(w.current[0].value).toBe(read.value);
  expect(JSON.stringify(w)).not.toContain("Maple");
});

test("pocketbrain why prints the owner's whole provenance", () => {
  const root = setup();
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src/cli.ts"), "why", "projects/course-a#next_step", "--brain", root]);
  const out = r.stdout.toString();
  expect(r.exitCode).toBe(0);
  expect(out).toContain("Write the syllabus");
  expect(out).toContain("helper: fact refused");
  const miss = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src/cli.ts"), "why", "projects/course-a#nothing", "--brain", root]);
  expect(miss.exitCode).toBe(1);
});

test("the dashboard shows the owner where a fact came from, linked from the note page", async () => {
  const root = setup();
  const H = "127.0.0.1:8788";
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0];
  const get = async (path: string, c = cookie) => { const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie: c } })); return { status: r.status, text: await r.text() }; };
  const note = await get("/note/projects/course-a");
  expect(note.text).toContain('href="/why/projects/course-a?fact=next_step"');
  const page = await get("/why/projects/course-a?fact=next_step");
  expect(page.status).toBe(200);
  expect(page.text).toContain("gmail:f000000000000003");
  expect(page.text).toContain("Checked at its source");
  expect(page.text).toContain("Write the syllabus");
  expect(page.text).toContain("refused");
  expect((await get("/why/projects/course-a?fact=nothing")).status).toBe(404);
  expect((await get("/why/projects/course-a?fact=next_step", "")).text).not.toContain("gmail:f000000000000003");
});

test("explain labels a why of a hidden fact or note as hidden, not missing", async () => {
  const root = setup();
  for (const k of ["projects/course-a#fee_owed", "money/main-bank#bank", "projects/course-a#nothing"]) { try { core.why(root, "helper", k); } catch { /* 404 */ } }
  const { explainAgent } = await import("../src/explain");
  const out = explainAgent(root, "helper").lines.join("\n");
  expect(out).toMatch(/asked for projects\/course-a#fee_owed: \*\*hidden from it\*\*/);
  expect(out).toMatch(/asked for money\/main-bank#bank: \*\*hidden from it\*\*/);
  expect(out).toContain("asked for projects/course-a#nothing: doesn't exist");
});
