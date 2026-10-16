// SPDX-License-Identifier: AGPL-3.0-only
// A paid switch-day run (bun evals/run.ts --llm --only switchday) leaves its score in
// evals/history/switchday.jsonl, so the owner's digest can show it after the Mac pulls the app.
// Runs with --only skip scorecard.jsonl, so this file is written on its own.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordSwitchDay } from "../evals/lib/switchday-history";

const scored = (id: string, metrics?: Record<string, number>, pass = true) => ({ id, dimension: "e2e", kind: "benign", title: "", source: "synthetic", run: async () => ({ pass }), result: { pass, detail: "", metrics }, ms: 1 }) as any;

test("a run with a switch-day score appends one line with the score, the commit and the time", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  const n = recordSwitchDay(dir, [scored("x"), scored("switchday-20", { switch_day_score: 17 }, false)], { at: "2026-10-15T20:00:00.000Z", app_commit: "a1b2c3d" });
  expect(n).toBe(1);
  const lines = readFileSync(join(dir, "switchday.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toEqual([{ at: "2026-10-15T20:00:00.000Z", app_commit: "a1b2c3d", case: "switchday-20", score: 17, out_of: 20, pass: false }]);
});

test("a run without a switch-day score writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  expect(recordSwitchDay(dir, [scored("x", { other: 1 })], { at: "t", app_commit: "c" })).toBe(0);
  expect(existsSync(join(dir, "switchday.jsonl"))).toBe(false);
});
