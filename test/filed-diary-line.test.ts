// SPDX-License-Identifier: AGPL-3.0-only
// 6e15f795 live, 2026-10-30: the filing tick filed two assistant proposals whose value the page
// already held. One added nothing new, the other only merged its source; neither left a diary
// line, so the owner's home never showed that the hub had filed anything. Every filing by the hub
// leaves one line: "confirmed by another email" (Undo takes the added source back out), or "said
// again; nothing new" when there was nothing to add. The self-check counts any filing with no line.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { runAuto } from "../src/filing";
import { write } from "../src/write";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";

const AFTER = new Date("2026-10-30T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain(): string {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "owner: setup");
  return root;
}
const step = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;
// Course A's next step is "Grade the midterm" (gmail:f000000000000003); an assistant proposes it
// again, asking to move the page, so it waits in the inbox for the tick.
const propose = (root: string, ref: string) => expect(write(root, { agent: "planner", type: "project", title: "Course A", attribute: "next_step", value: "Grade the midterm", as_of: "2026-10-07", sources: [ref], area: "personal" } as never).outcome).toBe("inbox");

test("a filing that only adds a source leaves one line, and its Undo takes the source back out", () => {
  const root = brain();
  propose(root, "gmail:f000000000000041");
  const before = readDiary(root).length;
  expect(runAuto(root, AFTER).map((d) => d.picked)).toEqual(["saved it"]);
  const rows = readDiary(root).slice(before);
  expect(rows.map((r) => r.kind)).toEqual(["confirmed"]);
  expect(rows[0]!.added).toEqual(["gmail:f000000000000041"]);
  expect(step(root).sources.map(String)).toContain("gmail:f000000000000041");
  expect(undoFact(root, rows[0]!.undo_token).outcome).toBe("undone");
  expect(step(root).sources.map(String)).not.toContain("gmail:f000000000000041");
  expect(step(root).value).toBe("Grade the midterm");
});

test("a filing with nothing new to add still leaves one line, with nothing to undo", () => {
  const root = brain();
  propose(root, "gmail:f000000000000003");
  const before = readDiary(root).length;
  expect(runAuto(root, AFTER).map((d) => d.picked)).toEqual(["saved it"]);
  const rows = readDiary(root).slice(before);
  expect(rows.map((r) => r.kind)).toEqual(["confirmed"]);
  expect(rows[0]!.added ?? []).toEqual([]);
});

test("a filing the write found already recorded, word for word, leaves its line too", () => {
  const root = brain();
  expect(write(root, { agent: "planner", type: "project", title: "Course A", attribute: "next_step", value: "Grade the midterm", as_of: "2026-10-01", sources: ["gmail:f000000000000003"], area: "personal" } as never).outcome).toBe("inbox");
  const before = readDiary(root).length;
  expect(runAuto(root, AFTER).map((d) => d.picked)).toEqual(["saved it"]);
  const rows = readDiary(root).slice(before);
  expect(rows.map((r) => [r.kind, r.fact_key])).toEqual([["confirmed", "projects/course-a#next_step"]]);
});

test("the home says it in words", async () => {
  const { homeView } = await import("../src/dashboard/home");
  const { loadRules } = await import("../src/rules");
  const root = brain();
  propose(root, "gmail:f000000000000041");
  runAuto(root, AFTER);
  const v = homeView(root, loadRules(root), loadBrain(root), AFTER);
  const lines = [...v.since, ...v.earlier.flatMap((d) => d.lines)];
  expect(lines.map((l) => l.what)).toContain("Another email confirms Course A's next thing to do");
});

test("the self-check counts a hub filing that left no diary line", async () => {
  const { filedWithoutLine } = await import("../src/diary");
  const root = brain();
  propose(root, "gmail:f000000000000041");
  runAuto(root, AFTER);
  expect(filedWithoutLine(root, AFTER)).toEqual([]);
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(root, "log", "auto-decisions.jsonl"), JSON.stringify({ key: "proposal:x.yaml", picked: "saved it", at: AFTER.toISOString(), commit: "abc" }) + "\n");
  expect(filedWithoutLine(root, AFTER)).toEqual(["proposal:x.yaml"]);
});
