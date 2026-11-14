// SPDX-License-Identifier: AGPL-3.0-only
// The leak oracle. It decides what each agent must never receive, straight from Robin's
// intent in rules/ (excluded types, sensitivity ceiling, per-fact share_with and sensitivity,
// canaries) and the owner's Show (a record still `unseen` reaches nobody), WITHOUT calling the prototype's carve code, so a bug there can't hide itself.
// "Not granted" (merely outside an agent's slices) is not a leak; "carved out" is.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadPB } from "./pb";

const RANK = ["public", "personal", "private", "secret"];
const rank = (s?: string) => RANK.indexOf(s ?? "personal");
const STOP = new Set(["active", "ended", "done", "open", "closed", "true", "false", "yes", "no", "unknown", "daily", "weekly", "comp", "account", "checklist"]);

export interface Forbidden { value: string; from: string }

function recordsOf(f: any): any[] {
  if (!f || typeof f !== "object") return [];
  if (Array.isArray(f.items)) return f.items;
  if (Array.isArray(f.candidates)) return f.candidates;
  return [f];
}

function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

export function distinctive(s: string): boolean {
  const t = s.trim();
  return t.length >= 4 && !STOP.has(t.toLowerCase()) && !/^\d{4}(-\d{2}){0,2}$/.test(t) && !/^[a-z]+$/.test(t) && !/^\[\[/.test(t) && !/^https?:/.test(t);
}

export function relayConfig(root: string): any {
  const f = join(root, "rules", "relay.yaml");
  return existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) : { agents: {}, canaries: [] };
}

// The agent's carve as Robin wrote it: its ceiling (a reader token is capped at personal, as
// src/tokenrole.ts says the token can see), excluded types and notes, and whether a note is out.
function intentFor(root: string, agent: string, role?: "reader") {
  const policy = YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8"));
  const a = policy.agents?.[agent] ?? { tier: "trial" };
  const tier = policy.tiers?.[a.tier] ?? { max_sensitivity: a.tier === "core" ? "private" : "personal" };
  let ceiling: string = a.max_sensitivity ?? tier.max_sensitivity;
  if (role === "reader" && rank(ceiling) > rank("personal")) ceiling = "personal";
  const excludedTypes: string[] = a.exclude_types ?? [];
  const excludedNotes: string[] = a.exclude ?? [];
  const noteOut = (n: any) => excludedTypes.some((t) => t === String(n.fm.id).split("/")[0] || t === n.fm.type) || excludedNotes.includes(n.fm.id) || rank(n.fm.sensitivity) > rank(ceiling)
    || (n.fm.share && Array.isArray(n.fm.share.deny) && n.fm.share.deny.includes(agent));
  // A value the owner hasn't seen yet (`unseen`: a contact card's email or phone, an assistant's
  // private value) is held from every agent until the owner's Show (docs/sources-pull.md#contacts).
  const factOut = (r: any) => r.unseen === true || (Array.isArray(r.share_with) && !r.share_with.includes(agent)) || (r.sensitivity && rank(r.sensitivity) > rank(ceiling));
  return { noteOut, factOut };
}

export async function forbiddenFor(root: string, agent: string, opts: { role?: "reader" } = {}): Promise<Forbidden[]> {
  const pb = await loadPB();
  const { noteOut, factOut } = intentFor(root, agent, opts.role);
  const out = new Map<string, string>();
  const add = (v: string, from: string) => { if (distinctive(v)) out.set(v.trim(), from); };
  for (const n of pb.brain.loadBrain(root)) {
    const id: string = n.fm.id;
    if (id.split("/")[0] === "agents") continue; // tool names aren't secrets
    const out_ = noteOut(n);
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      for (const r of recordsOf(f)) if (out_ || factOut(r)) for (const s of strings(r.value)) add(s, `${id}#${attr}`);
    }
  }
  return [...out.entries()].map(([value, from]) => ({ value, from }));
}

// Notes carved out for the agent as a whole, and the facts carved out of the others: each with
// what names or dates it (id, title, aliases, created/updated, each record's as_of). The carve
// property (test/carve-property.test.ts) checks none of these reaches the agent; a date counts
// only if no note or fact the agent may see carries it too.
export interface Carved { id: string; names: string[]; dates: string[]; whole: boolean }
export async function carvedFor(root: string, agent: string, opts: { role?: "reader" } = {}): Promise<{ carved: Carved[]; shownDates: Set<string> }> {
  const pb = await loadPB();
  const { noteOut, factOut } = intentFor(root, agent, opts.role);
  const carved: Carved[] = [];
  const shownDates = new Set<string>();
  const day = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v ?? "")).slice(0, 10);
  for (const n of pb.brain.loadBrain(root)) {
    const id: string = n.fm.id;
    if (id.split("/")[0] === "agents") continue;
    const whole = noteOut(n);
    const noteDates = [n.fm.created, n.fm.updated].filter(Boolean).map(day);
    if (whole) carved.push({ id, names: [n.fm.title, ...(n.fm.aliases ?? [])].filter(Boolean).map(String), dates: noteDates, whole: true });
    else noteDates.forEach((d) => shownDates.add(d));
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) for (const r of recordsOf(f)) {
      if (!whole && factOut(r)) carved.push({ id: `${id}#${attr}`, names: [], dates: r.as_of ? [day(r.as_of)] : [], whole: false });
      else if (!whole && r.as_of) shownDates.add(day(r.as_of));
    }
  }
  return { carved, shownDates };
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Exact (case-insensitive, word-bounded) hits, plus "squashed" hits that survive spacing,
// punctuation and number formatting tricks (M-a-p-l-e T.r.u.s.t, 412,500).
export function findLeaks(text: string, forbidden: Forbidden[]): { value: string; from: string; how: "exact" | "obfuscated" }[] {
  return leakFinder(forbidden)(text);
}

// The same matcher with each value's pattern built once, for a caller that checks many texts
// against one list (the carve property reads every door for every reader).
export function leakFinder(forbidden: Forbidden[]): (text: string) => { value: string; from: string; how: "exact" | "obfuscated" }[] {
  const each = forbidden.map((f) => {
    const v = norm(f.value);
    let sq = v.replace(/[^a-z0-9]/g, "");
    if (/^[a-z]{3} \d+\.00$/.test(v)) sq = v.replace(/^[a-z]{3} /, "").replace(/\.00$/, ""); // CAD 412500.00 -> 412500
    return { f, v, sq, re: new RegExp(`(^|[^\\p{L}\\p{N}])${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u") };
  });
  return (text) => {
    const t = norm(text);
    let squashed: string | undefined;
    const hits: { value: string; from: string; how: "exact" | "obfuscated" }[] = [];
    for (const { f, v, sq, re } of each) {
      // The pattern can only match where the value itself is: one plain look first.
      if (t.includes(v) && re.test(t)) { hits.push({ ...f, how: "exact" }); continue; }
      if (sq.length >= 6 && (squashed ??= t.replace(/[^a-z0-9]/g, "")).includes(sq)) hits.push({ ...f, how: "obfuscated" });
    }
    return hits;
  };
}

// Redact a value for reports: keep the fact key, never print Robin's data.
export function redact(v: string): string {
  return v.length <= 4 ? "****" : `${v.slice(0, 2)}…(${v.length})`;
}
