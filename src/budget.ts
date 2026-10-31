// SPDX-License-Identifier: AGPL-3.0-only
// Per-agent request budget (backlog 240, docs/hub.md "Request budget"). Every door counts an
// agent's requests per minute and its writes per hour; past either it gets a plain 429 (or a tool
// error on MCP) saying when to try again, and the owner gets one alert per agent a day. A runaway
// loop can't flood the write lock or the brain's history, and other agents are untouched.
// Counts live in memory: a hub restart starts them over, which only ever lets more through.
import { loadRules, type Rules } from "./rules";
import { alert } from "./util";
import { ownerDay } from "./clock";

export interface Budget { requests_per_minute?: number; writes_per_hour?: number }
export const DEFAULT_BUDGET = { requests_per_minute: 120, writes_per_hour: 300 };
export type Spend = "request" | "write";

const WINDOW: Record<Spend, number> = { request: 60_000, write: 3_600_000 };
const spent = new Map<string, number[]>();
const told = new Map<string, string>();

export function resetBudgets() { spent.clear(); told.clear(); }

// policy.yaml `budget:` for every agent, `agents.<id>.budget:` for one. 0 means none allowed
// (writes_per_hour: 0 makes an agent read-only on every door); a missing or bad value keeps the
// default; anything over MAX is MAX, so the counts stay small.
const MAX = 100_000;
export function budgetFor(rules: Rules, agent: string): typeof DEFAULT_BUDGET {
  const pick = (b: unknown, k: keyof typeof DEFAULT_BUDGET) => {
    const v = (b as Budget | undefined)?.[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(MAX, Math.floor(v)) : undefined;
  };
  const all = (rules.policy as { budget?: Budget }).budget, mine = (rules.policy.agents[agent] as { budget?: Budget } | undefined)?.budget;
  return {
    requests_per_minute: pick(mine, "requests_per_minute") ?? pick(all, "requests_per_minute") ?? DEFAULT_BUDGET.requests_per_minute,
    writes_per_hour: pick(mine, "writes_per_hour") ?? pick(all, "writes_per_hour") ?? DEFAULT_BUDGET.writes_per_hour,
  };
}

// A token role has its own count, so a vendor's reader token can't use up the owner's resolver
// token on the same agent (240 slice audit).
const keyOf = (root: string, agent: string, kind: Spend, role?: string) => `${root}\0${agent}\0${role ?? ""}\0${kind}`;

// Undefined when one more fits; else the seconds until one is free (and the owner is told once a
// day). Nothing is counted: record() does that once the request has done its work.
export function check(root: string, agent: string, kind: Spend, o: { role?: string; now?: number; rules?: Rules } = {}): number | undefined {
  const now = o.now ?? Date.now();
  const rules = o.rules ?? loadRules(root);
  const b = budgetFor(rules, agent);
  // The resolver token carries the owner's own answers and texts: ten times the room, never none.
  const base = kind === "request" ? b.requests_per_minute : b.writes_per_hour;
  const cap = o.role === "resolver" ? Math.max(base, 1) * 10 : base;
  const key = keyOf(root, agent, kind, o.role);
  const xs = (spent.get(key) ?? []).filter((t) => t > now - WINDOW[kind]);
  spent.set(key, xs);
  if (xs.length < cap) return undefined;
  const day = ownerDay(rules, new Date(now)); // once per the owner's day, not UTC's
  if (told.get(key) !== day) {
    told.set(key, day);
    alert(root, { agent, check: "request_budget", detail: `${agent} went over ${cap} ${kind === "request" ? "requests a minute" : "writes an hour"}; it is turned away until it slows down. A loop or a retrying routine is the usual cause.` });
  }
  // Free when all but cap-1 of the window have aged out (a lowered cap waits longer).
  const oldest = cap > 0 ? xs[xs.length - cap] : now;
  return Math.max(1, Math.ceil((oldest + WINDOW[kind] - now) / 1000));
}
export function record(root: string, agent: string, kind: Spend, o: { role?: string; now?: number } = {}) {
  const key = keyOf(root, agent, kind, o.role);
  const xs = spent.get(key) ?? [];
  xs.push(o.now ?? Date.now());
  spent.set(key, xs);
}
// Takes back a write recorded up front whose request then failed (a 404, a refusal).
export function release(root: string, agent: string, kind: Spend, at: number, o: { role?: string } = {}) {
  const xs = spent.get(keyOf(root, agent, kind, o.role));
  const i = xs ? xs.lastIndexOf(at) : -1;
  if (i >= 0) xs!.splice(i, 1);
}
// check, then record when it fits.
export function spend(root: string, agent: string, kind: Spend, now = Date.now(), o: { role?: string; rules?: Rules } = {}): number | undefined {
  const wait = check(root, agent, kind, { ...o, now });
  if (!wait) record(root, agent, kind, { role: o.role, now });
  return wait;
}

// The brains this process serves agents for (serve() marks each), so the dashboard knows whether
// the counts it can see are the live ones (backlog 267): a dashboard run on its own sees none.
const serving = new Set<string>();
export const markServing = (root: string) => { serving.add(root); };
export const servesHere = (root: string) => serving.has(root);

// What the agent's page shows (backlog 267): per token role, requests in the last minute and writes
// in the last hour, against that role's caps. The plain row comes first, even at zero.
export interface BudgetUse { role?: string; requests: number; writes: number; requests_per_minute: number; writes_per_hour: number }
export function budgetUse(root: string, agent: string, o: { now?: number; rules?: Rules } = {}): BudgetUse[] {
  const now = o.now ?? Date.now();
  const b = budgetFor(o.rules ?? loadRules(root), agent);
  const prefix = `${root}\0${agent}\0`;
  const rows = new Map<string, BudgetUse>([["", { requests: 0, writes: 0, ...b }]]);
  for (const [key, xs] of spent) {
    if (!key.startsWith(prefix)) continue;
    const [role, kind] = key.slice(prefix.length).split("\0") as [string, Spend];
    // The same caps check() applies: the resolver token gets ten times the room.
    const cap = (n: number) => role === "resolver" ? Math.max(n, 1) * 10 : n;
    if (!rows.has(role)) rows.set(role, { role, requests: 0, writes: 0, requests_per_minute: cap(b.requests_per_minute), writes_per_hour: cap(b.writes_per_hour) });
    rows.get(role)![kind === "request" ? "requests" : "writes"] = xs.filter((t) => t > now - WINDOW[kind]).length;
  }
  return [...rows.values()];
}

export const overBudget = (kind: Spend, seconds: number) =>
  `too many ${kind === "request" ? "requests" : "writes"} from you; try again in ${seconds} s`;
