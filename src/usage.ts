// SPDX-License-Identifier: AGPL-3.0-only
// Spend caps on the brain's own model calls (challenges-2.md point 30). Sleep, the duplicate
// judge, capture and the dashboard's Ask all call a model the owner pays for; each call is one
// line in log/usage.jsonl (tokens, wall seconds, cost at the owner's price sheet), hash-chained
// like the read and write logs. Past a monthly cap, or a step's own cap, model steps pause and
// the owner hears about it.
//
// Reads and writes are never metered or held here: on the owner's own machine a meter in the
// read or write path is a git revert away, and it would discourage the reading the product
// needs. Billing, if any, lives in the hosted service and counts only what it operates.
// Agents never see any of this: nothing here reaches their tools, orientation or errors.
//
// rules/policy.yaml (owner only):
//   usage:
//     currency: USD
//     prices: { model_minute: 0 }   # token prices come from src/pricing.ts; set
//                                   # model_input_per_million / model_output_per_million to override
//     cap: { monthly: 20, alert_at: 0.8, steps: { capture.extract: 5 } }
import { appendFileSync, existsSync, mkdirSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { today } from "./brain";
import { loadRules, type Rules } from "./rules";
import { lastHash } from "./readlog";
import type { Model, ModelReply, ModelRequest, DecisionRequest, DecisionReply } from "./model";
import { makeModel, modelConfigFor, type Provider } from "./model";
import { priceFor } from "./pricing";

export interface UsageEvent {
  at: string;
  day: string; // YYYY-MM-DD from today(), so PB_TODAY pins it in tests
  step: string; // sleep.consolidate, upkeep.duplicates, capture.extract, dashboard ask steps…
  by: string; // who ran it: reflect, capture, owner
  outcome: "ok" | "error";
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  estimated?: boolean; // token counts guessed from text length (fake provider, or none reported)
  unpriced?: boolean; // no price for this model in src/pricing.ts and none in policy.yaml: tokens cost 0 here
  seconds: number;
  cost: number; // at the price sheet in force when it ran
}

export interface UsagePolicy {
  currency?: string;
  prices?: { model_minute?: number; model_input_per_million?: number; model_output_per_million?: number };
  cap?: { monthly?: number; alert_at?: number; steps?: Record<string, number> };
}

export const usageFile = (root: string) => join(root, "log", "usage.jsonl");
export const usagePolicy = (rules: Rules): UsagePolicy => rules.policy.usage ?? {};

const round = (n: number) => Math.round(n * 1e6) / 1e6;

// Token prices: the owner's override in policy.yaml if set, else the list price in
// src/pricing.ts for the model asked for (or the one that answered), else unpriced.
export function priceOf(p: UsagePolicy, e: Pick<UsageEvent, "seconds" | "tokens_in" | "tokens_out" | "provider" | "model">, requested = e.model): { cost: number; unpriced?: true } {
  const pr = p.prices ?? {};
  const listed = priceFor(e.provider as Provider, requested, e.model);
  const input = pr.model_input_per_million ?? listed?.input;
  const output = pr.model_output_per_million ?? listed?.output;
  const cost = round((pr.model_minute ?? 0) * e.seconds / 60 + (input ?? 0) * e.tokens_in / 1e6 + (output ?? 0) * e.tokens_out / 1e6);
  return input === undefined || output === undefined ? { cost, unpriced: true } : { cost };
}

// ---------- recording ----------

export function record(root: string, e: Omit<UsageEvent, "cost" | "at" | "day" | "unpriced">, requested?: string, rules = loadRules(root)): UsageEvent {
  const ev: UsageEvent = { at: new Date().toISOString(), day: today(), ...e, ...priceOf(usagePolicy(rules), e, requested) };
  appendChained(usageFile(root), ev as unknown as Record<string, unknown>);
  return ev;
}

// The same chain as readlog's appendChained (verifyChain checks it), with the last hash kept
// in memory while the file size matches, so a busy month isn't re-read on every call.
const tail = new Map<string, { size: number; hash: string }>();
function appendChained(file: string, entry: Record<string, unknown>) {
  mkdirSync(dirname(file), { recursive: true });
  const size = existsSync(file) ? statSync(file).size : 0;
  const t = tail.get(file);
  const prev = t && t.size === size ? t.hash : lastHash(file);
  const hash = createHash("sha256").update(JSON.stringify({ ...entry, prev })).digest("hex");
  const line = JSON.stringify({ ...entry, prev, hash }) + "\n";
  appendFileSync(file, line);
  tail.set(file, { size: size + Buffer.byteLength(line), hash });
}

// ---------- reading ----------

// Parsed incrementally: the file only grows, so each call reads just the new bytes. A file
// that shrank (a new brain, a restored copy) is read again from the start.
const cache = new Map<string, { size: number; events: UsageEvent[]; rest: string }>();

export function usageEvents(root: string): UsageEvent[] {
  const file = usageFile(root);
  if (!existsSync(file)) { cache.delete(file); return []; }
  const size = statSync(file).size;
  let c = cache.get(file);
  if (!c || size < c.size) c = { size: 0, events: [], rest: "" };
  if (size > c.size) {
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - c.size);
    readSync(fd, buf, 0, buf.length, c.size);
    closeSync(fd);
    const lines = (c.rest + buf.toString("utf8")).split("\n");
    c.rest = lines.pop() ?? "";
    for (const l of lines) if (l.trim()) { try { c.events.push(JSON.parse(l)); } catch { /* verifyChain reports it */ } }
    c.size = size;
  }
  cache.set(file, c);
  return c.events;
}

export interface Totals { calls: number; errors: number; tokens_in: number; tokens_out: number; seconds: number; estimated: boolean; unpriced: boolean; cost: number }

export function totals(events: UsageEvent[]): Totals {
  const t: Totals = { calls: 0, errors: 0, tokens_in: 0, tokens_out: 0, seconds: 0, estimated: false, unpriced: false, cost: 0 };
  for (const e of events) {
    t.calls++;
    if (e.outcome === "error") t.errors++;
    t.tokens_in += e.tokens_in ?? 0;
    t.tokens_out += e.tokens_out ?? 0;
    t.seconds += e.seconds ?? 0;
    if (e.estimated) t.estimated = true;
    if (e.unpriced) t.unpriced = true;
    t.cost += e.cost ?? 0;
  }
  t.cost = round(t.cost);
  t.seconds = Math.round(t.seconds * 100) / 100;
  return t;
}

export const monthOf = (day: string) => day.slice(0, 7);

function group<T>(xs: T[], key: (x: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const x of xs) (m.get(key(x)) ?? m.set(key(x), []).get(key(x))!).push(x);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function summary(root: string, opts: { month?: string } = {}) {
  const month = opts.month ?? monthOf(today());
  const events = usageEvents(root).filter((e) => monthOf(e.day) === month);
  return {
    month,
    total: totals(events),
    days: group(events, (e) => e.day).map(([day, xs]) => ({ day, ...totals(xs) })),
    steps: group(events, (e) => e.step).map(([step, xs]) => ({ step, ...totals(xs), models: [...new Set(xs.map((x) => `${x.provider}/${x.model}`))].join(", ") })),
  };
}

// ---------- caps ----------

export interface CapState {
  month: string;
  currency: string;
  spent: number;
  cap?: number;
  ratio?: number;
  state: "none" | "ok" | "warn" | "over";
  alert_at: number;
  steps: { step: string; spent: number; cap: number; over: boolean }[];
}

export function capState(root: string, rules = loadRules(root)): CapState {
  const p = usagePolicy(rules);
  const month = monthOf(today());
  const events = usageEvents(root).filter((e) => monthOf(e.day) === month);
  const spent = totals(events).cost;
  const cap = p.cap?.monthly;
  const alert_at = p.cap?.alert_at ?? 0.8;
  const ratio = cap ? spent / cap : undefined;
  const state = cap === undefined ? "none" : ratio! >= 1 ? "over" : ratio! >= alert_at ? "warn" : "ok";
  const steps = Object.entries(p.cap?.steps ?? {}).map(([step, c]) => {
    const s = totals(events.filter((e) => e.step === step)).cost;
    return { step, spent: s, cap: c, over: s >= c };
  });
  return { month, currency: p.currency ?? "USD", spent, cap, ratio, state, alert_at, steps };
}

// Why this step may not call its model now, or undefined.
export function pausedReason(root: string, step: string, rules = loadRules(root)): string | undefined {
  const s = capState(root, rules);
  if (s.state === "over") return `paused: this month's model spend cap (${money(s.cap!, s.currency)}) is reached. Raise usage.cap.monthly in rules/policy.yaml or on the dashboard's Usage page`;
  const c = s.steps.find((x) => x.step === step && x.over);
  if (c) return `paused: ${step} reached its monthly cap (${money(c.cap, s.currency)}). Raise usage.cap.steps.${step} in rules/policy.yaml`;
  return undefined;
}

export const money = (n: number, cur = "USD") => `${cur === "USD" ? "$" : `${cur} `}${n < 1 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;
export const fmtMinutes = (seconds: number) => (seconds < 60 ? `${seconds.toFixed(1)} s` : `${(seconds / 60).toFixed(1)} min`);

// ---------- model calls ----------

// Rough token count when a provider reports none (the fake provider, some local servers).
const guess = (s: string) => Math.ceil(s.length / 4);

// Wraps a model so each call is recorded (tokens and wall seconds) and refused once its cap is
// reached. Callers already treat a model error as "held for later" and say so to the owner.
export function metered(root: string, step: string, model: Model, by = "reflect"): Model {
  const guard = () => { const why = pausedReason(root, step); if (why) throw new Error(why); };
  const done = (t0: number, outcome: "ok" | "error", usage: ModelReply["usage"], provider: string, mdl: string, textIn: string, textOut: string) =>
    record(root, { step, by, outcome, provider, model: mdl, tokens_in: usage?.input_tokens ?? guess(textIn), tokens_out: usage?.output_tokens ?? guess(textOut),
      ...(usage ? {} : { estimated: true }), seconds: Math.round((performance.now() - t0) / 10) / 100 }, model.config.model);
  const failed = (t0: number) => done(t0, "error", { input_tokens: 0, output_tokens: 0 }, model.config.provider, model.config.model, "", "");
  const out: Model = {
    config: model.config,
    async complete(req: ModelRequest) {
      guard();
      const t0 = performance.now();
      let r: ModelReply;
      try { r = await model.complete(req); } catch (e) { failed(t0); throw e; }
      done(t0, "ok", r.usage, r.provider, r.model, req.system + req.prompt, r.text);
      return r;
    },
  };
  if (model.decide) out.decide = async (req: DecisionRequest): Promise<DecisionReply> => {
    guard();
    const t0 = performance.now();
    let r: DecisionReply;
    try { r = await model.decide!(req); } catch (e) { failed(t0); throw e; }
    done(t0, "ok", r.usage, r.provider, r.model, req.state + JSON.stringify(req.questions), JSON.stringify(r.answers));
    return r;
  };
  return out;
}

// The model for a step, from rules/models.yaml, metered and capped.
export function modelFor(root: string, step: string, by?: string, opts: Parameters<typeof makeModel>[1] = {}): Model {
  return metered(root, step, makeModel(modelConfigFor(root, step), opts), by);
}

// ---------- telling the owner ----------

// One item when the month crosses the alert line or a cap, for the dashboard. The text channel
// shows only "account notice": its transport is an agent. The key changes with the month and
// the state, so each crossing texts once.
export function usageItem(root: string): { key: string; state: "warn" | "over"; title: string } | undefined {
  const s = capState(root);
  if (s.state === "over") return { key: `usage:over:${s.month}`, state: "over", title: "Model spend reached this month's cap: sleep, the duplicate judge, capture and Ask are paused, and agent mail that needs the request check is held for you. Reads and writes are unaffected. Raise the cap on the Usage page" };
  if (s.state === "warn") return { key: `usage:warn:${s.month}`, state: "warn", title: `Model spend is at ${Math.floor((s.ratio ?? 0) * 100)}% of this month's cap` };
  const over = s.steps.filter((x) => x.over);
  if (over.length) return { key: `usage:step:${s.month}:${over.map((x) => x.step).join(",")}`, state: "over", title: `${over.map((x) => x.step).join(", ")} reached ${over.length > 1 ? "their" : "its"} monthly cap and ${over.length > 1 ? "are" : "is"} paused` };
  return undefined;
}

// Lines for the digest (the owner's only, so amounts are fine there).
export function usageDigest(root: string, since: string): { need: string[]; numbers: string[] } {
  const s = capState(root);
  const need: string[] = [];
  if (s.state === "over") need.push(`- **Model spend cap reached**: ${money(s.spent, s.currency)} of ${money(s.cap!, s.currency)} this month. Sleep, the duplicate judge, capture and Ask are paused, and agent mail that needs the request check is held for you; reads and writes are unaffected. Raise \`usage.cap.monthly\` to resume.`);
  else if (s.state === "warn") need.push(`- **Model spend at ${Math.floor((s.ratio ?? 0) * 100)}% of the cap**: ${money(s.spent, s.currency)} of ${money(s.cap!, s.currency)} this month.`);
  for (const c of s.steps.filter((x) => x.over)) need.push(`- **${c.step} reached its cap** (${money(c.spent, s.currency)} of ${money(c.cap, s.currency)}) and is paused.`);
  const recent = totals(usageEvents(root).filter((e) => e.at >= since));
  const numbers = [`- Model calls since the last digest: ${recent.calls} (${recent.tokens_in + recent.tokens_out}${recent.estimated ? "~" : ""} tokens, ${fmtMinutes(recent.seconds)}): ${money(recent.cost, s.currency)}; this month ${money(s.spent, s.currency)}${s.cap !== undefined ? ` of ${money(s.cap, s.currency)}` : " (no cap set)"}`];
  return { need, numbers };
}
