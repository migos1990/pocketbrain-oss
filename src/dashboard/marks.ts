// SPDX-License-Identifier: AGPL-3.0-only
// Who knows a memory (owner app brief, 2026-10-30): one mark per assistant under each line on the
// home, filled when its carve holds the fact, dashed when it doesn't. Computed only from each
// assistant's own carve (grantFor + carve, the same view it reads through), never from the fact's
// text, so a mark can't say more than which assistant gets the line. Owner-only, like the home.
import type { Note } from "../brain";
import { carve, grantFor, records, type CarveResult } from "../carve";
import { scrubLeaves } from "../view";
import type { Rules } from "../rules";
import { ownAssistant } from "../rules";

export interface Mark { agent: string; name: string; short: string; holds: boolean }

// The assistants a mark is drawn for: the owner's own, not paused (the same as the home's rows).
export function markAgents(rules: Rules): { agent: string; name: string }[] {
  return Object.entries(rules.policy.agents).filter(([k, a]) => ownAssistant(rules, k) && a.status !== "paused")
    .map(([agent, a]) => ({ agent, name: a.label ?? agent })).sort((a, b) => a.name.localeCompare(b.name));
}

// A short name per assistant for its mark: its first letter, two when another starts the same.
export function shorts(names: string[]): string[] {
  return names.map((n, i) => (names.some((m, j) => j !== i && m[0]?.toLowerCase() === n[0]?.toLowerCase()) ? n.slice(0, 2) : n.slice(0, 1)).replace(/^./, (c) => c.toUpperCase()));
}

// Held means served as it is: a value the assistant would get as [withheld] (a carved value inside
// it, scrubbed by the view) is a dashed mark too (slice audit, 2026-10-30).
function holds(res: CarveResult, hidden: Set<string>, key: string): boolean {
  const hash = key.lastIndexOf("#");
  const v = res.visible.get(key.slice(0, hash));
  if (!v || hidden.has(key)) return false;
  const attr = key.slice(hash + 1);
  if (v.attributes !== "all" && !v.attributes.has(attr)) return false;
  const f = v.note.fm.facts?.[attr];
  const live = f ? records(f).filter((r) => !r.valid_to).map((r) => r.value) : [];
  return JSON.stringify(scrubLeaves(live, res)) === JSON.stringify(live);
}

// One carve per assistant, then a lookup per fact: marksFor(rules, notes)("people/x#role").
export function marksFor(rules: Rules, notes: Note[]): (factKey: string) => Mark[] {
  const agents = markAgents(rules);
  const short = shorts(agents.map((a) => a.name));
  const carves = agents.map((a) => { const res = carve(notes, rules, grantFor(rules, a.agent), { flags: false }); return { res, hidden: new Set(res.hiddenFacts.map((h) => h.key)) }; });
  return (key) => agents.map((a, i) => ({ ...a, short: short[i]!, holds: holds(carves[i]!.res, carves[i]!.hidden, key) }));
}

// The home's lines with their marks: a filed line whose fact is still on its page gets one per
// assistant; a held one gets its lock instead (html-home.ts), and one that was undone or taken back none.
export function withMarks<L extends { key?: string; held?: boolean; undo?: string }>(lines: L[], rules: Rules, notes: Note[], of = marksFor(rules, notes)): (L & { marks?: Mark[] })[] {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  return lines.map((l) => {
    if (!l.key || l.held || l.undo === "undone") return l;
    const hash = l.key.lastIndexOf("#");
    return byId.get(l.key.slice(0, hash))?.fm.facts?.[l.key.slice(hash + 1)] ? { ...l, marks: of(l.key) } : l;
  });
}
