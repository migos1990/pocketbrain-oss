// SPDX-License-Identifier: AGPL-3.0-only
// Switch-day scores (evals/cases/switchday.ts) kept across runs in evals/history/switchday.jsonl,
// one line per scored run, for the owner's digest. Written even with --only, since the paid run
// is `--llm --only switchday` and that skips scorecard.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Scored } from "./case";

export const SWITCH_DAY_OUT_OF = 20;

export function recordSwitchDay(dir: string, scored: Scored[], run: { at: string; app_commit: string }): number {
  const rows = scored.filter((s) => typeof s.result.metrics?.switch_day_score === "number")
    .map((s) => ({ ...run, case: s.id, score: s.result.metrics!.switch_day_score, out_of: SWITCH_DAY_OUT_OF, pass: s.result.pass === true }));
  if (!rows.length) return 0;
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "switchday.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rows.length;
}
