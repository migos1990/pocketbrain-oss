// SPDX-License-Identifier: AGPL-3.0-only
// The brain reads its own pages every night, so the owner is not the proofreader (next-level move
// 1, G750). 91 of 150 gaps were wording the owner found on his phone, each fixed with one more
// special case in a template. This reads every page as the owner sees it (the same ownerPage the
// dashboard serves, fresh) and runs one small set of class rules over the words on it; a gap whose
// bad sentence no rule catches becomes a new rule then, not a new branch in a template.
// Output is counts by rule and page kind, never a page's id, title or value, kept in
// log/proofread.json for the north star and doctor, with a heartbeat. Report-only: it writes no
// page, no card and no ask, and notifies no one. Code only, no model. docs/wiki.md "The nightly read".
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadState } from "./dashboard/data";
import { ownerPage } from "./dashboard/html-page";
import { pageLines } from "./dashboard/home";
import { beat } from "./heartbeat";
import { NOTE_TYPES } from "./checks";

export const RULES = [
  "template-slot", // a slot the template never filled: {day}, undefined, null
  "raw-markup", // [[link]], [^1], **, `code`, a source id or a long hex id in the words, an id for a name
  "label-sentence", // an attribute's label read as English: "The chose of X is", "On X, the why:"
  "machine-date", // 2026-08-30, or a yearly 07-26, in a sentence the hub wrote (a source's own words may keep theirs)
  "repeated-opener", // three sentences running that open the same way: a list written as prose
  "spliced-value", // a free-text value glued into a template: "X is Robin is done", "works as A; B", "Due for Re: Fwd: …", "?." (audit v13)
  "said-twice", // one sentence twice on a page
  "full-name-again", // the page's full name opening sentence after sentence
  "chip-repeats", // a chip that says again what the line under the name says, or its initials
  "doubled", // "..", "the the", a space before a comma
  "empty-section", // a heading or a quote with nothing under it
  "no-source", // "No source given"
  "bare-url", // a web address as words in a sentence
  "cut-off", // a paragraph that stops mid-clause
] as const;
export type Rule = (typeof RULES)[number];

export interface Proofread { at: string; pages: number; odd_pages: number; by_rule: Partial<Record<Rule, number>>; by_kind: Record<string, Partial<Record<Rule, number>>>; failed?: number }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", middot: "·" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
const text = (html: string) => decode(html.replace(/<sup[\s\S]*?<\/sup>/g, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
const between = (html: string, open: RegExp, close: string) => { const m = open.exec(html); if (!m) return ""; const from = m.index + m[0].length; const to = html.indexOf(close, from); return html.slice(from, to < 0 ? undefined : to); };
const sentences = (p: string) => p.split(/(?<=[.!?…])\s+(?=[A-Z0-9"“(‘'])/).map((s) => s.trim()).filter(Boolean);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const initials = (s: string) => (s.match(/\b[A-Z][\p{L}'’-]*/gu) ?? []);

// The words of one page the owner reads: its name, the line under it, its chips, its paragraphs
// (not the sources' own words, which are quotes), its headings, and its quotes.
function regions(html: string) {
  const body = html.replace(/<(style|script)[\s\S]*?<\/\1>/g, "");
  const title = text(between(body, /<h1[^>]*>/, "</h1>"));
  const kind = text(between(body, /<p class="kind"[^>]*>/, "</p>"));
  const chips = [...body.matchAll(/<span class="chip"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => text(m[1]!)).filter(Boolean);
  const prose = between(body, /<div class="prose"[^>]*>/, "<h2>References</h2>");
  const paras = [...prose.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => text(m[2]!)).filter(Boolean);
  const refs = between(body, /<ol class="b-refs"[^>]*>/, "</ol>");
  return { title, kind, chips, prose, paras, refs };
}

// The rules one page breaks, once per sentence (or heading, chip, quote) that breaks it.
export function readPage(html: string): Rule[] {
  const { title, kind, chips, prose, paras, refs } = regions(html);
  const hits: Rule[] = [];
  const hit = (r: Rule) => hits.push(r);
  const own = [kind, ...paras];
  // A page's name that is an id ("projects/atlas#next_step") is markup too.
  if (/^[a-z0-9-]+\/[a-z0-9-]+(?:#|$)/.test(title)) hit("raw-markup");
  const t = escapeRe(title);
  const seen = new Map<string, number>();
  for (const line of own) {
    if (/\{[a-z_]+\}|\bundefined\b|\bnull\b|\bNaN\b|\bNone[:.]|\[object Object\]/.test(line)) hit("template-slot");
    if (/\[\[|\]\]|\[\^\d+\]|\*\*|`|\b(?:gmail|gcal|mail|notion|approved|imsg|owner):\s?[0-9a-f]{6,}|\b[0-9a-f]{16,}\b/i.test(line)) hit("raw-markup");
    // A yearly day without its year counts too: "birthday is 07-26" (G786).
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(line) || /\b(?:is|on) (?:--)?(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b(?!-)/.test(line)) hit("machine-date");
    if (/(?<!\.)\.\.(?!\.)|,,|\s[,.;:](?=\s|$)|\b([a-z]+) \1\b/.test(line)) hit("doubled");
    if (/\bno source given\b|\bunknown source\b|\bsource: none\b/i.test(line)) hit("no-source");
    if (/\bhttps?:\/\/\S/.test(line)) hit("bare-url");
  }
  for (const p of paras) {
    const ss = sentences(p);
    for (const s of ss) {
      if (title && (new RegExp(`^The [a-z][a-z_ ]{0,30} of ${t} is `).test(s) || new RegExp(`^On ${t}, the [a-z][a-z_ ]{0,30}: `).test(s) || new RegExp(`^[A-Z][a-z_ ]{0,30} of ${t}: `).test(s))) hit("label-sentence");
      // "X's what it is is …", "X's kind is …": an attribute's code name read as English.
      if (title && new RegExp(`^${t}(?:’s|'s) (?:(?:[a-z]+ )*(?:what|it|who|how)(?: [a-z]+)*|kind|chose|why|type) is `).test(s)) hit("label-sentence");
      if (/\bis [A-Z][\p{L}'’-]* (?:is|was|has|will|did|had)\b/u.test(s) || /\bworks as [A-Z][^.;]*;/.test(s) || /\b(?:Re|Fwd|Fw|TR):\s/.test(s) || /\?\s*[.,]|\?\s+[a-z]/.test(s) || /\bis the [a-z]+, [^.]* at [A-Z]/.test(s)) hit("spliced-value");
      const k = s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").trim();
      if (k.length > 12) seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    // Three sentences running that open with the same two words.
    const open = ss.map((s) => s.split(/\s+/).slice(0, 2).join(" ").toLowerCase());
    for (let i = 2; i < open.length; i++) if (open[i] === open[i - 1] && open[i] === open[i - 2] && (i < 3 || open[i] !== open[i - 3])) hit("repeated-opener");
    if (title.includes(" ") && ss.filter((s) => new RegExp(`^${t}(?:’s|'s)?\\b`).test(s)).length >= 2) hit("full-name-again");
    if (/(?:,|;|\b(?:with|and|or|at|of|the|to|for|by|in|on|a|an))$/i.test(p)) hit("cut-off");
  }
  for (const n of seen.values()) if (n > 1) hit("said-twice");
  const line = `${title} ${kind}`.toLowerCase();
  for (const c of chips) {
    const caps = /^[A-Z]{2,5}$/.test(c);
    const words = initials(kind);
    const spelled = caps && words.some((_, i) => words.slice(i, i + c.length).map((w) => w[0]).join("") === c);
    if ((!caps && c.length > 2 && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(c.toLowerCase())}(?![\\p{L}\\p{N}])`, "u").test(line)) || spelled) hit("chip-repeats");
  }
  // A heading with nothing under it, a quote with no words.
  for (const m of prose.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>(?=\s*(?:<h2\b|$))/g)) if (m) hit("empty-section");
  for (const m of refs.matchAll(/<details[^>]*>([\s\S]*?)<\/details>/g)) {
    const q = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(m[1]!);
    if (!q || !text(q[1]!)) hit("empty-section");
  }
  return hits;
}

// A page's kind as a count may name it: a note type the code defines, never a word a brain made up
// for a type of its own (that one counts as "page").
const KINDS: readonly string[] = [...NOTE_TYPES, "dispute", "page"];
const kindOf = (type: unknown) => (KINDS.includes(String(type)) ? String(type) : "page");

const file = (root: string) => join(root, "log", "proofread.json");

// Every page the owner has, as he sees it now, with how long each took to render. Never throws for
// one page: a page that fails to render is counted under `failed`, not named. Writes nothing.
export function readPages(root: string, now = new Date()): { read: Proofread; ms: number[] } {
  const s = loadState(root, now);
  const r: Proofread = { at: now.toISOString(), pages: 0, odd_pages: 0, by_rule: {}, by_kind: {} };
  const ms: number[] = [];
  for (const n of s.notes) {
    if (n.fm.type === "hub") continue;
    r.pages++;
    let hits: Rule[];
    const t = performance.now();
    try { hits = readPage(ownerPage(s, "", n, pageLines(root, s.rules, s.notes, n.fm.id), { fresh: true })); }
    catch { r.failed = (r.failed ?? 0) + 1; continue; }
    finally { ms.push(performance.now() - t); }
    if (!hits.length) continue;
    r.odd_pages++;
    const kind = kindOf(n.fm.type);
    const k = (r.by_kind[kind] ??= {});
    for (const h of hits) { r.by_rule[h] = (r.by_rule[h] ?? 0) + 1; k[h] = (k[h] ?? 0) + 1; }
  }
  return { read: r, ms };
}

// The night's run: the same read, kept in log/proofread.json with a heartbeat.
export function proofread(root: string, now = new Date()): Proofread {
  const t0 = Date.now();
  try {
    const r = readPages(root, now).read;
    mkdirSync(join(root, "log"), { recursive: true });
    writeFileSync(`${file(root)}.${process.pid}.tmp`, JSON.stringify(r) + "\n");
    renameSync(`${file(root)}.${process.pid}.tmp`, file(root));
    beat(root, "proofread", { ok: true, ms: Date.now() - t0, now });
    return r;
  } catch (e) {
    beat(root, "proofread", { ok: false, error: (e as Error).message, ms: Date.now() - t0, now });
    throw e;
  }
}

// The read a deploy takes, before and after it changes the code (G984): the owner's pages on his
// own brain, as counts and milliseconds only. Never a page's id, title or words. `slow` counts
// pages that took over SLOW_PAGE_MS to render.
export const SLOW_PAGE_MS = 300;
export interface PageRead { pages: number; failed: number; odd: number; odd_pages: number; by_rule: Partial<Record<Rule, number>>; by_kind: Record<string, Partial<Record<Rule, number>>>; median_ms: number; p95_ms: number; max_ms: number; slow: number }
// Counts by kind of page, kept only under names the code knows (a kind, then a rule) and above zero.
function kindsOf(j: unknown): PageRead["by_kind"] {
  const out: PageRead["by_kind"] = {};
  if (!j || typeof j !== "object") return out;
  for (const kind of KINDS) {
    const from = (j as Record<string, unknown>)[kind];
    if (!from || typeof from !== "object") continue;
    const row: Partial<Record<Rule, number>> = {};
    for (const k of RULES) { const n = (from as Record<string, unknown>)[k]; if (typeof n === "number" && Number.isFinite(n) && n > 0) row[k] = n; }
    if (Object.keys(row).length) out[kind] = row;
  }
  return out;
}
export function pageReadOf(read: Proofread, ms: number[]): PageRead {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : 0);
  const by_rule: Partial<Record<Rule, number>> = {};
  for (const k of RULES) if (read.by_rule[k]) by_rule[k] = read.by_rule[k];
  return { pages: read.pages, failed: read.failed ?? 0, odd: Object.values(by_rule).reduce((a, n) => a + (n ?? 0), 0), odd_pages: read.odd_pages, by_rule, by_kind: kindsOf(read.by_kind), median_ms: at(0.5), p95_ms: at(0.95), max_ms: sorted.length ? Math.round(sorted[sorted.length - 1]) : 0, slow: ms.filter((x) => x > SLOW_PAGE_MS).length };
}
// What a script printed is checked before it is trusted: numbers, and rule names this code knows.
export function asPageRead(j: unknown): PageRead | undefined {
  const o = j as Record<string, unknown> | null;
  const num = (k: string) => typeof o?.[k] === "number" && Number.isFinite(o[k] as number) && (o[k] as number) >= 0;
  if (!o || typeof o !== "object" || !["pages", "failed", "odd", "odd_pages", "median_ms", "p95_ms", "max_ms", "slow"].every(num)) return undefined;
  const by_rule: Partial<Record<Rule, number>> = {};
  for (const k of RULES) { const n = (o.by_rule as Record<string, unknown> | undefined)?.[k]; if (typeof n === "number" && n > 0) by_rule[k] = n; }
  return { pages: o.pages as number, failed: o.failed as number, odd: o.odd as number, odd_pages: o.odd_pages as number, by_rule, by_kind: kindsOf(o.by_kind), median_ms: o.median_ms as number, p95_ms: o.p95_ms as number, max_ms: o.max_ms as number, slow: o.slow as number };
}
// One line for the deploy log. With the reading taken on the code before, minutes earlier on the
// same brain, it says what the new code changed. Slower means over SLOW_PAGE_MS now and at least
// half again as slow as before, or more pages over the line.
// Where the odd sentences are, for whoever fixes them (G1002): by rule, then by kind of page with
// its rules, most first. Rule and kind names are the code's own.
const most = <K extends string>(o: Partial<Record<K, number>>) => (Object.entries(o) as [K, number][]).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
function whereLine(a: PageRead): string {
  const rules = most(a.by_rule).map(([k, n]) => `${k} ${n}`).join(", ");
  if (!rules) return "";
  const total = (row: Partial<Record<Rule, number>>) => Object.values(row).reduce((x, n) => x + (n ?? 0), 0);
  const kinds = Object.entries(a.by_kind).sort((x, y) => total(y[1]) - total(x[1]) || x[0].localeCompare(y[0])).map(([kind, row]) => `${kind} ${total(row)} (${most(row).map(([k, n]) => `${k} ${n}`).join(", ")})`).join(", ");
  return `; by rule: ${rules}${kinds ? `; by kind of page: ${kinds}` : ""}`;
}
export function pageReadLine(a: PageRead, before?: PageRead): string {
  const s = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const fails = a.failed ? `; ${s(a.failed, "page")} failed to render${before ? ` (was ${before.failed})` : ""}` : "";
  const tail = "(report only; counts and milliseconds, never a page's name or words)";
  if (!before) return `pages read: ${s(a.odd, "odd sentence")} on ${a.odd_pages} of ${s(a.pages, "page")}; a page renders in ${a.median_ms} ms at the median, ${a.max_ms} ms at the slowest, ${a.slow} over ${SLOW_PAGE_MS} ms${fails}${whereLine(a)}; no reading on the code before, so nothing to compare ${tail}`;
  const d = a.odd - before.odd;
  const moved = RULES.map((k) => [k, (a.by_rule[k] ?? 0) - (before.by_rule[k] ?? 0)] as const).filter(([, n]) => n).map(([k, n]) => `${k} ${n > 0 ? "+" : ""}${n}`).join(", ");
  const sentences = `${d === 0 ? "the same count as" : d > 0 ? `${d} more than` : `${-d} fewer than`} on the code before${moved ? ` (${moved})` : ""}`;
  const worse: string[] = [];
  if (d > 0 || a.failed > before.failed) worse.push("sentences");
  if (a.slow > before.slow || (a.max_ms > SLOW_PAGE_MS && a.max_ms > before.max_ms * 1.5)) worse.push("speed");
  return `pages read: ${s(a.odd, "odd sentence")} on ${a.odd_pages} of ${s(a.pages, "page")}, ${sentences}; a page renders in ${a.median_ms} ms at the median (was ${before.median_ms}), ${a.max_ms} ms at the slowest (was ${before.max_ms}), ${a.slow} over ${SLOW_PAGE_MS} ms (was ${before.slow})${fails}${whereLine(a)}${worse.length ? `; WORSE than the code before: ${worse.join(" and ")}` : ""} ${tail}`;
}

export function readProofread(root: string): Proofread | undefined {
  try { return JSON.parse(readFileSync(file(root), "utf8")) as Proofread; } catch { return undefined; }
}

export function proofreadLine(r: Proofread): string {
  const total = Object.values(r.by_rule).reduce((a, n) => a + (n ?? 0), 0);
  if (!total) return `nightly read: no odd sentence on ${r.pages} pages (reported, not in pass)`;
  const rules = Object.entries(r.by_rule).filter(([, n]) => n).sort((a, b) => b[1]! - a[1]! || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ");
  return `nightly read: ${total} odd sentence${total === 1 ? "" : "s"} on ${r.odd_pages} of ${r.pages} pages (${rules})${r.failed ? `; ${r.failed} page(s) failed to render` : ""} (reported, not in pass)`;
}
