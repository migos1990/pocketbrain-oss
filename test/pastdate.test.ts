// SPDX-License-Identifier: AGPL-3.0-only
// Past its date: a next step, due date or deadline whose day went by kept reading as current
// ("Grade the midterm by Oct 12" a week later). The golden set's stale flag (src/freshness.ts,
// passedDay) marks it stale and the nightly pass lists it as a review finding. Nothing asks the
// owner (only a conflict asks, outside review v5); the dashboard's Done, Still open and Forget
// actions never edit the value.
import { test, expect, afterEach } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadRules, attributeSpec } from "../src/rules";
import { factFreshness } from "../src/freshness";
import { runAction } from "../src/dashboard/actions";
import { upkeep } from "../src/upkeep";
import { loadBrain, type FactRecord } from "../src/brain";

afterEach(() => { process.env.PB_TODAY = "2026-10-08"; });
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const rec = (v: string, as_of = "2026-10-01", more = "") => `{ value: "${v}", as_of: ${as_of}, sources: ["gmail:f000000000000003"], verification: verified-by-source, by: planner, recorded: ${as_of}${more} }`;
function course(root: string, facts: Record<string, string>, slug = "course-c") {
  writeFileSync(join(root, "projects", `${slug}.md`), `---\nid: projects/${slug}\ntype: project\ntitle: ${slug === "course-c" ? "Course C" : slug}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-10-01\nby: planner\nfacts:\n${Object.entries(facts).map(([k, v]) => `  ${k}: ${v}`).join("\n")}\n---\nA course.\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: course c");
}
const fact = (root: string, attr: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts![attr] as FactRecord;

test("flagged: a next step, due date or deadline whose day went by and nobody confirmed since; not any fact that only names a day", () => {
  const root = makeBrain();
  course(root, {
    next_step: rec("Grade the midterm by Oct 12"),
    deadline: rec("Grades in by Oct 14"),
    due: rec("2026-10-15"),
    started: rec("Oct 2"),
    room: rec("B-310, booked Oct 3"),
  });
  course(root, { next_step: rec("Review session Oct 30") }, "course-d");
  course(root, { deadline: rec("Grades due Oct 10", "2026-10-01", ", last_confirmed: 2026-10-15") }, "course-e");
  course(root, { deadline: rec("Grades due Oct 9", "2026-10-01", ", valid_to: 2026-10-11") }, "course-f");
  process.env.PB_TODAY = "2026-10-20";
  // The nightly upkeep says it too, as a review finding the Gardener reads; a project's due date
  // is already said once as past-due.
  const keys = upkeep(root).findings.filter((f: { rule: string }) => f.rule === "past-date").map((f: { key: string }) => f.key).sort();
  expect(keys).toEqual(["projects/course-c#deadline", "projects/course-c#next_step"]);
});

test("each answer is the owner's word and never edits the value: done ends it, still open makes it current again, forget retires it", () => {
  const root = makeBrain();
  course(root, { deadline: rec("Grades in by Oct 14"), next_step: rec("Grade the midterm by Oct 7") });
  course(root, { deadline: rec("Quiz due Oct 9") }, "course-d");
  process.env.PB_TODAY = "2026-10-20";
  const fresh = (attr: string) => factFreshness(fact(root, attr), attributeSpec(loadRules(root), "project", attr), "2026-10-20");
  expect(fresh("next_step")).toBe("stale");
  runAction({ root }, "fact-done", { id: "projects/course-c", attribute: "deadline" });
  runAction({ root }, "fact-confirm", { id: "projects/course-c", attribute: "next_step" });
  expect(runAction({ root }, "fact-forget", { id: "projects/course-d", attribute: "deadline" })).toBe("Forgot Deadline on course-d.");
  expect(fact(root, "deadline")).toMatchObject({ value: "Grades in by Oct 14", valid_to: "2026-10-20" });
  expect(fact(root, "next_step")).toMatchObject({ value: "Grade the midterm by Oct 7", last_confirmed: "2026-10-20" });
  // "Still open" clears the golden set's stale flag too.
  expect(fresh("next_step")).not.toBe("stale");
  const quiz = loadBrain(root).find((n) => n.fm.id === "projects/course-d")!.fm.facts!.deadline as FactRecord;
  expect(quiz).toMatchObject({ value: "Quiz due Oct 9", retired: { at: "2026-10-20", by: "owner" } });
  // Forget is one owner commit, so the dashboard's Undo brings it back.
  const log = Bun.spawnSync(["git", "log", "-1", "--format=%s"], { cwd: root }).stdout.toString();
  expect(log).toStartWith("owner: forget projects/course-d#deadline");
  expect(upkeep(root).findings.filter((f: { rule: string }) => f.rule === "past-date")).toEqual([]);
});

