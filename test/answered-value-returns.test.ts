// SPDX-License-Identifier: AGPL-3.0-only
// The owner's Home, 2026-11-16 (G951): he settled a conflict on a project's next step, keeping his
// own value; hours later capture proposed the losing value again from a mail of the same day, and
// the Home asked the same question again. "Older sources never re-ask" compared the source's day
// with the day of his value, never with the day he answered. A value the owner ended when he
// settled, said again by a source dated on or before that day, is what he already answered: it is
// kept as history and asks nothing. A source dated after his answer still asks.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto, autoDecisions, undoAuto } from "../src/filing";
import { loadState } from "../src/dashboard/data";
import { overview } from "../src/dashboard/html";
import { ownerConflicts, ownerDecide } from "../src/core";
import { inboxConflicts } from "../src/settle-inbox";
import { ownerAsks } from "../src/waiting";
import { write } from "../src/write";
import { asked } from "./asked";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const event = (id: string, line: string, updated: string) => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated, calendar: "primary" });
const NOW = new Date();
const TODAY = process.env.PB_TODAY ?? NOW.toISOString().slice(0, 10);

function brain() {
  const root = makeBrain({ steps: "one" });
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  const b = join(root, "projects", "course-b.md");
  writeFileSync(b, readFileSync(b, "utf8").replace("by: planner\n---", `by: planner\nfacts:\n  next_step: { value: Write the exam, as_of: 2026-10-01, sources: ["owner:2026-10-01/msg-1"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }\n---`));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course b");
  return root;
}
async function pull(root: string, items: unknown[]) {
  writeFileSync(join(root, "c.json"), JSON.stringify(items));
  return pullSource(root, "cal", { model });
}
const page = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-b")!;
const cards = (root: string) => asked(root, NOW).filter((c) => ["proposal", "dispute"].includes(c.kind));

async function answered() {
  const root = brain();
  await pull(root, [event("e1", "Course B (project) next_step: Grade the essays", "2026-10-07T00:00:00Z")]);
  runAuto(root, NOW);
  const open = ownerConflicts(root, NOW, { held: true });
  expect(open).toHaveLength(1);
  // He keeps his own value: side 1.
  ownerDecide(root, open[0]!.id, open[0]!.sides.find((s) => s.value === "Write the exam")!.n);
  expect(cards(root)).toEqual([]);
  return root;
}

test("a value the owner ended when settling, said again by a source of that day or before, asks nothing", async () => {
  const root = await answered();
  // Another mail of the same day says it again, as capture did hours after his answer.
  await pull(root, [event("e1", "Course B (project) next_step: Grade the essays", "2026-10-07T00:00:00Z"), event("e2", "Again, as agreed.\nCourse B (project) next_step: Grade the essays", "2026-10-07T06:00:00Z")]);
  runAuto(root, NOW);
  expect(cards(root)).toEqual([]);
  expect(inboxConflicts(root)).toEqual([]);
  expect(ownerConflicts(root, NOW, { held: true })).toEqual([]);
  expect(ownerAsks(root, NOW).total).toBe(0);
  const n = page(root);
  expect((n.fm.facts!.next_step as FactRecord).value).toBe("Write the exam");
  // Still once in history, never live.
  expect(((n.fm.history?.next_step ?? []) as FactRecord[]).filter((h) => h.value === "Grade the essays")).toHaveLength(1);
  // Dropped by the hub with a reason, not left waiting on Settings.
  expect(readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"))).toEqual([]);
});

test("a source dated after his answer saying it again still asks: the fact may have changed since", async () => {
  const root = await answered();
  // Two days on, a new mail says it.
  const later = new Date(new Date(`${TODAY}T12:00:00Z`).getTime() + 2 * 86_400_000);
  const was = { today: process.env.PB_TODAY, now: process.env.PB_NOW };
  process.env.PB_TODAY = later.toISOString().slice(0, 10); process.env.PB_NOW = later.toISOString();
  try {
    await pull(root, [event("e3", "Since Monday.\nCourse B (project) next_step: Grade the essays", later.toISOString())]);
    runAuto(root, later);
    expect(asked(root, later).filter((c) => ["proposal", "dispute"].includes(c.kind)).length + inboxConflicts(root).length).toBeGreaterThan(0);
  } finally {
    if (was.today === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = was.today;
    if (was.now === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was.now;
  }
});

test("the same writer's own write of that value is kept as history with history's usual reply", async () => {
  const root = await answered();
  const by = ((page(root).fm.history?.next_step ?? []) as FactRecord[])[0]!.by;
  const r = write(root, { agent: by, id: "projects/course-b", attribute: "next_step", value: "Grade the essays", as_of: "2026-10-07", sources: ["gcal:e9@e9"] } as never, { acceptedBy: "auto-decide", contest: true });
  expect([r.outcome, r.message]).toEqual(["committed", "kept as history"]);
  expect(ownerConflicts(root, NOW, { held: true })).toEqual([]);
  expect((page(root).fm.facts!.next_step as FactRecord).value).toBe("Write the exam");
});

test("another writer saying it is not what he answered: it asks as before", async () => {
  const root = await answered();
  const by = ((page(root).fm.history?.next_step ?? []) as FactRecord[])[0]!.by;
  const other = by === "planner" ? "helper" : "planner";
  const r = write(root, { agent: other, id: "projects/course-b", attribute: "next_step", value: "Grade the essays", as_of: "2026-10-07", sources: ["gcal:e9@e9"] } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.message).not.toBe("kept as history");
});

// Slice audit of 06ed30a (G953): the hub's drop must never tell a writer about a fact it can't see,
// and must never drop the owner's own later word.
const inboxFiles = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"));

test("a repeat aimed at a fact the writer can no longer see waits like any other write there, never dropped (G953, invariant 3)", async () => {
  const root = await answered();
  const by = ((page(root).fm.history?.next_step ?? []) as FactRecord[])[0]!.by;
  // The owner makes the fact secret after answering.
  const p = join(root, "projects", "course-b.md");
  writeFileSync(p, readFileSync(p, "utf8").replace(/(next_step:\s*\n?\s*)(value: Write the exam)/, "$1sensitivity: secret\n    $2"));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: secret");
  expect((page(root).fm.facts!.next_step as FactRecord).sensitivity).toBe("secret");
  const hit = write(root, { agent: by, id: "projects/course-b", attribute: "next_step", value: "Grade the essays", as_of: "2026-10-07", sources: ["gcal:e9@e9"] } as never);
  const miss = write(root, { agent: by, id: "projects/course-b", attribute: "next_step", value: "Book the hall", as_of: "2026-10-07", sources: ["gcal:e8@e8"] } as never);
  expect([hit.outcome, hit.message]).toEqual([miss.outcome, miss.message]);
  expect(hit.outcome).toBe("inbox");
  runAuto(root, NOW);
  // Both still wait: a hit that left while the miss waited would answer the guess one tick later.
  expect(inboxFiles(root)).toHaveLength(2);
});

test("the owner's own later word for the value they ended, relayed by the same assistant, is never dropped (G953)", async () => {
  const root = await answered();
  const by = ((page(root).fm.history?.next_step ?? []) as FactRecord[])[0]!.by;
  const day = process.env.PB_TODAY!;
  const r = write(root, { agent: by, id: "projects/course-b", attribute: "next_step", value: "Grade the essays", as_of: day, sources: [`owner:${day}/msg-77`] } as never);
  expect(r.outcome).toBe("inbox");
  runAuto(root, NOW);
  expect(inboxFiles(root)).toHaveLength(1);
});

// Read on the live hub, 2026-11-16: the drop showed on no owner-app screen, so where it shows and
// that its Undo works is pinned here. It is one of the hub's own decisions: Settings lists it under
// "Filed for you this week" with Undo, and Undo puts the question back for good.
test("the drop is listed on Settings with its reason and Undo, and Undo brings the question back", async () => {
  const root = await answered();
  await pull(root, [event("e1", "Course B (project) next_step: Grade the essays", "2026-10-07T00:00:00Z"), event("e2", "Again, as agreed.\nCourse B (project) next_step: Grade the essays", "2026-10-07T06:00:00Z")]);
  runAuto(root, NOW);
  const row = autoDecisions(root, 7, NOW).find((r) => r.picked === "kept your word")!;
  expect(row.why).toContain("you already answered this one");
  const body = overview(loadState(root), "c").body;
  expect(body).toContain("Filed for you this week");
  expect(body).toContain("you already answered this one");
  expect(body).toContain(`name="key" value="${row.key}"`);
  expect(undoAuto(root, row.key)).toBe("Undone. It waits for you now.");
  runAuto(root, NOW); // the hub never decides it again
  expect(inboxConflicts(root)).toHaveLength(1);
  expect(ownerAsks(root, NOW).total).toBe(1);
});
