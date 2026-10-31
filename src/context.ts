// SPDX-License-Identifier: AGPL-3.0-only
// Context size budget (backlog 290, docs/hub.md "Context budget"). What one call hands an agent
// stays under a per-agent token budget, so a small or cheap model can use it and a big brain
// doesn't flood any agent. Tokens are estimated as characters / 4 (no tokenizer, no model call).
// Trimming drops whole notes from the end of a ranked list: a kept note keeps every fact and its
// sources, and the header (what isn't shared, what the notes are) always stays. Orientation is the
// rules the agent is told: it is measured and logged when over, never cut.
import type { Rules } from "./rules";

export const tokensOf = (s: string) => Math.ceil(s.length / 4);

export interface ContextBudget { orientation: number; context_pack: number; whats_new: number; memory_check: number }
// About what a small model's working context can spare per call. The example brain's whole view
// fits; a 10k-note brain's doesn't (docs/perf.md, "Context sizes").
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = { orientation: 3000, context_pack: 8000, whats_new: 4000, memory_check: 4000 };
const MIN = 100, MAX = 200_000;

// policy.yaml `context_budget:` for every agent, `agents.<id>.context_budget:` for one. A value
// that isn't a positive number keeps the default; it is held between 100 and 200000.
export function contextBudget(rules: Rules, agent: string): ContextBudget {
  const all: Partial<ContextBudget> = rules.policy.context_budget ?? {};
  const mine: Partial<ContextBudget> = rules.policy.agents[agent]?.context_budget ?? {};
  const out = { ...DEFAULT_CONTEXT_BUDGET };
  for (const k of Object.keys(out) as (keyof ContextBudget)[]) {
    const v = typeof mine[k] === "number" ? mine[k] : all[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.min(MAX, Math.max(MIN, Math.round(v)));
  }
  return out;
}

// The head, then as many blocks as fit, in their order, then a line saying how many were left out
// (built by `tail`). The first block is always kept when the head leaves room for it, so an answer
// is never only a header; a head over budget on its own is sent alone with the tail line.
export function fitBlocks(head: string, blocks: string[], tokens: number, sep: string, tail: (left: number, ids: string[]) => string, idOf: (b: string) => string | undefined = () => undefined): { text: string; kept: number; cut: number } {
  const whole = blocks.length ? head + sep + blocks.join(sep) : head;
  if (tokensOf(whole) <= tokens) return { text: whole, kept: blocks.length, cut: 0 };
  const kept: string[] = [];
  for (const [i, b] of blocks.entries()) {
    const left = blocks.slice(i + 1);
    const note = tail(left.length, left.map(idOf).filter((x): x is string => !!x));
    const next = [head, ...kept, b].join(sep) + note;
    if (tokensOf(next) > tokens) break;
    kept.push(b);
  }
  const rest = blocks.slice(kept.length);
  const note = tail(rest.length, rest.map(idOf).filter((x): x is string => !!x));
  return { text: [head, ...kept].join(sep) + note, kept: kept.length, cut: rest.length };
}

// The line at the end of a cut answer. Ids are of notes the agent holds; a few are named so it can
// read them one by one.
export function cutLine(left: number, ids: string[], budget: number, how: string): string {
  if (!left) return "";
  const named = ids.slice(0, 8);
  return `\n\n(${left} note${left > 1 ? "s" : ""} over your context budget of ${budget} tokens ${left > 1 ? "are" : "is"} left out${named.length ? `: ${named.join(", ")}${ids.length > named.length ? ", …" : ""}` : ""}. ${how})\n`;
}
