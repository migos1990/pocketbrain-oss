// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto, undoAuto, autoDecisions, autoSaves, verdict, AUTO } from "../src/filing";
import { asked } from "./asked";
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
import { setFileAll } from "../src/ownerset";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
type Cand = { entity: string; type: string; attribute: string; value: string; quote: string };
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
// The fake model states each line of the item that reads "<Entity> (<type>) <attribute>: <value>".
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]): Cand => ({ entity, type, attribute, value, quote: line })) }) });
const event = (id: string, line: string, updated = "2026-10-07T00:00:00Z") => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated, calendar: "primary" });
const mail = (id: string, line: string, from?: string) => ({ id, labelIds: ["Label_school"], internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: "Update" }, ...(from ? [{ name: "From", value: from }] : [])] }, text: line });

const ON = "health: { url: null }\nauto_decide: { file: all }\n";
function brain(escalation = ON, srcs: Record<string, unknown> = {}) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), escalation);
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


// Owner, 2026-10-25: "facts to be approved should be when there's conflict". With
// auto_decide.file: all, every fact a capture or a source pull proposed files itself on the hub's
// tick, about a person, on a new page or private alike, with Undo; only a different value for one
// the brain holds (a conflict), a value the owner confirmed, or a retirement waits for him.
test("file: all files person facts, new pages and private ones, no daily cap; nothing is asked", async () => {
  const root = brain(ON, { priv: { kind: "gcal", fixture: "p.json", min_sensitivity: "private" } });
  await pull(root, "mail", "m.json", [mail("a1b2c3d4e5f60718", "Jane Roy (person) phones: +1 514 555 0177\nSam Cote (person) role: Teaching assistant")]);
  await pull(root, "priv", "p.json", [event("e4", "Course E (project) next_step: Meet the dean about the plan")]);
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201"), event("e2", "Course D (project) next_step: Send the syllabus to the TA")]);
  expect(inbox(root).length).toBe(5);
  expect(asked(root, NOW).filter((c) => c.kind === "proposal")).toEqual([]);
  const done = runAuto(root, NOW);
  expect(done).toHaveLength(5);
  expect(inbox(root)).toHaveLength(0);
  expect(JSON.stringify(fact(root, "people/jane-roy", "phones"))).toMatch(/5145550177/);
  expect(fact(root, "people/sam-cote", "role")!.value).toBe("Teaching assistant");
  // A private source's fact lands at its private tier; the "Decided for you" line never shows its value.
  const e = noteOf(root, "projects/course-e")!;
  expect(JSON.stringify([e.fm.sensitivity, (e.fm.facts?.next_step as FactRecord)?.sensitivity])).toMatch(/private/);
  const row = done.find((d) => /private/.test(d.question))!;
  expect(row.question).not.toMatch(/dean/i);
  expect(autoDecisions(root, 1, NOW).map((r) => r.question).join("\n")).not.toMatch(/Meet the dean/);
});

test("file: all still asks a conflict: a different value for a fact the brain holds, or one the owner confirmed", async () => {
  const root = brain();
  const b = join(root, "projects", "course-b.md");
  writeFileSync(b, readFileSync(b, "utf8").replace("by: planner\n---", "by: planner\nfacts:\n  next_step: { value: Write the exam, as_of: 2026-10-01, sources: [\"owner:2026-10-01/msg-1\"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }\n---"));
  sh(root, "git", "commit", "-qam", "owner: course b");
  await pull(root, "cal", "c.json", [event("e1", "Jane Roy (person) role: Dean of studies\nCourse B (project) next_step: Grade the essays")]);
  // Jane Roy's role is "Course coordinator" from her mail: a different role from the calendar is a
  // conflict (a newer one from mail would be an update), filed as one for the Gardener (G416).
  // A newer value than one the owner confirmed is a conflict too, asked at once, never held for the
  // Gardener (audit v4: the write path weighs the owner's word, so an older one asks nothing).
  expect(runAuto(root, NOW).map((d) => d.picked)).toEqual(["held it as a conflict", "held it as a conflict"]);
  const cards = asked(root, NOW);
  expect(cards.filter((c) => c.kind === "proposal")).toHaveLength(0);
  // The owner's one asks today; the role conflict waits for the Gardener's night pass first.
  expect(cards.filter((c) => c.kind === "dispute")).toHaveLength(1);
  expect(JSON.stringify(loadBrain(root).find((n) => n.fm.id === "projects/course-b")!.fm.facts!.next_step)).toContain("contested");
  // Adding to a set (another phone) is no conflict: it files.
  await pull(root, "mail", "m.json", [mail("a1b2c3d4e5f60719", "Jane Roy (person) phones: +1 514 555 0199")]);
  expect(runAuto(root, NOW)).toHaveLength(1);
});

test("with file: ask nothing changes: a person's fact still waits", async () => {
  const root = brain("health: { url: null }\nauto_decide: { file: ask, source_saves_per_day: 20 }\n");
  await pull(root, "mail", "m.json", [mail("a1b2c3d4e5f60718", "Sam Cote (person) role: Teaching assistant")]);
  expect(runAuto(root, NOW)).toEqual([]);
  expect(loadEscalation(root).auto_decide.file).toBeUndefined();
});

test("`pocketbrain deck file-all on|off` sets auto_decide.file as the owner, keeping the other keys", () => {
  const root = brain("health: { url: null }\nauto_decide: { source_saves_per_day: 20 }\n");
  expect(setFileAll(root, "on")).toMatch(/file all/);
  expect(loadEscalation(root).auto_decide).toMatchObject({ file: "all", source_saves_per_day: 20 });
  expect(git(root, ["log", "-1", "--format=%s"])).toMatch(/^owner: file all on/);
  setFileAll(root, "off");
  expect(loadEscalation(root).auto_decide.file).toBeUndefined();
  expect(() => setFileAll(root, "maybe")).toThrow();
});

test("file: all files what the owner said through their channel too, as their word", async () => {
  const root = brain();
  const { capture } = await import("../src/capture");
  await capture(root, { text: "Course F (project) next_step: Order the lab kits", kind: "text" }, model, { agent: "steward", via: "agent" });
  expect(inbox(root)).toHaveLength(1);
  expect(runAuto(root, NOW)).toHaveLength(1);
  const f = fact(root, "projects/course-f", "next_step")!;
  expect(f.value).toBe("Order the lab kits");
  expect(JSON.stringify(f.sources)).toMatch(/owner:/);
});

test("a fact whose subject the model guessed files too, marked inferred, so the trust check lists it as guessed", async () => {
  const root = brain();
  const guess = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [{ entity: "Course G", type: "project", attribute: "next_step", value: "Book the exam room B-201", quote: "Book the exam room B-201" }] }) });
  writeFileSync(join(root, "c.json"), JSON.stringify([event("e9", "Reminder: Book the exam room B-201")]));
  await pullSource(root, "cal", { model: guess });
  expect(runAuto(root, NOW)).toHaveLength(1);
  expect(fact(root, "projects/course-g", "next_step")!.confidence).toBe("inferred");
});

// Slice audit 2026-10-25 (4597a941).
test("file: all files a money fact at the money tier, with no value in the decided list", async () => {
  const root = brain();
  const ck = join(root, "rules", "checks.yaml");
  writeFileSync(ck, readFileSync(ck, "utf8").replace("  money:\n    sensitivity: private", "  money:\n    sensitivity: private\n    attributes:\n      balance: { merge: replace }"));
  // From someone the owner knows: a mail with no From is an unknown sender, whose money fact waits.
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.facts = { ...(jane.fm.facts ?? {}), email: { value: "jane@example.org", as_of: "2026-10-01", sources: ["owner:2026-10-01/inbox/x"], verification: "confirmed-by-owner", by: "owner", recorded: "2026-10-01" } as never };
  saveNote(root, jane);
  sh(root, "git", "commit", "-qam", "owner: money attributes");
  await pull(root, "mail", "m.json", [mail("a1b2c3d4e5f60720", "Joint account (money) balance: $4,210.55", "Jane Roy <jane@example.org>")]);
  expect(inbox(root)).toHaveLength(1);
  expect(runAuto(root, NOW)).toHaveLength(1);
  const n = noteOf(root, "money/joint-account")!;
  expect(JSON.stringify([n.fm.sensitivity, (n.fm.facts?.balance as FactRecord)?.sensitivity])).toMatch(/private|secret/);
  expect(autoDecisions(root, 1, NOW).map((r) => r.question).join("\n")).not.toContain("4,210.55");
});

test("file: all: a new-page fact whose title now matches a note with a different value is a conflict, not a silent overwrite", async () => {
  const root = brain();
  await pull(root, "cal", "c.json", [event("e1", "Course C (project) next_step: Book the exam room B-201")]);
  // The note appears (another write) before the hub's tick, with its own next step.
  writeFileSync(join(root, "projects", "course-c.md"), "---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: Write the exam, as_of: 2026-10-01, sources: [\"gmail:f000000000000031\"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }\n---\n");
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "course c");
  expect(runAuto(root, NOW).map((d) => d.picked)).toEqual(["held it as a conflict"]);
  // The live value stays; both sides wait in the conflict beside it (G425).
  expect((fact(root, "projects/course-c", "next_step") as unknown as FactRecord).value).toBe("Write the exam");
  expect((loadBrain(root).find((n) => n.fm.type === "dispute")!.fm.candidates as FactRecord[]).map((c) => c.value)).toEqual(["Write the exam", "Book the exam room B-201"]);
});

test("file: all files only the owner's channel and the source pulls: another agent's captures keep their own rule", async () => {
  const root = brain();
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8") + "capture: { agents: [steward, planner] }\n");
  sh(root, "git", "commit", "-qam", "owner: capture agents");
  const { capture } = await import("../src/capture");
  await capture(root, { text: "Course H (project) next_step: Order the lab kits", kind: "text" }, model, { agent: "planner", via: "agent" });
  expect(inbox(root)).toHaveLength(1);
  expect(runAuto(root, NOW)).toEqual([]);
});
