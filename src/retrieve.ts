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
// all of their words. On unless PB_LEXICON=0.
const LEX = new Map<string, Set<string>>();
for (const group of LEXICON) {
  const st = [...new Set(group.flatMap((w) => terms(w)))];
  for (const s of st) { const into = LEX.get(s) ?? new Set<string>(); for (const o of st) into.add(o); LEX.set(s, into); }
}
export const LEXICON_WEIGHT = 0.8;
export const lexiconOn = () => process.env.PB_LEXICON !== "0";

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
// The names a topic asks about (G503): its capitalized words, past the first word (which a
// sentence capitalizes anyway), that aren't stop words, each with the stem the index holds.
// "what's next with Jane" names Jane; "Jane's next step" names nothing, and is ranked as before.
export function namesIn(q: string): { word: string; stem: string }[] {
  const out = new Map<string, string>();
  const words = q.split(/[^\p{L}\p{N}'’-]+/u).map((w) => w.replace(/(?:'s|’s|['’-])+$/u, "").replace(/^['’-]+/, "")).filter(Boolean);
  for (const w of words.slice(1)) {
    if (!/^\p{Lu}/u.test(w)) continue;
    const t = terms(w);
    if (t.length !== 1) continue;
    if (!out.has(t[0])) out.set(t[0], w);
  }
  return [...out].map(([stem, word]) => ({ word, stem }));
}
// Whether a note's indexed text (title, facts, body as the agent sees them) holds a stem.
export const docHas = (idx: Index, id: string, stem: string) => !!idx.docs.find((d) => d.id === id)?.tf.has(stem);

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
    // The references a page ends with belong to no section: never repeat the last heading over
    // them (demo-moment thread, 2026-10-29: "#### Earlier notes" twice in context_pack).
    if (/^\[\^[^\]\s]+\]:/.test(l) && !cur.length) heading = "";
    // Nor over the hub's made-by line, which closes its block wherever the block sits (G682).
    if (l.trim() === "(Written by the hub from this page's facts.)" && !cur.length) heading = "";
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

// An index for one pass that only scores (foundBy): the same documents, terms and counts, but no
// paragraphs kept for match text, and nothing remembered for the next build. The nightly check
// builds one per agent over the whole brain; kept, they took the 50k-note hub over its memory
// budget (docs/perf.md, "The night pass").
export function scoringIndex(res: CarveResult, rules: Rules, now = today()): Index {
  return makeIndex(res, rules, now, true);
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

function makeIndex(res: CarveResult, rules: Rules, now: string, lean = false): Index {
  const docs: Doc[] = [];
  const ctx = contextOf(res, rules, now);
  const ids = new Set(res.visible.keys());
  const prev = lean ? undefined : lastIndex.get(ctx);
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
    const chunks = lean ? [] : [{ chunk: { note: fm.id, head: true, text: head }, tf: count(terms(head + " " + fm.title)) }];
    for (const b of body) { const t = terms(b); count(t, tf, 1); if (!lean) chunks.push({ chunk: { note: fm.id, head: false, text: b }, tf: count(t) }); }
    const len = [...tf.values()].reduce((a, b) => a + b, 0);
    const doc: Doc = { id: fm.id, title: fm.title, type: fm.type, area: fm.area, tf, len, chunks, status: (fm as { status?: string }).status, stale: /\[(stale|disputed)\]/.test(head), age: ageDays(v, res, now) };
    if (!lean && Object.isFrozen(v.note)) docCache.set(v.note, { ctx, body: v.body, doc });
    tally(doc, 1);
    docs.push(doc);
  }
  if (reuse) for (const d of prev!.docs) if (!kept.has(d)) tally(d, -1);
  if (!lean) {
    if (lastIndex.size > 16) lastIndex.clear();
    lastIndex.set(ctx, { ids, docs: new Set(docs), df });
  }
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

// How a hit was found (backlog 303), so an agent can tell a weak match from a strong one: the
// agent's own words it contains, the related words (synonyms, the French-English map) that carried
// it, and strong (every word), partial (some) or weak (only related words). Shown as words, not
// stems; the related words come from the fixed maps above, never from anyone's notes.
export type Strength = "strong" | "partial" | "weak";
export interface Why { matched: string[]; via: string[]; strength: Strength }
const WORD = new Map<string, string>();
for (const group of [...SYNONYMS, ...LEXICON]) for (const w of group) if (!WORD.has(stem(fold(w)))) WORD.set(stem(fold(w)), fold(w));
// A word matched only by its stem is named by that stem ("coordinat*"), never by the query's
// spelling: a carved value typed as a query must not come back in the answer (rt-search-side-channel).
function why(q: string, qt: QueryTerm[], d: Doc): Why {
  const { tf } = d;
  const own = new Map<string, string>();
  for (const w of fold(q).split(/[^\p{L}\p{N}]+/u)) if (w && !STOP.has(w) && (w.length > 1 || /\d/.test(w)) && !own.has(stem(w))) own.set(stem(w), w);
  const shown = new Set(fold([d.title, ...d.chunks.map((c) => c.chunk.text)].join(" ")).split(/[^\p{L}\p{N}]+/u));
  const matched = [...own].filter(([t]) => tf.has(t)).map(([t, w]) => (shown.has(w) ? w : `${t}*`));
  const via = qt.filter(({ t, w }) => w < 1 && !own.has(t) && tf.has(t)).map(({ t }) => WORD.get(t) ?? t);
  return { matched, via: [...new Set(via)], strength: matched.length === own.size ? "strong" : matched.length ? "partial" : "weak" };
}
// A hit only the embedding found (src/semantic.ts): none of the query's words, weak by definition.
export const SIMILAR = "similar meaning";
export const meaningOnly = (w: Why) => w.strength === "weak" && w.via.length === 1 && w.via[0] === SIMILAR;
export function whyLine(w: Why): string {
  if (meaningOnly(w)) return "Matched only by similar meaning, none of your words (weak: check it is what was asked before relying on it)";
  return w.strength === "weak" ? `Matched only related words: ${w.via.join(", ")} (weak: check it is what was asked before relying on it)`
    : `Matched: ${w.matched.join(", ")}${w.via.length ? `, and related words ${w.via.join(", ")}` : ""} (${w.strength})`;
}

export interface Ranked extends Why { id: string; title: string; type: string; area: string; score: number; match: string }

function docScore(idx: Index, d: Doc, qt: QueryTerm[]): number {
  let s = bm25(d.tf, d.len, idx.avgdl, qt, idx);
  if (!s) return 0;
  if (d.status === "archived" || d.status === "superseded") s *= 0.7;
  // architecture 0.5: stale and disputed facts rank down, never out (the label still shows)
  if (d.stale) s *= 0.9;
  // recency (eval gap G15): up to +15% for a note confirmed this week, halving every 180
  // days, so a newer note wins a near-tie but an exact older match still beats a vague newer one
  return s * (1 + 0.15 * Math.pow(0.5, d.age / 180));
}

// For each term, the docs that hold it, and the largest recency boost any doc gets: built once
// per index, the first time foundBy asks.
const postingsOf = new WeakMap<Index, { at: Map<string, Doc>; terms: Map<string, Doc[]>; titled: Map<string, Doc[]>; maxBoost: number }>();
const titleKey = (s: string) => fold(s).replace(/\s+/g, " ").trim();
function postings(idx: Index) {
  const hit = postingsOf.get(idx);
  if (hit) return hit;
  const p = { at: new Map<string, Doc>(), terms: new Map<string, Doc[]>(), titled: new Map<string, Doc[]>(), maxBoost: 1.15 };
  for (const d of idx.docs) {
    p.at.set(d.id, d);
    const t = titleKey(String(d.title ?? ""));
    (p.titled.get(t) ?? p.titled.set(t, []).get(t)!).push(d);
    p.maxBoost = Math.max(p.maxBoost, 1 + 0.15 * Math.pow(0.5, d.age / 180));
    for (const t of d.tf.keys()) (p.terms.get(t) ?? p.terms.set(t, []).get(t)!).push(d);
  }
  postingsOf.set(idx, p);
  return p;
}

// Whether rank(idx, q, limit) would list `id`, without ranking every doc. The note's own score
// comes first; a query term's share of any doc's score is under w * idf * (k1 + 1), so a doc
// holding only the weakest terms, whose shares add up to less than that score, can't beat it and
// is never looked at. The rest are scored exactly as rank scores them and counted when ahead.
// The nightly check that every note can be found by its title (probe.ts unsearchable) asks once
// per note per agent; with rank, which scores every doc and finds each hit's best paragraph,
// that grew with the square of the brain and didn't finish at 10k notes (docs/perf.md).
export function foundBy(idx: Index, q: string, id: string, limit = 20, opts: { synonyms?: boolean } = {}): boolean {
  const p = postings(idx), me = p.at.get(id);
  if (!me) return false;
  const qt = queryTerms(q, opts.synonyms ?? true);
  const mine = docScore(idx, me, qt);
  if (!mine) return false;
  // Notes titled as the question come first (G693): one is ahead of this note when it is so titled
  // and this one isn't, or both are and it scores higher; one not so titled never is when this is.
  const asked = titleKey(q), named = titleKey(String(me.title ?? "")) === asked;
  const firsts = (p.titled.get(asked) ?? []).filter((d) => d !== me && docScore(idx, d, qt) > 0);
  const firstAhead = firsts.filter((d) => !named || (() => { const s = docScore(idx, d, qt); return s > mine || (s === mine && d.id.localeCompare(id) < 0); })()).length;
  if (named) return firstAhead < limit;
  if (firstAhead >= limit) return false;
  const N = idx.docs.length;
  const bound = qt.map(({ t, w }) => { const n = idx.df.get(t) ?? 0; return { t, ub: w * Math.log(1 + (N - n + 0.5) / (n + 0.5)) * 2.2 * p.maxBoost * (1 + 1e-9) }; }).sort((a, b) => a.ub - b.ub);
  // The weakest terms whose bounds together stay under the note's score: a doc can't tie or beat
  // it on those alone.
  let weak = 0, sum = 0;
  while (weak < bound.length && sum + bound[weak].ub < mine) sum += bound[weak++].ub;
  const seen = new Set<Doc>([me, ...firsts]);
  let ahead = firstAhead;
  for (const { t } of bound.slice(weak)) for (const d of p.terms.get(t) ?? []) {
    if (seen.has(d)) continue;
    seen.add(d);
    const s = docScore(idx, d, qt);
    if (s > mine || (s === mine && d.id.localeCompare(id) < 0)) if (++ahead >= limit) return false;
  }
  return true;
}

// The text a document is embedded from (src/semantic.ts): its chunks as the agent is shown them,
// nothing else, so a vector can't carry what the view leaves out.
const texts = new WeakMap<object, string>();
export function docText(d: { chunks: { chunk: Chunk }[] }): string {
  let t = texts.get(d);
  if (t === undefined) { t = d.chunks.map((c) => c.chunk.text).join("\n"); texts.set(d, t); }
  return t;
}
// Hybrid search: the query's vector and a lookup for each document's vector (none yet: no
// semantic rank). Both rankings run over this index's documents only, the agent's own view.
export interface Semantic { query: Float32Array; vectorOf: (text: string) => Float32Array | undefined }
export const RRF_K = 60;
// Only the nearest few documents get a semantic rank. bge-m3's cosines leave no floor that tells an
// unrelated query from a paraphrase (on the synthetic set an unrelated query's best is 0.61 to 0.66,
// a wanted note's 0.53 to 0.85). 10 kept every kind of question at or above BM25 alone on the
// synthetic set; 5 lost some.
export const SEMANTIC_TOP = 10;
// A note found only by meaning is kept when its cosine stands MEANING_FLOOR above the median cosine
// over the asker's view (G372): bge-m3 gives every note a fairly high cosine, so what tells a
// paraphrase from noise is how far a note stands out from the rest, not its cosine. Chosen on
// blind2 (dev) and 20 self-written unrelated or nonsense questions only: blind2 recall was the
// same for every floor tried, and 0.07 is the least strict one that leaves under one weak hit per
// unrelated question (0.3 on average, against 8.7 with no floor). The median comes from the
// visible notes only, so hidden equals missing still holds.
export const MEANING_FLOOR = 0.07;
function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}

export function rank(idx: Index, q: string, limit = 20, opts: { synonyms?: boolean; semantic?: Semantic } = {}): Ranked[] {
  const qt = queryTerms(q, opts.synonyms ?? true);
  if (!qt.length) return [];
  const scored: { d: Doc; s: number }[] = [];
  for (const d of idx.docs) {
    const s = docScore(idx, d, qt);
    if (!s) continue;
    scored.push({ d, s });
  }
  // A note whose title is the question comes first (G693): asked about "Pinecrest pilot", the page
  // of that name, not a longer one that says more about it (a decision titled "Three-month
  // Pinecrest pilot" overtook the project once its page said who of its people works where).
  const asked = titleKey(q);
  const named = (d: Doc) => titleKey(String(d.title ?? "")) === asked;
  scored.sort((a, b) => Number(named(b.d)) - Number(named(a.d)) || b.s - a.s || a.d.id.localeCompare(b.d.id));
  let ranked: { d: Doc; s: number; words: boolean }[] = scored.map((x) => ({ ...x, words: true }));
  if (opts.semantic) {
    // Reciprocal-rank fusion (k=60) of the word ranking and the cosine ranking.
    const sem = opts.semantic;
    const all = idx.docs.flatMap((d) => { const v = sem.vectorOf(docText(d)); return v ? [{ d, c: cosine(sem.query, v) }] : []; })
      .sort((a, b) => b.c - a.c || a.d.id.localeCompare(b.d.id));
    const median = all.length ? all[all.length >> 1].c : 0;
    const near = all.slice(0, SEMANTIC_TOP);
    const fused = new Map<Doc, { s: number; words: boolean; plausible: boolean }>();
    scored.forEach(({ d }, r) => fused.set(d, { s: 1 / (RRF_K + r), words: true, plausible: true }));
    near.forEach(({ d, c }, r) => { const f = fused.get(d); if (f) f.s += 1 / (RRF_K + r); else fused.set(d, { s: 1 / (RRF_K + r), words: false, plausible: c - median >= MEANING_FLOOR }); });
    // A note found only by meaning stays only when it stands out from the view (G372, MEANING_FLOOR),
    // so a question nothing in the view answers gets no weak hits and "not in my view" stays the answer.
    ranked = [...fused].filter(([, f]) => f.words || f.plausible).map(([d, f]) => ({ d, s: f.s, words: f.words }))
      .sort((a, b) => b.s - a.s || a.d.id.localeCompare(b.d.id));
  }
  // The snippet and the why only for the hits returned: on a common word most of the brain
  // scores, and those two were most of a search (backlog #318).
  return ranked.slice(0, limit).map(({ d, s, words }) => {
    const base = { id: d.id, title: d.title, type: d.type, area: d.area, score: s };
    if (!words) return { ...base, match: (d.chunks[1] ?? d.chunks[0]).chunk.text.replace(/\s+/g, " ").slice(0, 160), matched: [], via: [SIMILAR], strength: "weak" as const };
    const best = bestChunks(idx, d, qt, 1)[0];
    return { ...base, match: (best?.text ?? "").replace(/\s+/g, " ").slice(0, 160), ...why(q, qt, d) };
  });
}

function bestChunks(idx: Index, d: Doc, qt: QueryTerm[], n: number): Chunk[] {
  const avg = d.chunks.reduce((a, c) => a + [...c.tf.values()].reduce((x, y) => x + y, 0), 0) / Math.max(1, d.chunks.length);
  return d.chunks.filter((c) => !c.chunk.head)
    .map((c) => ({ c: c.chunk, s: bm25(c.tf, [...c.tf.values()].reduce((x, y) => x + y, 0), avg, qt, idx) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.c);
}

// What context_pack returns for a topic: for each hit, its header and facts plus its best
// matching paragraphs, in the note's own order, until the character budget is spent.
export function pack(idx: Index, q: string, opts: { notes?: number; chunksPerNote?: number; budget?: number; synonyms?: boolean; semantic?: Semantic; keep?: (id: string) => boolean; first?: (id: string) => boolean } = {}): { text: string; ids: string[]; blocks: string[]; left: string[]; meaningOnly: boolean } {
  const { notes = 8, chunksPerNote = 3, budget = 8000, keep, first } = opts;
  const qt = queryTerms(q, opts.synonyms ?? true);
  // With a keep test (a topic that names someone, G503) the ranking is read further down, so the
  // notes kept are still the best of those that pass; the notes the name is the title of lead.
  const hits = keep ? rank(idx, q, notes * 5, opts).filter((h) => keep(h.id)).sort((a, b) => Number(!!first?.(b.id)) - Number(!!first?.(a.id))).slice(0, notes) : rank(idx, q, notes, opts);
  const parts: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const h of hits) {
    const d = idx.docs.find((x) => x.id === h.id)!;
    // a short body comes whole; a long one (a running log) gives only its matching paragraphs
    const short = d.chunks.slice(1).reduce((a, c) => a + c.chunk.text.length, 0) <= 800;
    // a long note found only by meaning has no matching paragraph: its first ones stand in
    const best = short ? [] : bestChunks(idx, d, qt, chunksPerNote);
    const chosen = new Set(short ? d.chunks.slice(1).map((c) => c.chunk) : best.length ? best : d.chunks.slice(1, 1 + chunksPerNote).map((c) => c.chunk));
    const body = d.chunks.filter((c) => chosen.has(c.chunk)).map((c) => c.chunk.text);
    const omitted = d.chunks.length - 1 - body.length;
    const block = [d.chunks[0].chunk.text, whyLine(h), ...(body.length ? ["", ...body] : []), ...(omitted > 0 ? ["", `(${omitted} more paragraph${omitted > 1 ? "s" : ""} in this note; read \`${d.id}\` for all of it)`] : [])].join("\n");
    if (used && used + block.length > budget) break;
    parts.push(block);
    ids.push(d.id);
    used += block.length;
  }
  // Matches the character budget left out, best first (the context budget names them, src/context.ts).
  const left = hits.slice(ids.length).map((h) => h.id);
  // Every match found only by meaning: none of the query's words is in the view (G372).
  return { text: parts.join("\n\n"), ids, blocks: parts, left, meaningOnly: hits.length > 0 && hits.every(meaningOnly) };
}
