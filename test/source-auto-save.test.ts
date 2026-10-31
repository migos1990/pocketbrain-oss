// SPDX-License-Identifier: AGPL-3.0-only
// Sources keep the brain fresh without the owner (backlog 393, docs/decision-deck.md "Saved for
// you"): a low-risk fact a calendar or mail pull proposed is saved by the hub on its own tick, by
// auto-decide, never as the owner's word, up to a daily cap. Each one is a row in "Decided for
// you" with Undo, which takes the fact back out and returns the card for good. Anything about a
// person, money, health or legal, or a private tier, and any change to a value the owner
// confirmed or another kind of source gave, still waits for him. Fake model and fixtures only.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto, undoAuto, autoDecisions, autoSaves, verdict, AUTO } from "../src/filing";
import { asked, weigh } from "./asked";
import { openItems } from "../src/textline/items";
import { loadEscalation } from "../src/textline/policy";

// What the hub plans for the one proposal waiting. A save it plans isn't on the deck: the deck and
// the home page ask only what waits for the owner (owner, 2026-10-24).
function planned(root: string, now: Date) {
  const it = openItems(root, now).find((i) => i.kind === "proposal")!;
  const notes = loadBrain(root);
  expect(autoSaves(root, now).has(it.ref)).toBe(true);
  expect(asked(root, now).find((c) => c.key === it.key)).toBeUndefined();
  const v = verdict(root, it, loadEscalation(root), { notes }, now);
  return "plan" in v ? v.plan : undefined;
}
import { git } from "../src/git";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
type Cand = { entity: string; type: string; attribute: string; value: string; quote: string };
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
// The fake model states each line of the item that reads "<Entity> (<type>) <attribute>: <value>".
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]): Cand => ({ entity, type, attribute, value, quote: line })) }) });
const event = (id: string, line: string, updated = "2026-10-07T00:00:00Z") => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated, calendar: "primary" });
const mail = (id: string, line: string) => ({ id, labelIds: ["Label_school"], internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: "Update" }] }, text: line });

const ON = "health: { url: null }\nauto_decide: { source_saves_per_day: 20 }\n";
function brain(escalation = ON, srcs: Record<string, unknown> = {}) {
  const root = makeBrain();
  // The daily source saves are the `file: ask` mode since file: all became the default (G422).
  writeFileSync(join(root, "rules", "escalation.yaml"), /auto_decide:\s*\{/.test(escalation) ? escalation.replace(/auto_decide:\s*\{\s*/, "auto_decide: { file: ask, ") : `${escalation}auto_decide: { file: ask }\n`);
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" }, mail: { kind: "gmail", where: ["Label_school"], fixture: "m.json" }, ...srcs } }));
  writeFileSync(join(root, "c.json"), "[]"); writeFileSync(join(root, "m.json"), "[]");
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
  return root;
}
async function pull(root: string, source: string, file: string, items: unknown[]) {
  writeFileSync(join(root, file), JSON.stringify(items));
  return pullSource(root, source, { model });
}
const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
// A new note's id carries a short hash (projects/course-c-1a2b3c); found by its own id or its title.
const noteOf = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id || n.fm.id.startsWith(`${id}-`) && n.fm.type !== "dispute");
const fact = (root: string, id: string, attr: string) => noteOf(root, id)?.fm.facts?.[attr] as FactRecord | undefined;
const NOW = new Date();
// Why each proposal still waits, in the hub's fixed words (src/filing.ts verdict).
const waits = (root: string) => [...weigh(root, NOW)].filter(([k]) => k.startsWith("proposal:")).map(([, c]) => c.never_auto ?? "");

test("with file: ask, off until the owner turns it on: every calendar and mail fact waits, and the card says how to turn it on", async () => {
  const root = brain("health: { url: null }\n");
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201")]);
  expect(runAuto(root, NOW)).toEqual([]);
  expect(inbox(root)).toHaveLength(1);
  expect(waits(root)[0]).toMatch(/off until you turn it on \(auto_decide: \{ source_saves_per_day: 20 \}/);
});

test("a calendar fact about a project is saved on the hub's tick, by auto-decide, not as the owner's word", async () => {
  const root = brain();
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201")]);
  expect(inbox(root)).toHaveLength(1);
  expect(planned(root, NOW)?.why).toMatch(/calendar/);
  const done = runAuto(root, NOW);
  expect(done).toHaveLength(1);
  expect(done[0].picked).toBe("saved it");
  expect(inbox(root)).toHaveLength(0);
  const f = fact(root, "projects/course-c", "next_step")!;
  expect(f.value).toBe("Book the exam room B-201");
  expect(f.verification).not.toMatch(/owner/);
  expect(JSON.stringify(f.sources)).not.toMatch(/owner:|louis:/);
  // Both commits (the fact and the answered proposal) are the hub's, never the owner's; the page
  // text the tick writes after them (G462) is the page writer's.
  const authors = git(root, ["log", "--format=%ae", "--invert-grep", "--grep=^Kind: page-writer", "-2"]).split("\n");
  expect(authors).toEqual([`${AUTO}@pocketbrain.local`, `${AUTO}@pocketbrain.local`]);
});

test("a mail fact about a project is saved too", async () => {
  const root = brain();
  await pull(root, "mail", "m.json", [mail("a1b2c3d4e5f60718", "Course D (project) next_step: Send the syllabus to the TA")]);
  expect(runAuto(root, NOW)).toHaveLength(1);
  expect(fact(root, "projects/course-d", "next_step")!.value).toBe("Send the syllabus to the TA");
});

test("the calendar can update what the calendar said; a value another kind of source gave waits", async () => {
  const root = brain();
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201")]);
  runAuto(root, NOW);
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201"), event("e2", "Course C (project) next_step: Book the exam room C-310", "2026-10-08T00:00:00Z")]);
  // Course A's next step came from mail: the calendar can't replace it on its own.
  await pull(root, "cal", "c.json", [event("e3", "Course A (project) next_step: Book the exam room B-201")]);
  expect(inbox(root)).toHaveLength(2);
  const done = runAuto(root, NOW);
  expect(done).toHaveLength(1);
  expect(fact(root, "projects/course-c", "next_step")!.value).toBe("Book the exam room C-310");
  expect(fact(root, "projects/course-a", "next_step")!.value).toBe("Grade the midterm");
  expect(waits(root)[0]).toMatch(/another kind of source/);
});

test("Undo takes the saved fact back out, returns the card, and the hub never saves that one again", async () => {
  const root = brain();
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201")]);
  const [row] = runAuto(root, NOW);
  expect(fact(root, "projects/course-c", "next_step")!.value).toBe("Book the exam room B-201");
  expect(undoAuto(root, row.key)).toMatch(/Undone/);
  expect(noteOf(root, "projects/course-c")).toBeUndefined();
  expect(inbox(root)).toHaveLength(1);
  expect(runAuto(root, NOW)).toEqual([]);
  expect(waits(root)[0]).toMatch(/undid/);
  expect(autoDecisions(root, 1, NOW)[0].undone).toBe(true);
});

test("about a person, money, a private source, or a value the owner confirmed: it waits for the owner", async () => {
  const root = brain(ON, { priv: { kind: "gcal", fixture: "p.json", min_sensitivity: "private" } });
  // The owner confirmed Course B's next step; a calendar can't overrule that on its own.
  const b = join(root, "projects", "course-b.md");
  writeFileSync(b, readFileSync(b, "utf8").replace("by: planner\n---", "by: planner\nfacts:\n  next_step: { value: Write the exam, as_of: 2026-10-01, sources: [\"owner:2026-10-01/msg-1\"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }\n---"));
  sh(root, "git", "commit", "-qam", "owner: course b");
  await pull(root, "mail", "m.json", [mail("a1b2c3d4e5f60718", "Jane Roy (person) role: Dean of studies")]);
  await pull(root, "cal", "c.json", [event("e2", "Course A (project) next_step: Pay the lab fee of $40"), event("e3", "Course B (project) next_step: Grade the essays")]);
  await pull(root, "priv", "p.json", [event("e4", "Course A (project) next_step: Meet the dean about the plan")]);
  const waiting = inbox(root);
  expect(waiting.length).toBe(4);
  expect(runAuto(root, NOW)).toEqual([]);
  expect(inbox(root)).toEqual(waiting);
  const why = waits(root);
  expect(why.every(Boolean)).toBe(true);
  expect(why.join("\n")).toMatch(/person/);
  // Money reads as private on every card (src/textline/items.ts): the money fact and the private source.
  expect(why.filter((w) => /Private/.test(w))).toHaveLength(2);
  expect(why.join("\n")).toMatch(/you confirmed/);
});

test("a daily cap: past it, the rest wait for tomorrow; 0 turns saving off, and auto_decide off stops it too", async () => {
  const root = brain("health: { url: null }\nauto_decide: { source_saves_per_day: 1 }\n");
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201"), event("e2", "Course D (project) next_step: Send the syllabus to the TA")]);
  expect(inbox(root)).toHaveLength(2);
  expect(runAuto(root, NOW)).toHaveLength(1);
  expect(runAuto(root, NOW)).toEqual([]);
  expect(inbox(root)).toHaveLength(1);
  const plan = planned(root, NOW)!;
  expect(plan.why).toMatch(/1 a day/);
  expect(Date.parse(plan.at)).toBeGreaterThan(NOW.getTime());
  // Tomorrow, the next one goes.
  expect(runAuto(root, new Date(NOW.getTime() + 86_400_000))).toHaveLength(1);

  for (const policy of ["health: { url: null }\nauto_decide: { source_saves_per_day: 0 }\n", "health: { url: null }\nauto_decide: { off: true }\n"]) {
    const r = brain(policy);
    await pull(r, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201")]);
    expect(runAuto(r, NOW)).toEqual([]);
    expect(inbox(r)).toHaveLength(1);
  }
});

test("a new-note fact whose name now matches a private note waits: saving it would land on that note", async () => {
  const root = brain();
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201")]);
  writeFileSync(join(root, "projects", "course-c.md"), "---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n");
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  expect(runAuto(root, NOW)).toEqual([]);
  expect(waits(root)[0]).toMatch(/private/);
});
