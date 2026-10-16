// SPDX-License-Identifier: AGPL-3.0-only
// Quiz budget for the belief radar (docs/memory-sync.md, "Quiz budget"). Each question costs a
// turn of the assistant's own model, so an assistant is asked at most `perWeek` questions in any
// 7 days, and the budget goes to the facts most worth asking about first:
//
//   1. facts it was never asked about, before ones it answered more than 30 days ago;
//   2. then the person's standing (inner, close, known): priority only, never access;
//   3. then how often assistants read the note in the last 30 days;
//   4. then the oldest answer, then the key.
//
// Facts it answered in the last 30 days, or has an open question or a correction in flight on,
// are left out. Owner-only: `pocketbrain beliefs plan` shows it and `memsync run --budget` spends
// it. The gardener's nightly memory_sync is unchanged until the owner turns this on.
import { loadRules } from "./rules";
import { beliefs, type Cell } from "./beliefs";
import { quiz, state } from "./memsync";
import { readEntries, specificReads } from "./readlog";

export const QUIZ_PER_WEEK = 10;
const RECHECK_DAYS = 30;
const DAY = 86_400_000;
const TIER: Record<string, number> = { inner: 3, close: 2, known: 1 };

export interface PlanRow { agent: string; asked: number; left: number; keys: string[] }
interface Opts { perWeek?: number; now?: Date }

// Assistants that are quizzed: not paused, not the gardener or an inside-the-wall tool, not a
// collaborator's, and without readable memory files (those are scanned, not asked).
function quizzed(root: string): string[] {
  const rules = loadRules(root);
  return Object.entries(rules.policy.agents)
    .filter(([, a]) => !a.inside_wall && a.role !== "gardener" && !a.collaborator && a.status !== "paused" && !a.memory?.files?.length)
    .map(([n]) => n)
    .sort();
}

const askable = (c: Cell, now: Date) =>
  c.state === "unasked" || (["in-sync", "differs", "missing", "dismissed"].includes(c.state) && !!c.at && now.getTime() - new Date(c.at).getTime() > RECHECK_DAYS * DAY);

export function quizPlan(root: string, opts: Opts = {}): PlanRow[] {
  const perWeek = opts.perWeek ?? QUIZ_PER_WEEK;
  const now = opts.now ?? new Date();
  const radar = beliefs(root);
  const quizzes = state(root).quizzes;
  const rules = loadRules(root);
  const standing = rules.standing?.people ?? {};
  const reads = specificReads(readEntries(root), new Date(now.getTime() - RECHECK_DAYS * DAY).toISOString());
  const weekAgo = new Date(now.getTime() - 7 * DAY).toISOString();
  return quizzed(root).map((agent) => {
    const asked = quizzes.filter((q) => q.agent === agent && q.at >= weekAgo && q.at <= now.toISOString()).length;
    const left = Math.max(0, perWeek - asked);
    const ranked = radar.rows
      .filter((r) => r.cells[agent] && askable(r.cells[agent], now))
      .map((r) => {
        const c = r.cells[agent], note = r.key.split("#")[0];
        return { key: r.key, never: c.state === "unasked" ? 1 : 0, tier: TIER[standing[note]?.tier ?? ""] ?? 0, reads: reads.get(note)?.length ?? 0, at: c.at ?? "" };
      })
      .sort((a, b) => b.never - a.never || b.tier - a.tier || b.reads - a.reads || a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
    return { agent, asked, left, keys: ranked.slice(0, left).map((x) => x.key) };
  });
}

// Spends the plan: asks each assistant its planned facts, through memsync's own quiz (which keeps
// to the assistant's own carve). Returns the keys asked per assistant.
export function runQuizPlan(root: string, opts: Opts = {}): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const p of quizPlan(root, opts)) out[p.agent] = p.keys.length ? quiz(root, p.agent, p.keys.length, p.keys).map((q) => q.key) : [];
  return out;
}

export function renderPlan(rows: PlanRow[], perWeek = QUIZ_PER_WEEK): string {
  if (!rows.length) return "No assistant is quizzed (each is paused, the gardener, or has readable memory files).";
  return [`Quiz budget: ${perWeek} questions per assistant per 7 days.`, ...rows.map((p) =>
    `${p.agent}: asked ${p.asked} this week, ${p.left} left${p.keys.length ? `; next: ${p.keys.join(", ")}` : p.left ? "; nothing due" : ""}`)].join("\n");
}
