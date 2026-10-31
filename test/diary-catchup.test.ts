// SPDX-License-Identifier: AGPL-3.0-only
// The Mac's use-it check (2026-10-26): /home said "Nothing new since yesterday" over 359 commits,
// because the diary only had rows from write() after the deploy. Every commit that changed a fact
// without a diary row of its own (the hub's filing, upkeep, merges, hand edits, and the days before
// the diary existed) is caught up into the diary: once 7 days back, then each tick.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readDiary } from "../src/diary";
import { catchUpDiary } from "../src/diary-catchup";
import { homeView } from "../src/dashboard/home";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { undoFact } from "../src/undo";

const sh = (cwd: string, author: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: "a@x" } });
// An edit outside write(): the role changes, the old record goes to history, as upkeep would.
function handChange(root: string) {
  const f = join(root, "people", "jane-roy.md");
  const text = readFileSync(f, "utf8");
  writeFileSync(f, text.replace(/value: Course coordinator/, "value: Program director"));
  sh(root, "upkeep", "git", "commit", "-qam", "upkeep: role");
}

test("a fact changed outside write() becomes one diary line; a second run adds nothing", () => {
  const root = makeBrain();
  expect(readFileSync(join(root, "people", "jane-roy.md"), "utf8")).toContain("value: Course coordinator");
  handChange(root);
  expect(readDiary(root)).toHaveLength(0);
  const r = catchUpDiary(root, new Date());
  expect(r.rows).toBe(1);
  const row = readDiary(root)[0]!;
  expect(row).toMatchObject({ fact_key: "people/jane-roy#role", kind: "changed", from: "Course coordinator", to: "Program director", title: "Jane Roy" });
  expect(catchUpDiary(root, new Date()).rows).toBe(0);
  const v = homeView(root, loadRules(root), loadBrain(root), new Date(), { all: true });
  expect(v.since.map((l) => l.what)).toContain("Jane is Program director now, not Course coordinator.");
});

test("a write that already has its line, and a page-text commit, add nothing", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  const f = join(root, "people", "jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8") + "\nA sentence of page text.\n");
  sh(root, "hub", "git", "commit", "-qam", "hub: page text");
  const before = readDiary(root).length;
  expect(catchUpDiary(root, new Date()).rows).toBe(0);
  expect(readDiary(root)).toHaveLength(before);
});

test("only the last 7 days on the first run", () => {
  const root = makeBrain();
  handChange(root);
  const later = new Date(Date.now() + 9 * 86_400_000);
  expect(catchUpDiary(root, later).rows).toBe(0);
});

test("a caught-up line takes its place in time among the lines write() made after it", () => {
  const root = makeBrain();
  handChange(root);
  write(root, { agent: "planner", id: "projects/course-a", attribute: "room", value: "B-201", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  catchUpDiary(root, new Date());
  expect(readDiary(root).map((r) => r.fact_key)).toEqual(["people/jane-roy#role", "projects/course-a#room"]);
});

// The Mac's second check (2026-10-26): after the first catch-up the real brain had 1 line, from
// 22 Oct: the oldest commits were read first, 150 a tick. Now one git call lists them all, today's
// are read first, and a busy week fits in one run.
test("a busy week is read in one run, today's changes included; a dry run counts and writes nothing", () => {
  const root = makeBrain();
  const f = join(root, "projects", "course-a.md");
  for (let i = 0; i < 200; i++) {
    const t = readFileSync(f, "utf8");
    writeFileSync(f, i === 0 ? t.replace(/^---\n/, `---\n# n0\n`) : t.replace(/^# n\d+\n/m, `# n${i}\n`));
    sh(root, "hub", "git", "commit", "-qam", `hub: page text ${i}`);
  }
  handChange(root);
  const dry = catchUpDiary(root, new Date(), { dryRun: true });
  expect(dry).toMatchObject({ commits: 202, rows: 1, pending: 0, kinds: { changed: 1 } });
  expect(dry.skipped.no_notes + dry.notes).toBeGreaterThanOrEqual(200);
  expect(readDiary(root)).toHaveLength(0);
  expect(catchUpDiary(root, new Date()).rows).toBe(1);
  expect(readDiary(root)[0]!.fact_key).toBe("people/jane-roy#role");
}, 30_000); // the 200 setup commits alone take seconds on a busy machine

// The minute tick reads HEAD from .git's own files, so an idle hub starts no git (audit v4).
test("HEAD is read without git, loose or packed", async () => {
  const { headSha } = await import("../src/diary-catchup");
  const root = makeBrain();
  const rev = () => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
  expect(headSha(root)).toBe(rev());
  Bun.spawnSync(["git", "pack-refs", "--all"], { cwd: root });
  expect(headSha(root)).toBe(rev());
});
