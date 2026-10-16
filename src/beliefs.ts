// SPDX-License-Identifier: AGPL-3.0-only
// Belief radar (docs/memory-sync.md, "Belief radar"): one picture of what every assistant's own
// memory holds about each fact, next to what the brain says now, and one owner action that fixes
// a fact in every assistant at once.
//
// Built only from memory sync's log (src/memsync.ts): quiz answers, scan findings and the state
// of each correction. A stored answer is graded again against the brain as it reads today, so an
// answer that was right last week turns red the moment the brain changes. No model is involved.
//
// Owner-only, like `explain`: nothing here is served to an agent. Each agent's cells cover only
// the facts in its own carve, and the fix-everywhere action only asks an agent about a fact in its
// own carve and only approves corrections already made for it, through memsync's own functions.
import { loadBrain } from "./brain";
import { loadRules, type Rules } from "./rules";
import { carve, grantFor } from "./carve";
import { approve, decline, grade, oneLine, quiz, scan, state, stillCurrent, targetFor, targets, type Correction, type Quiz, type Target } from "./memsync";
import { squash } from "./match";

export type CellState = "in-sync" | "drift" | "differs" | "missing" | "fixing" | "asked" | "unasked" | "dismissed";
export interface Cell { state: CellState; said?: string; at?: string; correction?: string }
export interface Row { key: string; title: string; attr: string; now: string[]; cells: Record<string, Cell> }
export interface Beliefs { agents: string[]; rows: Row[] }

// Agents with a memory of their own: not the owner's inside-the-wall tools, not the gardener.
function memoryAgents(rules: Rules): string[] {
  return Object.entries(rules.policy.agents)
    .filter(([, a]) => !a.inside_wall && a.role !== "gardener")
    .map(([n]) => n)
    .sort();
}

const FIXING: Correction["state"][] = ["approved", "delivered", "applied"];

// The latest evidence wins. A correction is logged when its answer is graded, so on equal times
// it comes after its quiz.
function cellFor(t: Target, qs: Quiz[], cs: Correction[]): Cell {
  type Ev = { at: string; q?: Quiz; c?: Correction };
  const evs: Ev[] = [...qs.map((q): Ev => ({ at: q.at, q })), ...cs.map((c): Ev => ({ at: c.at, c }))]
    .sort((a, b) => a.at.localeCompare(b.at) || (a.q ? -1 : 1) - (b.q ? -1 : 1));
  for (const e of evs.reverse()) {
    if (e.q) {
      const q = e.q;
      if (q.state === "expired") continue;
      if (q.state === "open") return { state: q.recheck ? "fixing" : "asked", at: q.at, ...(q.recheck ? { correction: q.recheck } : {}) };
      return { state: grade(t, q.answer ?? ""), said: q.answer, at: q.at };
    }
    const c = e.c!;
    const said = qs.find((q) => q.id === c.from.quiz)?.answer ?? c.wrong;
    if (c.state === "proposed") { if (c.from.quiz) continue; return { state: "drift", said, at: c.at, correction: c.id }; }
    if (FIXING.includes(c.state)) return { state: "fixing", said, at: c.at, correction: c.id };
    if (c.state === "verified") return { state: "in-sync", at: c.at, correction: c.id };
    if (c.state === "declined") return { state: "dismissed", said, at: c.at, correction: c.id };
    return { state: "drift", said, at: c.at, correction: c.id }; // still-wrong, needs-hand
  }
  return { state: "unasked" };
}

export function beliefs(root: string): Beliefs {
  const rules = loadRules(root);
  const notes = loadBrain(root);
  const s = state(root);
  const agents = memoryAgents(rules);
  const rows = new Map<string, Row>();
  for (const agent of agents) {
    for (const t of targets(notes, rules, carve(notes, rules, grantFor(rules, agent)))) {
      const row = rows.get(t.key) ?? { key: t.key, title: t.title, attr: t.attr, now: t.current, cells: {} };
      rows.set(t.key, row);
      const mine = (x: { agent: string; key: string }) => x.agent === agent && x.key === t.key;
      row.cells[agent] = cellFor(t, s.quizzes.filter(mine), s.corrections.filter(mine));
    }
  }
  return { agents, rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

export interface FixResult { approved: string[]; asked: string[]; rescanned: string[]; skipped: string[] }

// The owner's one tap: every waiting correction for this fact is approved (each signed and handed
// over by memsync as usual), and every agent whose memory of it is unknown or no longer matches the
// brain is asked again. A paused agent is left alone. Running it twice does nothing the second time.
export function fixEverywhere(root: string, key: string): FixResult {
  const rules = loadRules(root);
  const out: FixResult = { approved: [], asked: [], rescanned: [], skipped: [] };
  const row = beliefs(root).rows.find((r) => r.key === key);
  if (!row) throw new Error(`no fact ${key} in any assistant's view`);
  for (const agent of Object.keys(row.cells).sort()) {
    const a = rules.policy.agents[agent];
    if (a.status === "paused") { out.skipped.push(agent); continue; }
    if (a.memory?.files?.length) { scan(root, agent); out.rescanned.push(agent); }
    // A correction carries the value from when the answer was graded. If the owner has changed the
    // fact since, it would deliver a value the owner no longer holds (G75): decline it and ask again,
    // so the next answer is graded against the brain as it reads now.
    const now = targetFor(root, agent, key);
    const waiting = state(root).corrections.filter((c) => c.agent === agent && c.key === key && c.state === "proposed");
    const fresh = waiting.filter((c) => stillCurrent(c, now));
    for (const c of waiting) if (!fresh.includes(c)) decline(root, c.id);
    for (const c of fresh) approve(root, c.id);
    if (fresh.length) { out.approved.push(agent); continue; }
    const cell = row.cells[agent];
    const stale = waiting.length > 0;
    if ((stale || ["unasked", "drift", "differs"].includes(cell.state)) && !a.memory?.files?.length && quiz(root, agent, 1, [key]).length) out.asked.push(agent);
  }
  return out;
}

const line = oneLine;

const RED: CellState[] = ["drift", "differs"];
const LABEL: Record<CellState, string> = {
  "in-sync": "in sync", drift: "drift", differs: "differs", missing: "doesn't remember", fixing: "fixing",
  asked: "asked", unasked: "never asked", dismissed: "you said fine",
};

export function renderBeliefs(b: Beliefs, opts: { onlyRed?: boolean; agent?: string } = {}): string {
  const counts = new Map<CellState, number>();
  for (const r of b.rows) for (const [ag, c] of Object.entries(r.cells)) if (!opts.agent || ag === opts.agent) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
  const order: CellState[] = ["drift", "differs", "fixing", "asked", "in-sync", "missing", "dismissed", "unasked"];
  const lines = [order.map((s) => `${LABEL[s]} ${counts.get(s) ?? 0}`).join(" · ")];
  const red = (r: Row) => Object.entries(r.cells).some(([ag, c]) => (!opts.agent || ag === opts.agent) && RED.includes(c.state));
  const rows = [...b.rows.filter(red), ...b.rows.filter((r) => !red(r))].filter((r) => (!opts.onlyRed || red(r)) && (!opts.agent || r.cells[opts.agent]));
  for (const r of rows) {
    lines.push(line(`${r.title}: ${r.attr.replace(/_/g, " ")} = ${r.now.length ? r.now.join(", ") : "(no longer held)"}  [${r.key}]`));
    const cells = Object.entries(r.cells).filter(([ag]) => !opts.agent || ag === opts.agent)
      .map(([ag, c]) => `${ag}: ${LABEL[c.state]}${c.said && c.state !== "in-sync" ? ` (${JSON.stringify(line(c.said).slice(0, 80))})` : ""}`);
    lines.push(`  ${cells.join(", ")}`);
  }
  if (rows.some(red)) lines.push("", "Fix one everywhere: pocketbrain beliefs fix <key>");
  return lines.join("\n");
}
