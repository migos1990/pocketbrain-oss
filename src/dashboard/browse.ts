// SPDX-License-Identifier: AGPL-3.0-only
// What the Brain tab reads for someone who has never seen a fact key: instant search (BM25 on
// the owner's whole view, no model), notes by kind, what changed this week, which facts need a
// look, and who can see a note. Nothing here writes.
import { isDisputed, isList, today, linksIn, type Note, type FactRecord } from "../brain";
import { attributeSpec } from "../rules";
import { factFreshness, daysBetween, type Freshness } from "../freshness";
import { buildIndex, rank, terms } from "../retrieve";
import { isOwnerId } from "../owner";
import { schemeOf, refString } from "../sources";
import type { SourceRef } from "../brain";
import { ownerView } from "./ask";
import { agentLabel } from "./labels";
import type { State } from "./data";

// Folders in reading order, with the word a beginner uses for each.
export const KINDS: [string, string][] = [["people", "People"], ["projects", "Projects"], ["orgs", "Organisations"], ["money", "Money"], ["decisions", "Decisions"], ["notes", "Notes"], ["agents", "Agents"]];
export const kindLabel = (folder: string) => KINDS.find(([f]) => f === folder)?.[1] ?? folder;
export const folderOf = (id: string) => id.split("/")[0];

export const browsable = (s: State) => s.notes.filter((n) => folderOf(n.fm.id) !== "disputes");

export function kindCounts(s: State): { folder: string; label: string; count: number }[] {
  const notes = browsable(s);
  const folders = [...new Set(notes.map((n) => folderOf(n.fm.id)))];
  const order = (f: string) => { const i = KINDS.findIndex(([k]) => k === f); return i < 0 ? 99 : i; };
  return folders.sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((f) => ({ folder: f, label: kindLabel(f), count: notes.filter((n) => folderOf(n.fm.id) === f).length }));
}

// Outside agents that get this note, and the ones that don't.
export function audience(s: State, id: string): { seen: string[]; unseen: string[] } {
  const seen: string[] = [], unseen: string[] = [];
  for (const a of s.agents) (s.carves.get(a.name)?.visible.has(id) ? seen : unseen).push(a.name);
  return { seen, unseen };
}

export interface SearchHit { note: Note; match: string }

// The owner's search as you type: every note, no model, nothing leaves the Mac.
export function searchNotes(s: State, q: string, limit = 12): SearchHit[] {
  if (!terms(q).length) return [];
  const byId = new Map(s.notes.map((n) => [n.fm.id, n]));
  return rank(buildIndex(ownerView(s.root), s.rules), q, limit)
    .filter((h) => byId.has(h.id) && folderOf(h.id) !== "disputes")
    .map((h) => ({ note: byId.get(h.id)!, match: h.match }));
}

// Words of the query worth marking in a snippet.
export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 || /\d/.test(w)))];
}

export interface Change { id: string; attr?: string; who: string; at: string }

// Saved writes from the last week, newest first, one line per fact.
export function recentChanges(s: State, days = 7, limit = 8): Change[] {
  const since = new Date(s.now.getTime() - days * 86_400_000).toISOString();
  const ids = new Set(s.notes.map((n) => n.fm.id));
  const seen = new Set<string>();
  const out: Change[] = [];
  for (const w of [...s.writes].sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
    if (w.outcome !== "committed" || String(w.at) < since) continue;
    const [id, attr] = String(w.key ?? "").split("#");
    if (!ids.has(id) || folderOf(id) === "disputes" || seen.has(String(w.key))) continue;
    seen.add(String(w.key));
    out.push({ id, attr, who: String(w.agent ?? ""), at: String(w.at) });
    if (out.length >= limit) break;
  }
  return out;
}

export interface Stale { note: Note; attr: string; value: unknown; fresh: Freshness; checked: string }

// Single-value facts past their shelf life: the forgetting system asking "still true?".
export function needsLook(s: State, limit = 8): Stale[] {
  const now = today();
  const out: Stale[] = [];
  for (const n of browsable(s)) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (isList(f) || isDisputed(f)) continue;
    const r = f as FactRecord;
    if (r.retired || r.valid_to) continue;
    const fresh = factFreshness(r, attributeSpec(s.rules, n.fm.type, attr), now);
    if (fresh === "stale" || fresh === "due") out.push({ note: n, attr, value: r.value, fresh, checked: r.last_confirmed ?? r.as_of });
  }
  return out.sort((a, b) => a.checked.localeCompare(b.checked)).slice(0, limit);
}

export function freshnessOf(s: State, n: Note, attr: string, r: FactRecord): Freshness {
  return factFreshness(r, attributeSpec(s.rules, n.fm.type, attr), today());
}

// "3 days ago", "today", "4 months ago" from a date.
export function sinceDate(date: string | undefined): string {
  if (!date || !/^\d{4}/.test(date)) return "at an unknown date";
  const d = daysBetween(date, today());
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 45) return `${d} days ago`;
  if (d < 540) return `${Math.round(d / 30)} months ago`;
  return `${Math.round(d / 365)} years ago`;
}

const SOURCE_WORDS: Record<string, string> = { gmail: "an email", mail: "an email", calendar: "your calendar", gcal: "your calendar", notion: "Notion", url: "a web page", web: "a web page", drive: "a document", doc: "a document", owner: "you", louis: "you", "instinct-mem": "Instinct's memory", "town-wiki": "Town's wiki", "town-routine": "a Town routine", agent: "an agent", "agent-relay": "an agent's message", "agent-log": "an agent's log" };

// Where a fact came from, in words: "an email", "your calendar and an email".
export function sourceWords(sources: SourceRef[] | undefined): string {
  const words = [...new Set((sources ?? []).map((x) => { const ref = refString(x); const sc = schemeOf(ref) ?? ref.match(/^([a-z][a-z-]*):/)?.[1] ?? ""; return SOURCE_WORDS[sc] ?? (sc ? sc.replace(/-/g, " ") : "a source"); }))];
  return words.length ? words.join(" and ") : "";
}

// "you" for the owner, else the agent's name.
export function who(s: State, by: string | undefined): string {
  if (!by) return "someone";
  return isOwnerId(by, s.rules.policy.owner?.name) ? "you" : agentLabel(s.rules, by);
}

// Who gets one fact: agents that see the note, minus those the fact is carved out for.
export function factAudience(s: State, id: string, attr: string): string[] {
  const key = `${id}#${attr}`;
  return s.agents.map((a) => a.name).filter((a) => { const c = s.carves.get(a); return c?.visible.has(id) && !c.hiddenFacts.some((h) => h.key === key); });
}

export interface SourceUse { ref: string; words: string; attrs: string[]; dated: string; url?: string }
export interface Connections { replacedBy?: string; replaces: string[]; mergedInto?: string; mentionedIn: Note[]; linksTo: Note[]; sources: SourceUse[] }

// A Gmail message id opens in Gmail; other refs have no address we can trust.
function sourceUrl(ref: string): string | undefined {
  const m = ref.match(/^gmail:([0-9a-f]{16})$/);
  return m ? `https://mail.google.com/mail/u/0/#all/${m[1]}` : undefined;
}

// Links between notes that the brain itself records: replaced-by, merges, [[links]] both ways,
// and the sources each fact cites. Nothing is guessed; a connection exists only if a note says so.
export function connections(s: State, n: Note): Connections {
  const fm = n.fm as Note["fm"] & { superseded_by?: string; supersedes?: string | string[]; merged_into?: string };
  const byId = new Map(s.notes.map((x) => [x.fm.id, x]));
  const linksOf = (x: Note) => new Set([...linksIn(x.body), ...linksIn(JSON.stringify(x.fm.facts ?? {}))]);
  const linksTo = [...linksOf(n)].filter((id) => id !== n.fm.id && byId.has(id)).map((id) => byId.get(id)!);
  const mentionedIn = browsable(s).filter((x) => x.fm.id !== n.fm.id && linksOf(x).has(n.fm.id));
  const sources = new Map<string, SourceUse>();
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    const recs = isList(f) ? f.items.filter((i) => !i.valid_to) : isDisputed(f) ? f.candidates : [f as FactRecord];
    for (const r of recs) for (const x of r.sources ?? []) {
      const ref = refString(x);
      if (/^(owner|louis):/.test(ref)) continue; // the owner's own word shows as "your word" on the fact
      const u = sources.get(ref) ?? { ref, words: sourceWords([ref]), attrs: [], dated: r.as_of, url: sourceUrl(ref) };
      if (!u.attrs.includes(attr)) u.attrs.push(attr);
      if (r.as_of && r.as_of < u.dated) u.dated = r.as_of;
      sources.set(ref, u);
    }
  }
  return {
    replacedBy: fm.superseded_by ? String(fm.superseded_by) : undefined,
    replaces: [fm.supersedes ?? []].flat().map(String).filter(Boolean),
    mergedInto: fm.merged_into ? String(fm.merged_into) : undefined,
    mentionedIn, linksTo, sources: [...sources.values()].sort((a, b) => a.dated.localeCompare(b.dated)),
  };
}
