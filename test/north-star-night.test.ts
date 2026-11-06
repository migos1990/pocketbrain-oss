// SPDX-License-Identifier: AGPL-3.0-only
// Pages-ok, part 3 (real-brain north star, 2026-11-01): pages "end the night" with prose, but the
// real brain was measured over the 24 hours before the probe ran, so a page touched after the
// night's writer counted before it had ever been written. The real brain is measured over the day
// up to the last nightly run (upkeep's findings commit); with none lately, the last day (G672).
import { test, expect } from "bun:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { nightWindow, touchedSince } from "../scripts/north-star";

function commitAt(root: string, who: string, when: string, file: string, msg: string) {
  appendFileSync(join(root, file), "\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: who, GIT_AUTHOR_EMAIL: `${who}@pocketbrain.local`, GIT_COMMITTER_NAME: who, GIT_COMMITTER_EMAIL: `${who}@pocketbrain.local`, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
  Bun.spawnSync(["git", "add", "-A"], { cwd: root, env });
  Bun.spawnSync(["git", "commit", "-qm", msg], { cwd: root, env });
}

test("G672 the real brain is measured over the day up to the last nightly run, not past it", () => {
  const root = makeBrain();
  commitAt(root, "planner", "2026-11-05T20:00:00Z", "projects/course-a.md", "planner: before the night");
  commitAt(root, "reflect", "2026-11-06T07:30:00Z", "rules/policy.yaml", "reflect: findings for reflect-x\n\nAgent: reflect\nRun: reflect-x\nKind: findings");
  commitAt(root, "planner", "2026-11-06T10:00:00Z", "projects/course-b.md", "planner: after the night");
  const now = new Date("2026-11-06T12:00:00Z");
  const day = nightWindow(root, now);
  expect(day.until).toBe("2026-11-06T07:30:00.000Z");
  const touched = touchedSince(root, day.since, day.until);
  expect(touched.has("projects/course-a.md")).toBe(true);
  expect(touched.has("projects/course-b.md")).toBe(false); // the next night writes it, then it counts
  // No nightly run in the last 36 hours: the last day, as before.
  const later = nightWindow(root, new Date("2026-11-08T12:00:00Z"));
  expect(later.until).toBe("2026-11-08T12:00:00.000Z");
});
