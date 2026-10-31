// SPDX-License-Identifier: AGPL-3.0-only
// Can the owner trust the brain? (`pocketbrain audit trust`, the Settings page's memory line;
// docs/trust.md.) Every live fact lands in one of three buckets:
//   - needs a look: its source no longer says it or is gone, it is stale, it was a guess, or it
//     looks private (health, school, legal, money) and an assistant below private can read it;
//   - checked: the owner's word, or the hub itself read the item it cites and found the value
//     there (a `source-confirm` line in log/writes.jsonl since the value was recorded). A
//     `verified-by-source` label alone is a claim, not a check: agents and imports can set it;
//   - not checked yet: everything else.
// Plus why facts have no live source, how many the nightly backfill can still search for, how
// many changes each assistant hasn't confirmed seeing, and the owner's spot checks (the /spot page
// is gone, outside review v5; its log still counts for 30 days).
// Deterministic, no model, nothing written to the brain. Counts only: no value, title, note id or
// address is ever in a line this file prints.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isList, loadBrain, sensitivityRank, today, type FactRecord, type Note } from "./brain";
import { loadRules, attributeSpec, ownerName, type Rules } from "./rules";
import { recordFreshness } from "./freshness";
import { hasLiveSource, liveRecords } from "./health";
import { refString, schemeOf, SCHEMES, isExactLouisRef } from "./sources";
import { isOwnerConfirmed } from "./owner";
import { idOfRef, fetchOne, recheckFacts, sampleRefs } from "./pull";
import { verifyLog } from "./evidence";
import { carve, grantFor, records, visibleFacts } from "./carve";
import { categoryWords, SENSITIVE_WORDS } from "./checks";
import { hasWord, readJsonl, appendJsonl } from "./util";
import { unseenChanges, state as syncState, syncOn } from "./memsync";
import { searchable } from "./backfill";

export type Problem = "source-says-otherwise" | "stale" | "guessed" | "private-shown";
export interface FactTrust { key: string; note: Note; attr: string; r: FactRecord; checked?: "owner" | "hub"; problems: Problem[]; unsourced?: Unsourced }
export type Unsourced = "gone" | "changed" | "vague" | "assistant" | "none";

export interface TrustReport {
  date: string;
  facts: number;
  checked: number;          // no problem, and the owner's word or the hub's own read stands behind it
  look: number;             // at least one problem
  unchecked: number;        // the rest
  by: { owner: number; hub: number };
  problems: Record<Problem, number>;
  unsourced: Record<Unsourced, number> & { total: number; searchable: number };
  behind: { agent: string; changes: number }[]; // agents with a sync baseline and changes they haven't confirmed
  spot: { right: number; wrong: number; last?: string };
}

const SPOT_LOG = (root: string) => join(root, "log", "spot-check.jsonl");
// One answer: the owner's day it was given (today(), so PB_TODAY pins it), the fact, the verdict.
interface SpotRow { at?: string; day?: string; key?: string; verdict?: string }
const spotDay = (x: SpotRow) => String(x.day ?? x.at ?? "").slice(0, 10);
const TRUST_LOG = (root: string) => join(root, "log", "trust.jsonl");
export const SPOT_DAYS = 30;

// The hub's own reads that found a fact's value in the item it cites: fact key -> [day, item id].
function hubConfirms(root: string): Map<string, { day: string; id: string }[]> {
  const out = new Map<string, { day: string; id: string }[]>();
  const f = join(root, "log", "writes.jsonl");
  if (!existsSync(f)) return out;
  for (const e of readJsonl<{ at?: string; agent?: string; kind?: string; key?: string; outcome?: string; source?: string }>(f)) {
    if (e.kind !== "source-confirm" || e.outcome !== "committed" || e.agent !== "hub" || typeof e.key !== "string" || typeof e.source !== "string" || typeof e.at !== "string") continue;
    out.set(e.key, [...(out.get(e.key) ?? []), { day: e.at.slice(0, 10), id: idOfRef(e.source) }]);
  }
  return out;
}

const ownerWord = (r: FactRecord) => isOwnerConfirmed(r.verification) || r.verification === "confirmed-by-co-owner" || (r.sources ?? []).map(refString).some(isExactLouisRef);
const kindOf = (ref: string) => SCHEMES[schemeOf(ref) ?? ""] ?? "none";

// A guess: the writer said it inferred it, or nothing at all stands behind it, or only another
// assistant's passing word (agent-relay, ranked below everything else in src/sources.ts).
function guessed(r: FactRecord): boolean {
  if (r.confidence === "inferred") return true;
  const refs = (r.sources ?? []).map(refString);
  if (!refs.length || refs.every((x) => kindOf(x) === "none")) return true;
  return refs.every((x) => schemeOf(x) === "agent-relay");
}

function whyUnsourced(r: FactRecord): Unsourced {
  if (r.recheck) return /gone/.test(r.recheck.why) ? "gone" : "changed";
  const kinds = (r.sources ?? []).map((s) => kindOf(refString(s)));
  if (kinds.includes("vague") || kinds.includes("exact")) return "vague"; // an exact ref the hub flagged is a recheck, above
  if (kinds.includes("self") || kinds.includes("louis")) return "assistant"; // a dated owner range (imsg:a..b) is vague words, not a message
  return "none";
}

// Words that make a fact private whoever reads it: health, school, legal or money about another
// person (the write path forces those private: checks.ts thirdPartySensitive), and money words
// (rules/checks.yaml categories) or an amount on any note.
const AMOUNT = /[$€£¥]\s?\d|\d\s?([$€£¥]|eur|usd|cad|chf|gbp)(?!\p{L})/iu;
export function privateShape(rules: Rules, n: Note, attr: string, value: unknown): boolean {
  const text = `${attr.replace(/_/g, " ")} ${typeof value === "string" ? value : JSON.stringify(value ?? "")}`.normalize("NFC");
  if (n.fm.type === "money" || /^money\//.test(n.fm.id) || (n.fm.tags ?? []).includes("finance")) return true;
  const person = n.fm.type === "person" || n.fm.id.startsWith("people/");
  if (person && String(n.fm.title ?? "").trim().toLowerCase() !== ownerName(rules).trim().toLowerCase() && SENSITIVE_WORDS.test(text)) return true;
  return AMOUNT.test(text) || (categoryWords(rules.checks).money ?? []).some((w) => hasWord(text, w));
}

// Facts that look private and that some assistant below private can read: fact key -> agents.
function shownPrivate(notes: Note[], rules: Rules): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [agent, a] of Object.entries(rules.policy.agents ?? {})) {
    if ((a as { inside_wall?: boolean }).inside_wall) continue;
    let res;
    try { res = carve(notes, rules, grantFor(rules, agent)); } catch { continue; }
    if (sensitivityRank(res.grant.ceiling) >= sensitivityRank("private")) continue;
    for (const v of res.visible.values()) for (const [attr, f] of visibleFacts(v, res)) {
      if (!records(f).some((r) => !r.valid_to && !r.retired && privateShape(rules, v.note, attr, r.value))) continue;
      const key = `${v.note.fm.id}#${attr}`;
      out.set(key, [...(out.get(key) ?? []), agent]);
    }
  }
  return out;
}

// One verdict per live fact on an active content note.
export function factTrust(root: string, notes: Note[] = loadBrain(root), now = today()): FactTrust[] {
  const rules = loadRules(root);
  const confirms = hubConfirms(root);
  const shown = shownPrivate(notes, rules);
  const out: FactTrust[] = [];
  for (const n of notes) {
    if (n.fm.type === "dispute" || n.fm.status !== "active") continue;
    for (const { attr, r } of liveRecords(n)) {
      const key = `${n.fm.id}#${attr}`;
      const problems: Problem[] = [];
      if (r.recheck) problems.push("source-says-otherwise");
      if (recordFreshness(r, attributeSpec(rules, n.fm.type, attr), now) === "stale") problems.push("stale");
      if (guessed(r) && !ownerWord(r)) problems.push("guessed");
      if (shown.has(key) && privateShape(rules, n, attr, r.value)) problems.push("private-shown");
      const ids = new Set((r.sources ?? []).map((s) => idOfRef(refString(s))));
      const since = String(r.recorded ?? r.as_of ?? "");
      const hub = (confirms.get(key) ?? []).some((c) => c.day >= since && ids.has(c.id));
      const checked = ownerWord(r) ? "owner" : hub ? "hub" : undefined;
      out.push({ key, note: n, attr, r, ...(checked ? { checked } : {}), problems, ...(hasLiveSource(r) ? {} : { unsourced: whyUnsourced(r) }) });
    }
  }
  return out;
}

function spotTally(root: string, now: string): TrustReport["spot"] {
  const from = new Date(Date.parse(`${now}T00:00:00Z`) - (SPOT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = readJsonl<SpotRow>(SPOT_LOG(root)).filter((x) => spotDay(x) >= from && spotDay(x) <= now);
  return { right: rows.filter((x) => x.verdict === "right").length, wrong: rows.filter((x) => x.verdict === "wrong").length, ...(rows.length ? { last: spotDay(rows.at(-1)!) } : {}) };
}

export function trustReport(root: string, opts: { notes?: Note[]; now?: string } = {}): TrustReport {
  const now = opts.now ?? today();
  const notes = opts.notes ?? loadBrain(root);
  const all = factTrust(root, notes, now);
  const rules = loadRules(root);
  const problems = { "source-says-otherwise": 0, stale: 0, guessed: 0, "private-shown": 0 } as Record<Problem, number>;
  const unsourced = { gone: 0, changed: 0, vague: 0, assistant: 0, none: 0, total: 0, searchable: 0 };
  let look = 0, checked = 0;
  const by = { owner: 0, hub: 0 };
  for (const f of all) {
    for (const p of f.problems) problems[p]++;
    if (f.problems.length) look++;
    else if (f.checked) { checked++; by[f.checked]++; }
    if (f.unsourced) {
      unsourced[f.unsourced]++;
      unsourced.total++;
      if (searchable(f.note, f.r)) unsourced.searchable++;
    }
  }
  const s = syncState(root);
  const behind: TrustReport["behind"] = [];
  if (syncOn(rules, "change_feed")) for (const agent of Object.keys(rules.policy.agents ?? {})) {
    const n = (() => { try { return unseenChanges(root, agent, s); } catch { return undefined; } })();
    if (n !== undefined) behind.push({ agent, changes: n });
  }
  return { date: now, facts: all.length, checked, look, unchecked: all.length - checked - look, by, problems, unsourced, behind, spot: spotTally(root, now) };
}

// The home page's line (src/dashboard/html.ts), plain words, counts only.
export function trustLine(t: TrustReport): string {
  return `${t.checked} checked against their source, ${t.look} need${t.look === 1 ? "s" : ""} a look${t.unchecked ? `, ${t.unchecked} not checked yet` : ""}.`;
}

// Settings says one number (Clearer decision cards, 2026-10-25: the wall is at its word budget).
export function homeTrustLine(t: TrustReport): string {
  return t.look ? `${t.look} need${t.look === 1 ? "s" : ""} a look.` : "Nothing needs a look.";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export function trustText(t: TrustReport, weekAgo?: TrustRow): string {
  const was = weekAgo ? ` (a week ago: ${weekAgo.checked} checked, ${weekAgo.look} to look at)` : "";
  const sp = t.spot.right + t.spot.wrong;
  return [
    `Trust: ${plural(t.facts, "fact")}. ${trustLine(t)}${was}`,
    `  Checked: ${t.by.owner} on your word, ${t.by.hub} the hub read the source and it says this.`,
    `  Need a look: ${t.problems["source-says-otherwise"]} the source no longer says it or is gone, ${t.problems.stale} stale, ${t.problems.guessed} guessed, ${t.problems["private-shown"]} look private and an assistant below private can read them.`,
    `  No live source: ${t.unsourced.total} (${t.unsourced.vague} only a vague pointer such as an import, ${t.unsourced.assistant} only an assistant's word, ${t.unsourced.none} nothing at all, ${t.unsourced.gone + t.unsourced.changed} source gone or changed). ${t.unsourced.searchable} can be searched for in your mail; the nightly pass tries 20.`,
    `  Assistants behind: ${t.behind.length ? t.behind.map((b) => `${b.agent} ${b.changes}`).join(", ") + " change(s) not confirmed seen" : "none checked in yet"}.`,
    `  Spot checks, ${SPOT_DAYS} days: ${sp ? `${t.spot.right} right, ${t.spot.wrong} wrong (last ${t.spot.last})` : "none"}.`,
  ].join("\n");
}

// One row a day in log/trust.jsonl, so the report can say what changed in a week.
export type TrustRow = Pick<TrustReport, "date" | "facts" | "checked" | "look" | "unchecked"> & { unsourced: number };
export function recordTrust(root: string, t: TrustReport): TrustRow | undefined {
  const rows = readJsonl<TrustRow>(TRUST_LOG(root));
  if (!rows.some((r) => r.date === t.date)) appendJsonl(TRUST_LOG(root), { date: t.date, facts: t.facts, checked: t.checked, look: t.look, unchecked: t.unchecked, unsourced: t.unsourced.total } satisfies TrustRow);
  const week = new Date(Date.parse(`${t.date}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  return rows.filter((r) => r.date <= week).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
}

// ---------- a sweep, by hand ----------
// `audit trust --check N`: read up to N cited items now, the ones checked longest ago first, and
// check every live fact citing each against the item's own words (recheckFacts in src/pull.ts,
// the nightly recheck's own step: still said -> last_confirmed today; not said or gone -> due,
// with the reason). The value never changes. Hub only; a replica's recheckFacts does nothing.
export async function sweep(root: string, max: number): Promise<{ read: number; confirmed: number; due: number; unreachable: number }> {
  const out = { read: 0, confirmed: 0, due: 0, unreachable: 0 };
  for (const ref of sampleRefs(root).slice(0, Math.max(0, max))) {
    let it: Awaited<ReturnType<typeof fetchOne>>;
    try { it = await fetchOne(root, ref); } catch (e) { it = (e as Error).message; }
    out.read++;
    const at = new Date().toISOString();
    if (typeof it === "string") { out.unreachable++; appendJsonl(verifyLog(root), { at, agent: "hub", ref, result: "unreachable" }); continue; }
    const r = recheckFacts(root, ref, it.gone ? null : [it.subject, it.text].filter(Boolean).join("\n"));
    out.confirmed += r.confirmed.length;
    out.due += r.due.length;
    appendJsonl(verifyLog(root), { at, agent: "hub", ref, result: it.gone ? "gone" : r.confirmed.length ? "match" : "no-match" });
  }
  return out;
}
