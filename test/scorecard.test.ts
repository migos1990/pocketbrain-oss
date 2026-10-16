// SPDX-License-Identifier: AGPL-3.0-only
// One scorecard line a day in the owner's digest (backlog #195): the memory exam and the
// switch-day score, each with the day it was measured (src/scorecard.ts, docs/memory-sync.md).
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { scorecardLine } from "../src/scorecard";
import { digest } from "../src/digest";

const app = () => mkdtempSync(join(tmpdir(), "pb-app-"));
function exam(root: string, at: string, grades: Record<string, string>) {
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "exam.jsonl"), JSON.stringify({ at, days: 7, grades }) + "\n");
}
function switchDay(dir: string, at: string, value: number, commit = "abc1234") {
  mkdirSync(join(dir, "evals", "history"), { recursive: true });
  appendFileSync(join(dir, "evals", "history", "switchday.jsonl"), JSON.stringify({ at, app_commit: commit, case: "switchday-20", score: value, out_of: 20, pass: value >= 18 }) + "\n");
}

test("before anything ran, the line says so instead of showing a zero", () => {
  expect(scorecardLine(makeBrain(), app())).toBe("- Scorecard: memory exam not run yet · switch day not run yet");
});

test("the latest exam and the latest switch-day score, each with its day", () => {
  const root = makeBrain(), dir = app();
  exam(root, "2026-10-04T09:00:00Z", { planner: "fail" });
  exam(root, "2026-10-11T09:00:00Z", { planner: "pass", claude: "watch", helper: "no data" });
  switchDay(dir, "2026-10-14T20:00:00Z", 15, "aaa1111");
  switchDay(dir, "2026-10-15T20:00:00Z", 17, "bbb2222");
  expect(scorecardLine(root, dir)).toBe("- Scorecard: memory exam 1/2 pass (2026-10-11) · switch day 17/20 (2026-10-15, bbb2222)");
});

test("a broken history line is skipped, and the digest leads its numbers with the scorecard", () => {
  const root = makeBrain(), dir = app();
  switchDay(dir, "2026-10-15T20:00:00Z", 18);
  appendFileSync(join(dir, "evals", "history", "switchday.jsonl"), '{"at":"2026-10-16","score":1');
  expect(scorecardLine(root, dir)).toMatch(/switch day 18\/20 \(2026-10-15, abc1234\)/);
  const text = digest(root).text;
  const numbers = text.split("## Numbers")[1].trim().split("\n");
  expect(numbers[0]).toMatch(/^- Scorecard: /);
});
