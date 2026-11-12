// SPDX-License-Identifier: AGPL-3.0-only
// Owner's phone, 2026-11-12 (G799): "What is Course B's due?" asked the owner to pick between the
// date the owner had given (4 Dec) and a date a calendar event gave (13 Nov); the test runs on the fixture clock, 8 Oct. A page can hold many
// dates that each end on their day: two different dates from two different source items both hold.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { runAuto } from "../src/filing";
import { ownerConflicts } from "../src/core";
import { loadBrain, isList, type Fact, type FactRecord } from "../src/brain";

const NOW = new Date("2026-10-08T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const page = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-b")!;
const open = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute" && ["open", "escalated"].includes(String(n.fm.status)));
const liveValues = (f: Fact | undefined) => !f ? [] : isList(f) ? f.items.filter((i) => !i.valid_to && !i.retired).map((i) => String(i.value)).sort() : [String((f as FactRecord).value)];

// The calendar events and mails these tests cite, as the hub's own reads of them (a ref the hub
// never read says nothing about which item a date came from).
const READ = ["gcal:evt-final@3", "gcal:evt-final@4", "gcal:evt-report-one@1", "gcal:evt-report-one@2", "gmail:f000000000000071", "gmail:f000000000000072"];
const read = (root: string, ...refs: string[]) => { const { recordCheckedRefs } = require("../src/louis"); recordCheckedRefs(root, Object.fromEntries(refs.map((r) => [r, true]))); };
// A brain whose schema has a due date on projects, as a new brain's checks.yaml can.
function brain() {
  const root = makeBrain();
  const f = join(root, "rules", "checks.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace("      next_step: { merge: replace, shelf_life: 14d }\n", "      next_step: { merge: replace, shelf_life: 14d }\n      due: { merge: replace, normalize: date }\n"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "due on projects");
  read(root, ...READ);
  return root;
}
// The owner's own word on the due date, as a yes on a calendar event's proposal leaves it: the event and the owner's ref.
function ownerDue(root: string, value: string, as_of: string, ref = "gcal:evt-final@3") {
  const r = write(root, { agent: "owner", id: "projects/course-b", attribute: "due", value, as_of, sources: [ref, `owner:${as_of}/say`], verification: "confirmed-by-owner" } as never, { owner: true } as never);
  if (r.outcome !== "committed") console.log(JSON.stringify(r));
  expect(r.outcome).toBe("committed");
}
// A calendar event the hub pulled, waiting for the filing tick as a capture's proposal.
function pulledEvent(root: string, value: string, as_of: string, ref: string, n: string) {
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", `e${n}.md`), `An event on ${value}\n`);
  writeFileSync(join(root, "inbox", `${as_of}-capture-e${n}.yaml`), YAML.stringify({ proposed: as_of, by: "steward", reason: `capture inbox/captures/e${n}.md: a new value`, checks: ["capture"], capture: `inbox/captures/e${n}.md`, request: { agent: "steward", kind: "fact", id: "projects/course-b", attribute: "due", value, as_of, sources: [ref], verification: "self-reported" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "capture: stored");
}

test("G799: a calendar event's date beside the owner's due date is another date, never a conflict", () => {
  const root = brain();
  ownerDue(root, "2026-12-04", "2026-09-20");
  pulledEvent(root, "2026-10-16", "2026-10-06", "gcal:evt-report-one@1", "1");
  runAuto(root, NOW);
  expect(open(root)).toHaveLength(0);
  expect(ownerConflicts(root, NOW)).toHaveLength(0);
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-10-16", "2026-12-04"]);
});

test("G799: an assistant reading another event writes its date beside the owner's, never a conflict", () => {
  const root = brain();
  ownerDue(root, "2026-12-04", "2026-09-20");
  const r = write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-10-16", as_of: "2026-10-06", sources: ["gcal:evt-report-one@1"], verification: "self-reported" } as never);
  expect(r.outcome).toBe("committed");
  expect(open(root)).toHaveLength(0);
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-10-16", "2026-12-04"]);
});

test("G799: the same calendar event giving another day is its date moving, never a second date", () => {
  const root = brain();
  ownerDue(root, "2026-12-04", "2026-09-20");
  expect(write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-10-16", as_of: "2026-10-05", sources: ["gcal:evt-report-one@1"], verification: "self-reported" } as never).outcome).toBe("committed");
  // The report's event moves to the 20th: one report, one date.
  expect(write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-10-20", as_of: "2026-10-06", sources: ["gcal:evt-report-one@2"], verification: "self-reported" } as never).outcome).toBe("committed");
  expect(open(root)).toHaveLength(0);
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-10-20", "2026-12-04"]);
  // The event the owner's date came from moving still asks: the owner's word comes first.
  expect(write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-12-11", as_of: "2026-10-07", sources: ["gcal:evt-final@4"], verification: "self-reported" } as never).outcome).toBe("disputed");
});

test("G799: what still asks: a side citing no item, the same day, and a money page", () => {
  const root = brain();
  // The owner's typed date, no item behind it: nothing says the calendar's day is another thing.
  write(root, { agent: "owner", id: "projects/course-b", attribute: "due", value: "2026-12-04", as_of: "2026-09-20", sources: ["owner:2026-09-20/say"], verification: "confirmed-by-owner" } as never, { owner: true } as never);
  expect(write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-10-16", as_of: "2026-10-06", sources: ["gcal:evt-report-one@1"], verification: "self-reported" } as never).outcome).toBe("disputed");
  // A bill's due date from two mails is money: it asks the same day (invariant 6).
  const m = brain();
  const f = join(m, "rules", "checks.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace("  money:\n", "  money:\n    attributes:\n      due: { merge: replace, normalize: date }\n"));
  sh(m, "add", "-A"); sh(m, "commit", "-qm", "due on money");
  const bill = loadBrain(m).find((n) => n.fm.type === "money")!;
  write(m, { agent: "owner", id: bill.fm.id, attribute: "due", value: "2026-10-20", as_of: "2026-09-20", sources: ["gmail:f000000000000071", "owner:2026-09-20/say"], verification: "confirmed-by-owner" } as never, { owner: true } as never);
  expect(write(m, { agent: "planner", id: bill.fm.id, attribute: "due", value: "2026-10-25", as_of: "2026-10-06", sources: ["gmail:f000000000000072"], verification: "self-reported" } as never).outcome).not.toBe("committed");
});

test("G799: both dates show in the week, and an ask that is left says when it is due", () => {
  const { weekOf } = require("../src/week");
  const { loadRules } = require("../src/rules");
  const { question } = require("../src/dashboard/html-settle");
  const root = brain();
  ownerDue(root, "2026-10-12", "2026-09-20");
  write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-10-09", as_of: "2026-10-06", sources: ["gcal:evt-report-one@1"], verification: "self-reported" } as never);
  const n = page(root);
  const w = weekOf([{ id: n.fm.id, title: String(n.fm.title), type: n.fm.type, status: n.fm.status, facts: Object.entries(n.fm.facts ?? {}) }], loadRules(root), [], "2026-10-08", () => undefined);
  expect(w.days.flatMap((d: { lines: { kind: string; day: string }[] }) => d.lines.filter((l) => l.kind === "due").map((l) => l.day))).toEqual(["2026-10-09", "2026-10-12"]);
  expect(question({ page: "projects/course-b", title: "Course B", attr: "due" } as never)).toBe("When is Course B due?");
  // The page's Changed line says the day it added as the thing being due, never "Course B's due".
  const { pageLines } = require("../src/dashboard/home");
  expect(pageLines(root, loadRules(root), loadBrain(root), "projects/course-b").map((l: { what: string }) => l.what)).toContain("Course B is also due 9 Oct 2026.");
});

// A conflict as the write path left it before G799: the owner's date live, the event's date in a
// packet beside it, asking on the home.
function oldConflict(root: string) {
  const owner = { value: "2026-12-04", as_of: "2026-09-20", sources: ["gcal:evt-final@3", "owner:2026-09-20/say"], verification: "confirmed-by-owner", by: "owner", recorded: "2026-09-20" };
  const event = { value: "2026-10-16", as_of: "2026-10-06", sources: ["gcal:evt-report-one@1"], verification: "self-reported", by: "planner", recorded: "2026-10-06" };
  const f = join(root, "projects", "course-b.md");
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-b")!;
  const { saveNote } = require("../src/brain");
  (n.fm.facts ??= {}).due = { ...owner, contested: "c-0001" } as never;
  saveNote(root, n);
  mkdirSync(join(root, "disputes"), { recursive: true });
  writeFileSync(join(root, "disputes", "c-0001.md"), `---\n${YAML.stringify({ id: "disputes/c-0001", type: "dispute", title: "projects/course-b#due", area: "work", sensitivity: "personal", status: "open", created: "2026-10-06", updated: "2026-10-06", by: "write-path", fact_key: "projects/course-b#due", step: 6, candidates: [owner, event] })}---\nConflict.\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "an old conflict");
  void f;
}

test("G800: the night pass closes an old conflict on two dates from two items as both kept, with Undo", () => {
  const { upkeep } = require("../src/upkeep");
  const { readDiary } = require("../src/diary");
  const { undoFact } = require("../src/undo");
  const root = brain();
  oldConflict(root);
  expect(ownerConflicts(root, NOW)).toHaveLength(1);
  const r = upkeep(root, { now: "2026-10-08" });
  expect(r.findings.filter((x: { rule: string }) => x.rule === "both-dates-closed").map((x: { key: string }) => x.key)).toEqual(["projects/course-b#due"]);
  expect(open(root)).toHaveLength(0);
  expect(ownerConflicts(root, NOW)).toHaveLength(0);
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-10-16", "2026-12-04"]);
  expect(JSON.stringify(page(root).fm.facts!.due)).not.toContain("contested");
  // The date that was waiting has a diary line; its Undo takes that date back out, the owner's stays.
  const row = readDiary(root).find((x: { why?: string }) => x.why === "both-dates")!;
  expect(row.to).toBe("2026-10-16");
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-12-04"]);
});

test("G800: with both_dates off the night pass only counts them", () => {
  const { upkeep } = require("../src/upkeep");
  const { setBothDates } = require("../src/ownerset");
  const root = brain();
  oldConflict(root);
  setBothDates(root, "off");
  const r = upkeep(root, { now: "2026-10-08" });
  expect(r.findings.some((x: { rule: string }) => x.rule === "both-dates-would-close")).toBe(true);
  expect(open(root)).toHaveLength(1);
});

test("G800: an old conflict a third date joined since still closes on the night pass (slice audit F4)", () => {
  const { upkeep } = require("../src/upkeep");
  const root = brain();
  read(root, "gcal:evt-third@1");
  oldConflict(root);
  expect(write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-11-20", as_of: "2026-10-07", sources: ["gcal:evt-third@1"], verification: "self-reported" } as never).outcome).toBe("committed");
  expect(ownerConflicts(root, NOW)).toHaveLength(1);
  upkeep(root, { now: "2026-10-08" });
  expect(open(root)).toHaveLength(0);
  expect(ownerConflicts(root, NOW)).toHaveLength(0);
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-10-16", "2026-11-20", "2026-12-04"]);
  expect(JSON.stringify(page(root).fm.facts!.due)).not.toContain("contested");
});

test("G799: the same event from a writer outside its areas, or a weaker word of it, never moves its date (slice audit F2)", () => {
  const root = brain();
  read(root, "gcal:evt-report-one@5");
  ownerDue(root, "2026-12-04", "2026-09-20");
  expect(write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-10-16", as_of: "2026-10-05", sources: ["gcal:evt-report-one@5"], verification: "verified-by-source" } as never).outcome).toBe("committed");
  // An assistant's later word, citing a version of the event the hub never read: it waits beside, never moves it.
  expect(write(root, { agent: "planner", id: "projects/course-b", attribute: "due", value: "2026-10-23", as_of: "2026-10-07", sources: ["gcal:evt-report-one@zzz"], verification: "self-reported" } as never).outcome).not.toBe("committed");
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-10-16", "2026-12-04"]);
  // It is one question on the home, and the owner's pick of the new day moves that item only.
  const { ownerDecide } = require("../src/core");
  const [c] = ownerConflicts(root, NOW);
  expect(c.attr).toBe("due");
  ownerDecide(root, c.id, "2026-10-23");
  expect(ownerConflicts(root, NOW)).toHaveLength(0);
  expect(liveValues(page(root).fm.facts!.due)).toEqual(["2026-10-23", "2026-12-04"]);
});
