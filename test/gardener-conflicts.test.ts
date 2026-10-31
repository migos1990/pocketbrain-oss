// SPDX-License-Identifier: AGPL-3.0-only
// Owner, 2026-10-25: "yes file everything, ask me only conflicts caught by the gardener". With
// auto_decide.file: all, a capture that contradicts a held value is filed as a conflict (with
// Undo), and that conflict waits off the deck for the Gardener's nightly pass: it shows once the
// Gardener suggested a side, once a pass looked at it and had nothing, or after 36 hours. Money,
// health and legal conflicts show the same day, behind Show it (docs/decision-deck.md) (G416).
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { git } from "../src/git";
import { runAuto, undoAuto, autoDecisions } from "../src/filing";
import { asked } from "./asked";
import { openItems } from "../src/textline/items";
import { gardenerDisputes, gardenerSuggest, listDisputes } from "../src/core";
import { overview } from "../src/dashboard/html";
import { loadState } from "../src/dashboard/data";
import { write } from "../src/write";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const event = (id: string, line: string) => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated: "2026-10-07T00:00:00Z", calendar: "primary" });
const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
const openDisputes = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute" && n.fm.status === "open");
const conflictCards = (root: string, now: Date) => asked(root, now).filter((c) => c.kind === "dispute");

// Course C holds `attr` from mail; the calendar then says something else (a different kind of
// source, so the old rule asked; the same day, so the write path can't call it newer).
async function contradicted(attr: string, held: string, said: string, sensitivity = "personal") {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: ${sensitivity}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  ${attr}: { value: "${held}", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07 }\n---\n`);
  writeFileSync(join(root, "c.json"), JSON.stringify([event("e1", `Course C (project) ${attr}: ${said}`)]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  await pullSource(root, "cal", { model });
  expect(inbox(root)).toHaveLength(1);
  return root;
}

test("a capture that contradicts a held value is filed as a conflict, which waits for the Gardener", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  const now = new Date();
  const done = runAuto(root, now);
  expect(done.map((d) => d.picked)).toEqual(["held it as a conflict"]);
  expect(done[0].why).toMatch(/Gardener/);
  expect(inbox(root)).toHaveLength(0);
  const [d] = openDisputes(root);
  expect(d.fm.fact_key).toBe("projects/course-c#next_step");
  expect((d.fm as unknown as { candidates: FactRecord[] }).candidates.map((c) => c.value)).toEqual(["Write the exam", "Book the exam room B-201"]);
  // Off the deck, the home page and the text channel until the Gardener has been by.
  expect(conflictCards(root, now)).toEqual([]);
  expect(openItems(root, now).filter((i) => i.kind === "dispute")).toEqual([]);
  // Nothing was replaced: the live value stays for every reader, the conflict beside it (G425).
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord;
  expect(f.value).toBe("Write the exam");
  expect(f.contested).toBe(String(d.fm.id).split("/")[1]);
});

test("the Gardener's suggestion brings the conflict to the owner, its pick leading", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  const now = new Date();
  runAuto(root, now);
  const id = String(openDisputes(root)[0].fm.id).split("/")[1];
  gardenerSuggest(root, "gardener", { id, choice: 2, sources: ["gcal:e1@e1"], why: "the calendar event is the later word on it" });
  const [card] = conflictCards(root, now);
  expect(card).toBeTruthy();
  expect([card.suggested, card.suggested_by]).toEqual([2, "gardener"]);
});

test("a Gardener pass that looked and had nothing brings it too; so do 36 hours", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  const now = new Date();
  runAuto(root, now);
  expect(conflictCards(root, new Date(now.getTime() + 35 * 3600_000))).toEqual([]);
  expect(conflictCards(root, new Date(now.getTime() + 37 * 3600_000))).toHaveLength(1);
  gardenerDisputes(root, "gardener");
  expect(conflictCards(root, now)).toHaveLength(1);
});

test("a legal or health conflict shows the same day, its values behind Show it", async () => {
  const root = await contradicted("next_step", "Write the exam", "Meet the lawyer about the custody hearing");
  const now = new Date();
  expect(runAuto(root, now).map((d) => d.picked)).toEqual(["held it as a conflict"]);
  const [card] = conflictCards(root, now);
  expect(card).toBeTruthy();
  expect(card.private).toBe(true);
  expect(JSON.stringify({ q: card.title, lines: card.options })).not.toMatch(/lawyer|custody|Write the exam/);
});

test("Undo takes the conflict back: the proposal returns and the note holds its one value", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  const now = new Date();
  const [row] = runAuto(root, now);
  undoAuto(root, row.key);
  // The hub took the side out on the owner's Undo; nobody chose the value left (G426).
  expect(git(root, ["log", "-1", "--format=%ae"]).trim()).toBe("hub@pocketbrain.local");
  expect(git(root, ["log", "-1", "--format=%B"])).toContain("Asked-by: owner");
  const packet = loadBrain(root).find((n) => n.fm.type === "dispute")!;
  expect((packet.fm as { resolution?: { by?: string } }).resolution?.by).not.toBe("owner");
  expect(openDisputes(root)).toEqual([]);
  expect(inbox(root)).toHaveLength(1);
  expect((loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord).value).toBe("Write the exam");
  expect(autoDecisions(root, 1, now)[0].undone).toBeTruthy();
});

test("a conflict an assistant opened is not held: only the ones filed from a capture wait", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  const { write } = await import("../src/write");
  const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "next_step", value: "Grade the essays", as_of: "2026-10-07", sources: ["gmail:f000000000000032"], verification: "self-reported" });
  expect(r.outcome).toBe("disputed");
  expect(conflictCards(root, new Date())).toHaveLength(1);
});

// Slice audit of G416.
test("the home page doesn't show a conflict that waits for the Gardener", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  runAuto(root, new Date());
  expect(overview(loadState(root), "x").body).not.toContain("B-201");
});

test("the resolver can't settle a conflict that waits for the Gardener", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  runAuto(root, new Date());
  expect(listDisputes(root, "steward").map((d) => d.fact_key)).not.toContain("projects/course-c#next_step");
  gardenerDisputes(root, "gardener");
  expect(listDisputes(root, "steward").map((d) => d.fact_key)).toContain("projects/course-c#next_step");
});

test("Undo works after the Gardener suggested a side, and after another value joined", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  const [row] = runAuto(root, new Date());
  const id = String(openDisputes(root)[0].fm.id).split("/")[1];
  gardenerSuggest(root, "gardener", { id, choice: 2, sources: ["gcal:e1@e1"], why: "the calendar event is the later word on it" });
  expect(undoAuto(root, row.key)).toMatch(/Undone/);
  expect(openDisputes(root)).toEqual([]);
  expect(inbox(root)).toHaveLength(1);
  expect((loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord).value).toBe("Write the exam");

  const r2 = await contradicted("next_step", "Write the exam", "Book the exam room B-201");
  const [row2] = runAuto(r2, new Date());
  expect(write(r2, { agent: "planner", id: "projects/course-c", attribute: "next_step", value: "Grade the essays", as_of: "2026-10-07", sources: ["gmail:f000000000000032"], verification: "self-reported" }).outcome).toBe("disputed");
  expect(undoAuto(r2, row2.key)).toMatch(/Undone/);
  const left = openDisputes(r2);
  expect(left.map((d) => (d.fm as unknown as { candidates: FactRecord[] }).candidates.map((c) => c.value))).toEqual([["Write the exam", "Grade the essays"]]);
  expect(inbox(r2)).toHaveLength(1);
});

test("a contested more or less precise date is a conflict too, never a silent replacement", () => {
  for (const [held, said] of [["2026-11", "2026-11-14"], ["2026-11-14", "2026-11"]]) {
    const root = makeBrain();
    writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  launch_date: { value: "${held}", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07 }\n---\n`);
    sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "course c");
    const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "launch_date", value: said, as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
    expect(r.outcome).toBe("disputed");
  }
});

test("a conflict on a private note asks the same day, behind Show it", async () => {
  const root = await contradicted("next_step", "Write the exam", "Book the exam room B-201", "private");
  runAuto(root, new Date());
  const [card] = conflictCards(root, new Date());
  expect(card?.private).toBe(true);
});
