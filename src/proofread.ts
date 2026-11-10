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

export const RULES = [
  "template-slot", // a slot the template never filled: {day}, undefined, null
  "raw-markup", // [[link]], [^1], **, `code`, a source id or a long hex id in the words, an id for a name
  "label-sentence", // an attribute's label read as English: "The chose of X is", "On X, the why:"
  "machine-date", // 2026-08-30 in a sentence the hub wrote (a source's own words may keep theirs)
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
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(line)) hit("machine-date");
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
    if ((!caps && c.length > 2 && line.includes(c.toLowerCase())) || spelled) hit("chip-repeats");
  }
  // A heading with nothing under it, a quote with no words.
  for (const m of prose.matchAll(/<h2\b[^>]*>[\s\S]*?<\/h2>(?=\s*(?:<h2\b|$))/g)) if (m) hit("empty-section");
  for (const m of refs.matchAll(/<details[^>]*>([\s\S]*?)<\/details>/g)) {
    const q = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/.exec(m[1]!);
    if (!q || !text(q[1]!)) hit("empty-section");
  }
  return hits;
}

const file = (root: string) => join(root, "log", "proofread.json");

// Every page the owner has, as he sees it tonight. Never throws for one page: a page that fails
// to render is counted under `failed`, not named.
export function proofread(root: string, now = new Date()): Proofread {
  const t0 = Date.now();
  try {
    const s = loadState(root, now);
    const r: Proofread = { at: now.toISOString(), pages: 0, odd_pages: 0, by_rule: {}, by_kind: {} };
    for (const n of s.notes) {
      if (n.fm.type === "hub") continue;
      r.pages++;
      let hits: Rule[];
      try { hits = readPage(ownerPage(s, "", n, pageLines(root, s.rules, s.notes, n.fm.id), { fresh: true })); }
      catch { r.failed = (r.failed ?? 0) + 1; continue; }
      if (!hits.length) continue;
      r.odd_pages++;
      const kind = String(n.fm.type ?? "page").replace(/[^a-z_-]/gi, "").slice(0, 24) || "page";
      const k = (r.by_kind[kind] ??= {});
      for (const h of hits) { r.by_rule[h] = (r.by_rule[h] ?? 0) + 1; k[h] = (k[h] ?? 0) + 1; }
    }
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

export function readProofread(root: string): Proofread | undefined {
  try { return JSON.parse(readFileSync(file(root), "utf8")) as Proofread; } catch { return undefined; }
}

export function proofreadLine(r: Proofread): string {
  const total = Object.values(r.by_rule).reduce((a, n) => a + (n ?? 0), 0);
  if (!total) return `nightly read: no odd sentence on ${r.pages} pages (reported, not in pass)`;
  const rules = Object.entries(r.by_rule).filter(([, n]) => n).sort((a, b) => b[1]! - a[1]! || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(", ");
  return `nightly read: ${total} odd sentence${total === 1 ? "" : "s"} on ${r.odd_pages} of ${r.pages} pages (${rules})${r.failed ? `; ${r.failed} page(s) failed to render` : ""} (reported, not in pass)`;
}
