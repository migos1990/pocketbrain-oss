// SPDX-License-Identifier: AGPL-3.0-only
// What the Brain tab reads for someone who has never seen a fact key: instant search (BM25 on
// the owner's whole view, no model), notes by kind, what changed this week, which facts need a
// look, and who can see a note. Nothing here writes.
import { isDisputed, isList, today, linksIn, type Note, type FactRecord } from "../brain";
import { attributeSpec, isDeclared } from "../rules";
import { factFreshness, daysBetween, lifeOf, type Freshness } from "../freshness";
import { buildIndex, rank, terms } from "../retrieve";
import { isOwnerId } from "../owner";
import { schemeOf, refString } from "../sources";
import type { SourceRef } from "../brain";
import { ownerView } from "./edit-chat";
import { agentLabel } from "./labels";
import { keptFor, type State } from "./data";

// Folders in reading order, with the word a beginner uses for each.
export const KINDS: [string, string][] = [["people", "People"], ["projects", "Projects"], ["orgs", "Organisations"], ["money", "Money"], ["decisions", "Decisions"], ["notes", "Notes"], ["agents", "Assistants' notes"]];
export const kindLabel = (folder: string) => KINDS.find(([f]) => f === folder)?.[1] ?? folder;
export const folderOf = (id: string) => id.split("/")[0];

export const browsable = (s: State) => s.notes.filter((n) => folderOf(n.fm.id) !== "disputes");

export function kindCounts(s: State): { folder: string; label: string; count: number }[] {
  const count = new Map<string, number>();
  for (const n of browsable(s)) { const f = folderOf(n.fm.id); count.set(f, (count.get(f) ?? 0) + 1); }
  const order = (f: string) => { const i = KINDS.findIndex(([k]) => k === f); return i < 0 ? 99 : i; };
  return [...count.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((f) => ({ folder: f, label: kindLabel(f), count: count.get(f)! }));
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
  // The owner's view and its rules kept together while the brain is the same, so the search
  // index (cached per view, src/retrieve.ts) is built once, not on every key typed.
  const v = keptFor(s.root, "owner-view", s.version, () => ({ res: ownerView(s.root, s.notes, s.rules), rules: s.rules }));
  return rank(buildIndex(v.res, v.rules), q, limit)
    .filter((h) => byId.has(h.id) && folderOf(h.id) !== "disputes")
    .map((h) => ({ note: byId.get(h.id)!, match: h.match }));
}

// The owner's search by name alone: every word of the query in a page's title or an alias, accents
// and case aside. No value is read, so it may run on the 30-day sign-in (G542).
const fold = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
export function byTitle(notes: Note[], q: string, limit = 20): Note[] {
  const words = queryWords(fold(q));
  if (!words.length) return [];
  return notes.filter((n) => { const names = fold([n.fm.title ?? "", ...(n.fm.aliases ?? [])].join(" ")); return words.every((w) => names.includes(w)); })
    .sort((a, b) => String(a.fm.title).localeCompare(String(b.fm.title))).slice(0, limit);
}

// Words of the query worth marking in a snippet.
export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 || /\d/.test(w)))];
}

export interface Change { id: string; attr?: string; who: string; at: string; why: string }

// Why a fact changed, in words and never its value: who edited it, or where it was filed from.
function changeWhy(s: State, id: string, attr: string | undefined, w: { agent?: unknown; kind?: unknown }): string {
  const agent = String(w.agent ?? "");
  if (String(w.kind ?? "").startsWith("owner-") || isOwnerId(agent, s.rules.policy.owner?.name)) return "edited by you";
  const label = agentLabel(s.rules, agent);
  if (s.rules.policy.agents[agent]?.role === "gardener") return `tidied by ${label}`;
  const note = s.notes.find((n) => n.fm.id === id);
  const f = attr ? note?.fm.facts?.[attr] : undefined;
  const recs = !f ? [] : isList(f) ? f.items : [f as FactRecord];
  const from = sourceWords(recs.flatMap((r) => r.sources ?? []).filter((x) => !/^(agent|agent-relay|agent-log):/.test(refString(x))));
  return from ? `filed from ${from}` : `noted by ${label}`;
}

// Saved writes from the last week, newest first, one line per fact.
export function recentChanges(s: State, days = 7, limit = 8): Change[] {
  const since = new Date(s.now.getTime() - days * 86_400_000).toISOString();
  const ids = new Set(s.notes.map((n) => n.fm.id));
  const seen = new Set<string>();
  const out: Change[] = [];
  for (const w of [...s.writes].sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
    if (w.outcome !== "committed" || String(w.at) < since) continue;
    const [id, attr] = String(w.key ?? "").split("#");
    // A source check (confirm, due again) changed nothing: it is the trust audit's, not a change
    // (Mac phone pass, 2026-10-25: the list was all "hub updated …").
    if (w.kind === "source-confirm" || w.kind === "source-due") continue;
    if (!ids.has(id) || folderOf(id) === "disputes" || seen.has(String(w.key))) continue;
    seen.add(String(w.key));
    out.push({ id, attr, who: String(w.agent ?? ""), at: String(w.at), why: changeWhy(s, id, attr, w) });
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

// How a fact ages, in a few plain words for its page (memory-graph.md item 5): "doesn't go out of
// date" for a kind that has no shelf life, "check again in Mar 2027" for one that does, and
// nothing for a kind nobody declared or a fact already out of date (that has its own words).
export function lifeWords(s: State, n: Note, attr: string, r: FactRecord): string | undefined {
  const l = lifeOf(r, attributeSpec(s.rules, n.fm.type, attr), isDeclared(s.rules, n.fm.type, attr));
  if (!l) return undefined;
  if (l.kind === "fixed") return "doesn't go out of date";
  if (l.kind === "latest") return "changes over time; the newest is kept";
  if (!l.by || ["stale", "due"].includes(freshnessOf(s, n, attr, r))) return undefined;
  const [y, m] = l.by.split("-").map(Number);
  return `check again in ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
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

const SOURCE_WORDS: Record<string, string> = { gmail: "an email", mail: "an email", calendar: "your calendar", gcal: "your calendar", notion: "Notion", url: "a web page", web: "a web page", drive: "a document", doc: "a document", owner: "you", louis: "you", approved: "you approved", "instinct-mem": "Instinct's memory", "town-wiki": "Town's wiki", "town-routine": "a Town routine", agent: "an assistant", "agent-relay": "an assistant's message", "agent-log": "an assistant's log" };

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
  // Who links to whom, built once per brain version: scanning every note per page was most of it.
  const backlinks = keptFor(s.root, "backlinks", s.version, () => {
    const m = new Map<string, Note[]>();
    for (const x of browsable(s)) for (const id of linksOf(x)) (m.get(id) ?? m.set(id, []).get(id)!).push(x);
    return m;
  });
  const mentionedIn = (backlinks.get(n.fm.id) ?? []).filter((x) => x.fm.id !== n.fm.id);
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
