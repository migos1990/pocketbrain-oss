// SPDX-License-Identifier: AGPL-3.0-only
// One scorecard line a day for the owner's digest: the memory exam (src/exam.ts, the brain's own
// log/exam.jsonl) and the switch-day score (docs/switch-day.md). Switch day is a paid eval run
// from the app's checkout, not the brain, so its score is read from the app's
// evals/history/switchday.jsonl, which the eval runner appends and the run commits with its result.
// Each half says the day it was measured; nothing run yet says so instead of showing a zero.
import { join } from "node:path";
import { readJsonl } from "./util";

const APP = join(import.meta.dir, "..");

interface ExamEntry { at: string; grades: Record<string, string> }
interface SwitchDay { at: string; app_commit?: string; score: number; out_of?: number }

export function scorecardLine(root: string, appDir = APP): string {
  const exam = readJsonl<ExamEntry>(join(root, "log", "exam.jsonl")).filter((e) => e?.at && e.grades).at(-1);
  const graded = exam ? Object.values(exam.grades).filter((g) => g !== "no data") : [];
  const examPart = !exam ? "memory exam not run yet"
    : `memory exam ${graded.filter((g) => g === "pass").length}/${graded.length} pass (${exam.at.slice(0, 10)})`;
  const sd = readJsonl<SwitchDay>(join(appDir, "evals", "history", "switchday.jsonl"))
    .filter((h) => typeof h?.score === "number" && typeof h.at === "string").at(-1);
  const sdPart = !sd ? "switch day not run yet"
    : `switch day ${sd.score}/${sd.out_of ?? 20} (${sd.at.slice(0, 10)}${sd.app_commit ? `, ${sd.app_commit.slice(0, 7)}` : ""})`;
  return `- Scorecard: ${examPart} · ${sdPart}`;
}
