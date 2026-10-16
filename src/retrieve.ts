// SPDX-License-Identifier: AGPL-3.0-only
// Ranked retrieval over one agent's carve (retrieval-capture.md section 2). Replaces the
// substring scan in core.ts with BM25 over what the agent would actually be shown:
// everything is indexed from renderNote() output, so carved facts, [withheld] values and
// [[redacted]] links never enter the index, and term statistics come from the visible
// notes only (a hidden note can't shift a score, so ranking can't hint that it exists).
//
// Two things the old scan lacked, both measured on the real brain:
// - folding: accents, plurals and a short prefix stem, so "sécurité" meets "Securite" and
//   "moderate" meets "moderation", and stop words no longer match everywhere;
// - chunks: context_pack returns each hit's header and facts plus only the paragraphs or
//   list items that match, instead of whole append-only log notes.
import type { Rules } from "./rules";
import type { CarveResult, Visible } from "./carve";
import { renderNote, needlesOf } from "./view";
import { today, type Note } from "./brain";
import { records, shownUpdated, visibleFacts } from "./carve";
import { daysBetween } from "./freshness";
import { LEXICON } from "./lexicon";

const STOP = new Set((
  "a an and are as at be by can could did do does for from had has have how i if in into is it its me my " +
  "of on or our so that the their them then there these they this to us was we were what when where which " +
  "who whom why will with you your about any get got still should would just also not no yes " +
  "le la les un une des du de d l et ou est sont a au aux en dans pour par sur avec ce cette ces qui que quoi " +
  "quand ou comment mon ma mes notre nos son sa ses il elle on nous vous je j y ne pas plus"
).split(" "));

// A small bilingual synonym table. Kept short and generic on purpose: it is the cheap,
// explainable alternative to embeddings, and anything longer belongs in a note's aliases.
const SYNONYMS: string[][] = [
  ["salary", "pay", "compensation", "comp", "salaire", "remuneration"],
  ["kid", "child", "children", "daughter", "son", "fille", "enfant"],
  ["wife", "husband", "spouse", "femme", "epouse", "mari"],
  ["tfsa", "celi"], ["rrsp", "reer"],
  ["course", "cours", "class", "seance", "lecture", "teaching"],
  ["exam", "examen", "midterm", "intra"],
  ["deadline", "due", "echeance", "limite"],
  ["schedule", "horaire", "calendar", "mondays"],
  ["vacation", "holiday", "trip", "vacances", "voyage"],
  ["contribution", "cotisation"],
  ["advisor", "planner", "conseiller"],
  ["savings", "accounts", "epargne", "registered"],
  ["rental", "airbnb", "host", "location"],
  ["offer", "role", "job", "poste"],
  ["error", "errors", "erreur", "sentry"],
  ["pr", "prs", "pull"],
  ["board", "conseil", "administrateur"],
];

export function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function stem(w: string): string {
  if (w.length > 5) return w.slice(0, 5);
  return w.length > 3 ? w.replace(/(?:es|s)$/, "") : w;
}

export function terms(text: string): string[] {
  return fold(text).split(/[^\p{L}\p{N}]+/u).filter((w) => w && !STOP.has(w) && (w.length > 1 || /\d/.test(w))).map(stem);
}

const SYN = new Map<string, string[]>();
for (const group of SYNONYMS) { const st = group.map(stem); for (const s of st) SYN.set(s, st); }

// The French-English word map (src/lexicon.ts, gap G172), as stems: a word in several groups gets
// all of their words. Off unless PB_LEXICON=1.
const LEX = new Map<string, Set<string>>();
for (const group of LEXICON) {
  const st = [...new Set(group.flatMap((w) => terms(w)))];
  for (const s of st) { const into = LEX.get(s) ?? new Set<string>(); for (const o of st) into.add(o); LEX.set(s, into); }
}
export const LEXICON_WEIGHT = 0.8;
export const lexiconOn = () => process.env.PB_LEXICON === "1";

export interface Chunk { note: string; head: boolean; text: string }
interface Doc { id: string; title: string; type: string; area: string; tf: Map<string, number>; len: number; chunks: { chunk: Chunk; tf: Map<string, number> }[]; status?: string; stale: boolean; age: number }
export interface Index { docs: Doc[]; df: Map<string, number>; avgdl: number }

// Days since the newest date the agent can see: its visible facts' as_of or last_confirmed. A hidden
// fact's date, and the raw `updated` (which any write to the note moves, hidden fact included), would show
// the agent through its ranking that a hidden fact changed; updated is the fallback only when no
// visible fact is dated, and then it is the date the view shows (shownUpdated, G222).
function ageDays(v: Visible, res: CarveResult, now: string): number {
  const dates: string[] = [];
  for (const [, f] of visibleFacts(v, res)) for (const r of records(f)) dates.push(String(r.last_confirmed ?? r.as_of ?? ""));
  let newest = dates.filter((d) => /^\d{4}/.test(d)).sort().at(-1);
  const shown = shownUpdated(v, res);
  if (!newest && /^\d{4}/.test(shown)) newest = shown;
  return newest ? Math.max(0, daysBetween(newest, now)) : 3650;
}

function count(ts: string[], into = new Map<string, number>(), w = 1) {
  for (const t of ts) into.set(t, (into.get(t) ?? 0) + w);
  return into;
}

// Header (title, meta line, facts) is one chunk; the body splits on blank lines, headings
// and list items, so one bullet of a long running log is one chunk. renderNote puts the
// whole body in its last element when the agent is granted it.
export function chunkNote(lines: string[], hasBody: boolean): { head: string; body: string[] } {
  const head = (hasBody ? lines.slice(0, -1) : lines).join("\n").trimEnd();
  const body: string[] = [];
  if (!hasBody) return { head, body };
  let cur: string[] = [];
  let heading = "";
  const flush = () => { if (cur.join("").trim()) body.push((heading ? heading + "\n" : "") + cur.join("\n")); cur = []; };
  for (const l of lines[lines.length - 1].split("\n")) {
    if (!l.trim()) { flush(); continue; }
    if (/^#{1,6} /.test(l)) { flush(); heading = l; continue; }
    if (/^\s*[-*] |^\s*\d+\. /.test(l)) flush();
    cur.push(l);
  }
  flush();
  return { head, body };
}

// One index per carve and day: a cell's carve is reused across reads (src/core.ts snapshot),
// and rebuilding the index on every search was most of a search on a large brain.
const indexCache = new WeakMap<CarveResult, { now: string; rules: Rules; index: Index }>();
export function buildIndex(res: CarveResult, rules: Rules, now = today()): Index {
  const hit = indexCache.get(res);
  if (hit && hit.now === now && hit.rules === rules) return hit.index;
  const index = makeIndex(res, rules, now);
  indexCache.set(res, { now, rules, index });
  return index;
}

// A note's document, kept while the note is the same object (a cell's notes are shared and
// frozen, src/brain.ts) and nothing else its rendering reads changed: the day, the rules, what
// is carved out and, for a note that names a note that came into or left the view, the link.
// Rendering every note again was most of the first search after a write (docs/perf.md).
const docCache = new WeakMap<Note, { ctx: string; body: boolean; doc: Doc }>();
// By context, the last index: its ids, its documents and their document frequencies, which the
// next index adjusts for the documents that changed instead of counting every term again.
const lastIndex = new Map<string, { ids: Set<string>; docs: Set<Doc>; df: Map<string, number> }>();

function contextOf(res: CarveResult, rules: Rules, now: string): string {
  const { guidance: _, ...rest } = rules;
  return JSON.stringify([now, rest, res.grant, res.carvedValues ?? [], needlesOf(res).map((n) => [n.value, n.squashed, n.digits ?? "", n.parts]), res.hiddenFacts.map((h) => h.key).sort()]);
}

function makeIndex(res: CarveResult, rules: Rules, now: string): Index {
  const docs: Doc[] = [];
  const ctx = contextOf(res, rules, now);
  const ids = new Set(res.visible.keys());
  const prev = lastIndex.get(ctx);
  const moved = prev ? [...ids].filter((id) => !prev.ids.has(id)).concat([...prev.ids].filter((id) => !ids.has(id))) : [];
  const reuse = !!prev && moved.length <= 100;
  const df = reuse ? new Map(prev!.df) : new Map<string, number>();
  const kept = new Set<Doc>();
  const tally = (d: Doc, by: number) => { for (const t of d.tf.keys()) { const n = (df.get(t) ?? 0) + by; if (n) df.set(t, n); else df.delete(t); } };
  const names = (n: Note) => moved.length > 0 && moved.some((id) => n.body.includes(id) || JSON.stringify(n.fm).includes(id));
  for (const v of res.visible.values()) {
    const hit = reuse ? docCache.get(v.note) : undefined;
    if (hit && hit.ctx === ctx && hit.body === v.body && !names(v.note)) {
      if (reuse && prev!.docs.has(hit.doc)) kept.add(hit.doc); else tally(hit.doc, 1);
      docs.push(hit.doc);
      continue;
    }
    const fm = v.note.fm;
    const lines = renderNote(v, res, rules, now);
    const { head, body } = chunkNote(lines, !!(v.body && v.note.body.trim()));
    const tf = new Map<string, number>();
    // field weights: title and aliases x3, header (meta and facts) x2, body x1
    count(terms([fm.title, ...(fm.aliases ?? [])].join(" ")), tf, 3);
    count(terms(head), tf, 2);
    const chunks = [{ chunk: { note: fm.id, head: true, text: head }, tf: count(terms(head + " " + fm.title)) }];
    for (const b of body) { const t = terms(b); count(t, tf, 1); chunks.push({ chunk: { note: fm.id, head: false, text: b }, tf: count(t) }); }
    const len = [...tf.values()].reduce((a, b) => a + b, 0);
    const doc: Doc = { id: fm.id, title: fm.title, type: fm.type, area: fm.area, tf, len, chunks, status: (fm as { status?: string }).status, stale: /\[(stale|disputed)\]/.test(head), age: ageDays(v, res, now) };
    if (Object.isFrozen(v.note)) docCache.set(v.note, { ctx, body: v.body, doc });
    tally(doc, 1);
    docs.push(doc);
  }
  if (reuse) for (const d of prev!.docs) if (!kept.has(d)) tally(d, -1);
  if (lastIndex.size > 16) lastIndex.clear();
  lastIndex.set(ctx, { ids, docs: new Set(docs), df });
  const avgdl = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avgdl };
}

export interface QueryTerm { t: string; w: number }
export function queryTerms(q: string, synonyms = true): QueryTerm[] {
  const out = new Map<string, number>();
  for (const t of terms(q)) {
    out.set(t, 1);
    if (synonyms) for (const s of SYN.get(t) ?? []) if (!out.has(s)) out.set(s, 0.6);
    if (synonyms && lexiconOn()) for (const s of LEX.get(t) ?? []) if (!out.has(s)) out.set(s, LEXICON_WEIGHT);
  }
  return [...out].map(([t, w]) => ({ t, w }));
}

export function bm25(tf: Map<string, number>, len: number, avgdl: number, qt: QueryTerm[], idx: { docs: unknown[]; df: Map<string, number> }): number {
  const N = idx.docs.length, k1 = 1.2, b = 0.75;
  let s = 0;
  for (const { t, w } of qt) {
    const f = tf.get(t);
    if (!f) continue;
    const n = idx.df.get(t) ?? 0;
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
    s += w * idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len / avgdl));
  }
  return s;
}

export interface Ranked { id: string; title: string; type: string; area: string; score: number; match: string }

export function rank(idx: Index, q: string, limit = 20, opts: { synonyms?: boolean } = {}): Ranked[] {
  const qt = queryTerms(q, opts.synonyms ?? true);
  if (!qt.length) return [];
  const out: Ranked[] = [];
  for (const d of idx.docs) {
    let s = bm25(d.tf, d.len, idx.avgdl, qt, idx);
    if (!s) continue;
    if (d.status === "archived" || d.status === "superseded") s *= 0.7;
    // architecture 0.5: stale and disputed facts rank down, never out (the label still shows)
    if (d.stale) s *= 0.9;
    // recency (eval gap G15): up to +15% for a note confirmed this week, halving every 180
    // days, so a newer note wins a near-tie but an exact older match still beats a vague newer one
    s *= 1 + 0.15 * Math.pow(0.5, d.age / 180);
    const best = bestChunks(idx, d, qt, 1)[0];
    out.push({ id: d.id, title: d.title, type: d.type, area: d.area, score: s, match: (best?.text ?? "").replace(/\s+/g, " ").slice(0, 160) });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

function bestChunks(idx: Index, d: Doc, qt: QueryTerm[], n: number): Chunk[] {
  const avg = d.chunks.reduce((a, c) => a + [...c.tf.values()].reduce((x, y) => x + y, 0), 0) / Math.max(1, d.chunks.length);
  return d.chunks.filter((c) => !c.chunk.head)
    .map((c) => ({ c: c.chunk, s: bm25(c.tf, [...c.tf.values()].reduce((x, y) => x + y, 0), avg, qt, idx) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.c);
}

// What context_pack returns for a topic: for each hit, its header and facts plus its best
// matching paragraphs, in the note's own order, until the character budget is spent.
export function pack(idx: Index, q: string, opts: { notes?: number; chunksPerNote?: number; budget?: number; synonyms?: boolean } = {}): { text: string; ids: string[] } {
  const { notes = 8, chunksPerNote = 3, budget = 8000 } = opts;
  const qt = queryTerms(q, opts.synonyms ?? true);
  const hits = rank(idx, q, notes, opts);
  const parts: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const h of hits) {
    const d = idx.docs.find((x) => x.id === h.id)!;
    // a short body comes whole; a long one (a running log) gives only its matching paragraphs
    const short = d.chunks.slice(1).reduce((a, c) => a + c.chunk.text.length, 0) <= 800;
    const chosen = new Set(short ? d.chunks.slice(1).map((c) => c.chunk) : bestChunks(idx, d, qt, chunksPerNote));
    const body = d.chunks.filter((c) => chosen.has(c.chunk)).map((c) => c.chunk.text);
    const omitted = d.chunks.length - 1 - body.length;
    const block = [d.chunks[0].chunk.text, ...(body.length ? ["", ...body] : []), ...(omitted > 0 ? ["", `(${omitted} more paragraph${omitted > 1 ? "s" : ""} in this note; read \`${d.id}\` for all of it)`] : [])].join("\n");
    if (used && used + block.length > budget) break;
    parts.push(block);
    ids.push(d.id);
    used += block.length;
  }
  return { text: parts.join("\n\n"), ids };
}
