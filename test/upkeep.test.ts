// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { upkeep, undoRun, fileLiveSource } from "../src/upkeep";
import { loadBrain, type FactRecord } from "../src/brain";

const note = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!;
const commit = (root: string) => Bun.spawnSync(["git", "commit", "-qam", "setup"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });

function brokenBrain() {
  const root = makeBrain();
  const p = join(root, "projects/course-b.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("created: 2026-10-01", "created: 2026-9-5") + "\nWith [[people/jane]] and [[people/nobody-here]].\n");
  commit(root);
  return root;
}

test("fixes links and dates by itself, each as a reflect commit", () => {
  const root = brokenBrain();
  const r = upkeep(root, { now: "2026-10-08" });
  const b = note(root, "projects/course-b");
  expect(b.body).toContain("[[people/jane-roy]]");
  expect(b.fm.created).toBe("2026-09-05");
  expect(r.findings.find((f) => f.rule === "broken-link")?.detail).toContain("people/nobody-here");
  const log = Bun.spawnSync(["git", "log", "--format=%an %s"], { cwd: root }).stdout.toString();
  expect(log).toContain("reflect reflect: repoint links in projects/course-b");
  expect(log).toContain("reflect reflect: normalize dates in projects/course-b");
});

test("freshness: an old next_step is listed as stale", () => {
  const root = makeBrain();
  const r = upkeep(root, { now: "2026-11-30" });
  expect(r.findings.find((f) => f.key === "projects/course-a#next_step")?.rule).toBe("freshness-stale");
});

test("a live recheck that agrees refreshes last_confirmed; one that disagrees opens a dispute, never overwrites", () => {
  const root = makeBrain();
  const live = join(root, "live.json");
  writeFileSync(live, JSON.stringify({
    "projects/course-a#next_step": { value: "Grade the midterm", ref: "gcal:evt1.abc" },
    "people/jane-roy#role": { value: "Program director", ref: "gmail:f000000000000006" },
  }));
  const r = upkeep(root, { live: [fileLiveSource(live)], now: "2026-10-08" });
  expect((note(root, "projects/course-a").fm.facts!.next_step as FactRecord).last_confirmed).toBe("2026-10-08");
  const role = note(root, "people/jane-roy").fm.facts!.role as unknown as { dispute: string; candidates: FactRecord[] };
  expect(role.dispute).toBe("c-0001");
  expect(role.candidates.map((c) => c.value)).toEqual(["Course coordinator", "Program director"]);
  expect(r.findings.find((f) => f.rule === "recheck-contradicts")?.kind).toBe("escalate");
  expect(existsSync(join(root, "disputes/c-0001.md"))).toBe(true);
});

test("journals older than 60 days move to the archive", () => {
  const root = makeBrain();
  mkdirSync(join(root, "journal/planner"), { recursive: true });
  writeFileSync(join(root, "journal/planner/2026-07.md"), "- 2026-07-02: x\n");
  writeFileSync(join(root, "journal/planner/2026-09.md"), "- 2026-09-02: y\n");
  upkeep(root, { now: "2026-10-08" });
  expect(existsSync(join(root, "archive/journal/planner/2026-07.md"))).toBe(true);
  expect(existsSync(join(root, "journal/planner/2026-09.md"))).toBe(true);
});

test("undo --run reverts the run's fixes and the next run doesn't redo them", () => {
  const root = brokenBrain();
  const r = upkeep(root, { now: "2026-10-08" });
  expect(undoRun(root, r.run)).toContain("reverted 2 commits");
  expect(note(root, "projects/course-b").fm.created).toBe("2026-9-5");
  expect(readFileSync(join(root, "rules/suppressions.yaml"), "utf8")).toContain("date-format");
  const again = upkeep(root, { now: "2026-10-08" });
  expect(again.findings.filter((f) => f.kind === "auto-fix")).toEqual([]);
  expect(note(root, "projects/course-b").fm.created).toBe("2026-9-5");
});

test("stored facts that today's checks would refuse lose the authority they claimed (G10)", () => {
  const root = makeBrain();
  const p = join(root, "people/paul-advisor.md");
  writeFileSync(p, readFileSync(p, "utf8").replace('sources: ["imsg:2026-09-01"], verification: self-reported', 'sources: ["instinct-mem:people/paul"], verification: confirmed-by-louis'));
  commit(root);
  const r = upkeep(root, { now: "2026-10-08" });
  const f = note(root, "people/paul-advisor").fm.facts!.role as FactRecord;
  expect(f.verification).toBe("self-reported");
  expect(f.note).toContain("claimed confirmed-by-louis");
  expect(r.findings.some((x) => x.rule === "stored-recheck")).toBe(true);
  expect(upkeep(root, { now: "2026-10-08" }).findings.some((x) => x.rule === "stored-recheck")).toBe(false);
});

test("two write-ups of the same meeting are a possible duplicate; same title on another day is not", () => {
  const root = makeBrain();
  mkdirSync(join(root, "notes"), { recursive: true });
  const meeting = (id: string, day: string) => writeFileSync(join(root, `notes/${id}.md`), [
    "---", `id: notes/${id}`, "type: note", "title: Team sync", "sensitivity: personal", "status: active",
    "created: 2026-10-01", "updated: 2026-10-01", "by: steward", "facts:",
    `  held_on: { value: "${day}", as_of: "${day}", sources: ["gmail:f000000000000003"], verification: verified-by-source, by: steward, recorded: "${day}" }`,
    "---", "Notes.", ""].join("\n"));
  meeting("sync-a", "2026-10-01"); meeting("sync-b", "2026-10-01"); meeting("sync-c", "2026-10-02");
  commit(root);
  const dups = upkeep(root, { now: "2026-10-08" }).findings.filter((f) => f.rule === "possible-duplicate");
  expect(dups.map((f) => f.key)).toEqual(["notes/sync-b"]);
  expect(dups[0].detail).toContain("notes/sync-a");
});
