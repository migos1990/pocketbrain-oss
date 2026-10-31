// SPDX-License-Identifier: AGPL-3.0-only
// The belief radar on the home (outside review, 2026-10-29): per assistant, what its own memory
// last said that the brain says is wrong now, each with one tap that corrects it in every
// assistant (fixEverywhere in src/beliefs.ts). Built only from beliefs(), so no model and nothing
// new is asked to read anything. Owner-only, like the rest of the home. A private value, or one
// that waits for the owner's Show, names only its page: what the assistant said is not shown.
import type { Note } from "../brain";
import { sensitivityRank } from "../brain";
import { records, carve, grantFor } from "../carve";
import type { Rules } from "../rules";
import { beliefs, type CellState } from "../beliefs";
import { displayName } from "../diary";
import { plain, type HomeView } from "./home";

export interface WrongLine {
  key: string;      // the fact, for the Fix everywhere button
  page: string;     // note id the line opens
  what: string;     // "Jane Roy: role"
  said?: string;    // what the assistant's memory said (cut), absent when private
  now?: string;     // what the brain says, absent when private
  fixing: boolean;  // a correction is on its way: no button
}
export interface AssistantWrong { agent: string; label: string; lines: WrongLine[]; more: number }

export const WRONG_PER_ASSISTANT = 3;
const RED: CellState[] = ["drift", "differs"];
const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function quiet(note: Note | undefined, attr: string): boolean {
  if (!note) return true;
  if (sensitivityRank(note.fm.sensitivity) >= sensitivityRank("private")) return true;
  const f = note.fm.facts?.[attr];
  if (!f) return false;
  return records(f).some((r) => !r.valid_to && (r.unseen === true || sensitivityRank(r.sensitivity) >= sensitivityRank("private")));
}

// Assistants that have something wrong, most wrong first; each lists its oldest-first lines up to
// WRONG_PER_ASSISTANT, the rest counted. An assistant with nothing wrong is left out.
export function assistantsWrong(root: string, rules: Rules, notes: Note[]): AssistantWrong[] {
  const b = beliefs(root);
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const title = (id: string) => { const t = byId.get(id)?.fm.title; return t === undefined ? undefined : String(t); };
  const out: AssistantWrong[] = [];
  for (const agent of b.agents) {
    const lines: (WrongLine & { at: string })[] = [];
    for (const r of b.rows) {
      const c = r.cells[agent];
      if (!c || !(RED.includes(c.state) || (c.state === "fixing" && c.said !== undefined))) continue;
      const id = r.key.slice(0, r.key.lastIndexOf("#"));
      const hush = quiet(byId.get(id), r.attr);
      lines.push({
        key: r.key, page: id, at: c.at ?? "",
        what: `${displayName(id, title(id) ?? r.title)}: ${r.attr.replace(/[_-]+/g, " ")}`,
        ...(hush ? {} : { said: cut(c.said ?? ""), now: cut(r.now.map((v) => plain(v, title)).join(", ")) }),
        fixing: c.state === "fixing",
      });
    }
    if (!lines.some((l) => !l.fixing)) continue;
    lines.sort((x, y) => Number(x.fixing) - Number(y.fixing) || x.at.localeCompare(y.at));
    out.push({ agent, label: rules.policy.agents[agent]?.label ?? agent, lines: lines.slice(0, WRONG_PER_ASSISTANT).map(({ at: _a, ...l }) => l), more: Math.max(0, lines.length - WRONG_PER_ASSISTANT) });
  }
  return out.sort((x, y) => y.lines.length + y.more - (x.lines.length + x.more) || x.agent.localeCompare(y.agent));
}

// See as on the home (outside review, 2026-10-29): how much of the brain each assistant gets, with a
// link to the page that shows it exactly as that assistant does (/map?as=, behind a fresh sign-in
// like every page past the home). Counts only: no title or value. Same assistants as the radar.
export interface AssistantView { agent: string; label: string; sees: number; of: number; href: string }
export function assistantViews(root: string, rules: Rules, notes: Note[]): AssistantView[] {
  return beliefs(root).agents.filter((a) => rules.policy.agents[a]?.status !== "paused").map((agent) => ({
    agent, label: rules.policy.agents[agent]?.label ?? agent,
    sees: carve(notes, rules, grantFor(rules, agent), { flags: false }).visible.size, of: notes.length,
    href: `/map?as=${encodeURIComponent(agent)}`,
  }));
}

// The home's one row per assistant (shared with the box thread's assistantReads): its reads today,
// how much it sees, and what it has wrong. An assistant the radar knows but the reads leave out
// (paused) stays out.
// Past a fresh sign-in, a line on a page that is secret now is left out, as on Memory.
export function withRadar(root: string, rules: Rules, notes: Note[], reads: HomeView["reads"], fresh = true): HomeView["reads"] {
  const secret = new Set(fresh ? [] : notes.filter((n) => n.fm.sensitivity === "secret").map((n) => n.fm.id));
  const wrong = new Map(assistantsWrong(root, rules, notes).map((w) => {
    const lines = w.lines.filter((l) => !secret.has(l.page));
    return [w.agent, { ...w, lines, more: w.more + w.lines.length - lines.length }];
  }));
  const views = new Map(assistantViews(root, rules, notes).map((v) => [v.agent, v]));
  return reads.map((r) => {
    const w = wrong.get(r.agent), v = views.get(r.agent);
    return { ...r, ...(w ? { wrong: w.lines, more: w.more } : {}), ...(v ? { sees: v.sees, of: v.of, seeHref: v.href } : {}) };
  });
}
