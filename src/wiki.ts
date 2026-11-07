// SPDX-License-Identifier: AGPL-3.0-only
// The wiki shape of a note, read-only (docs/wiki.md): a one-line `summary:`, a `parent:` and the
// page tree computed from parents (never stored), sections from `## ` headings, and Markdown
// footnotes for refs. Every field is optional; a note without them reads as it always did.
import { MONTHS_SHORT } from "./util";
import { linksIn, parseNote, isDisputed, isList, loadBrain, saveNote, sensitivityRank, today, CONTENT_DIRS, type Note, type FactRecord, type Fact } from "./brain";
import { git, gitRun, gitTime } from "./git";
import { findSecret, redactSecrets } from "./checks";
import { hubRole } from "./hub";
import { OWNER } from "./owner";
import { loadRules, ownerName, attributeSpec, type Rules, type AttributeSpec } from "./rules";
import { nameIndex, nameKey, nameKeys } from "./mentions";
import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import YAML from "yaml";
import { join } from "node:path";
import { records, carve, grantFor } from "./carve";
import { CAPDIRS, ownerTitle, ownerOf } from "./capture";
import { SCHEMES, normalizeRef, refString } from "./sources";

export function summaryOf(n: Note): string | undefined {
  const s = n.fm.summary;
  if (typeof s !== "string") return undefined;
  const line = s.split("\n")[0].trim();
  return line || undefined;
}

export function parentOf(n: Note): string | undefined {
  const p = n.fm.parent;
  return typeof p === "string" && p.trim() ? p.trim() : undefined;
}

export interface PageTree {
  children: Map<string, string[]>; // parent id -> child ids, by title
  roots: string[]; // no parent, or a parent that is missing or loops back
  broken: string[]; // has a parent:, but it is missing or loops back
}

// The ids above `id`, top first. Empty when the chain is missing a page or loops.
export function ancestors(notes: Note[], id: string): string[] {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const chain: string[] = [];
  const seen = new Set([id]);
  let p = byId.get(id) && parentOf(byId.get(id)!);
  while (p) {
    if (seen.has(p) || !byId.has(p)) return [];
    seen.add(p);
    chain.unshift(p);
    p = parentOf(byId.get(p)!);
  }
  return chain;
}

export function pageTree(notes: Note[]): PageTree {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const children = new Map<string, string[]>();
  const roots: string[] = [], broken: string[] = [];
  for (const n of notes) {
    const p = parentOf(n);
    if (!p) { roots.push(n.fm.id); continue; }
    if (!byId.has(p) || (ancestors(notes, n.fm.id).length === 0)) { roots.push(n.fm.id); broken.push(n.fm.id); continue; }
    children.set(p, [...(children.get(p) ?? []), n.fm.id]);
  }
  const title = (id: string) => String(byId.get(id)?.fm.title ?? id);
  for (const ids of children.values()) ids.sort((a, b) => title(a).localeCompare(title(b)));
  return { children, roots, broken };
}

// Which project page goes under which (G640, owner's phone 2026-11-03: "all of them are related").
// A page named "X: …", "X, …" or "X – …" is part of the one active project named X or "X (…)"; a page
// with no such name whose own live facts link exactly one other active project is part of that one.
// A page with a parent keeps it; a name two pages share, or a parent whose own chain leads back
// here, is no parent. A parent says the link, so only a fact every reader of the page sees counts
// (audit v11): none hidden from an assistant that sees the page (`hidden`), none more private than
// the page, none shared with one person. Nor is a parent set that some reader of the page can't see
// (`sees`): its cell would drop it, but the run's line on the page would still say there is one.
// Upkeep writes what this plans (src/upkeep.ts step 1c4).
export const pageParentsOn = (rules: Rules) => (rules.policy as { page_parents?: boolean }).page_parents === true;
export interface ParentPlan { id: string; parent?: string; ambiguous?: boolean }
const PART_SEP = /^\s*(?:[,:–—]|\s-)\s*\S/;
const nameOfTitle = (t: string) => t.replace(/\s*\([^()]*\)\s*$/, "").trim().toLowerCase();
export function parentPlan(notes: Note[], hidden: (key: string) => boolean, sees: (child: string, parent: string) => boolean = () => true): ParentPlan[] {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const isProject = (n: Note | undefined): n is Note => !!n && n.fm.type === "project" && n.fm.status === "active" && n.fm.id.startsWith("projects/");
  const projects = notes.filter(isProject);
  const named = new Map<string, string[]>();
  for (const p of projects) { const k = nameOfTitle(String(p.fm.title ?? "")); if (k) named.set(k, [...(named.get(k) ?? []), p.fm.id]); }
  // Title or alias -> the projects it names, for a fact that links by name. Only a project every
  // reader of the page sees counts, so a page outside a reader's view sharing the title never
  // decides it, and a note that is no project can't be a parent anyway (G671).
  const titles = new Map<string, string[]>();
  for (const n of projects) for (const t of new Set([n.fm.title, ...(n.fm.aliases ?? [])].map((x) => String(x ?? "").toLowerCase()).filter(Boolean))) titles.set(t, [...(titles.get(t) ?? []), n.fm.id]);
  const resolve = (to: string, child: string) => { if (byId.has(to)) return to; const ids = (titles.get(to.toLowerCase()) ?? []).filter((id) => sees(child, id)); return ids.length === 1 ? ids[0] : undefined; };
  const loops = (id: string, to: string) => { const seen = new Set<string>(); for (let p: string | undefined = to; p; p = byId.get(p) && parentOf(byId.get(p)!)) { if (p === id) return true; if (seen.has(p)) return false; seen.add(p); } return false; };
  const out: ParentPlan[] = [];
  for (const n of projects) {
    if (parentOf(n)) continue;
    const t = String(n.fm.title ?? "").toLowerCase();
    // Only pages every reader of this one sees are counted, so whether it gets a parent never says
    // what lies outside a reader's view (builder's slice audit F1).
    const among = (x: string) => named.get(x)!.filter((id) => id !== n.fm.id && sees(n.fm.id, id));
    const k = [...named.keys()].filter((x) => t.startsWith(x) && PART_SEP.test(t.slice(x.length)) && !named.get(x)!.includes(n.fm.id) && among(x).length).sort((a, b) => b.length - a.length)[0];
    if (k) {
      const ids = among(k);
      if (ids.length > 1) out.push({ id: n.fm.id, ambiguous: true });
      else if (!loops(n.fm.id, ids[0])) out.push({ id: n.fm.id, parent: ids[0] });
      continue;
    }
    const to = new Set<string>();
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (NOT_PROSE.test(attr) || isDisputed(f) || hidden(`${n.fm.id}#${attr}`)) continue;
      const seen = (r: FactRecord) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity));
      for (const r of records(f).filter(live).filter(seen)) for (const m of shown(r.value).matchAll(/\[\[([^\]|]+)/g)) { const id = resolve(m[1].trim(), n.fm.id); if (id && id !== n.fm.id && isProject(byId.get(id)) && sees(n.fm.id, id)) to.add(id); }
    }
    if (to.size === 1) { const [p] = [...to]; if (!loops(n.fm.id, p)) out.push({ id: n.fm.id, parent: p }); }
  }
  return out;
}

export interface Section { heading?: string; text: string }

// `## ` starts a section; text before the first one has no heading. Deeper headings stay text.
export function sections(body: string): Section[] {
  const out: Section[] = [];
  let cur: Section = { heading: undefined, text: "" };
  for (const line of body.split("\n")) {
    const m = line.match(/^## +(.+?)\s*$/);
    if (m) { if (cur.heading !== undefined || cur.text.trim()) out.push(cur); cur = { heading: m[1], text: "" }; }
    else cur.text += `${line}\n`;
  }
  if (cur.heading !== undefined || cur.text.trim()) out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.text.trim() }));
}

// One section of a page's text with the references it cites, as "## Heading\ntext\n\n[^1]: …",
// or undefined when the page has no such section.
export function sectionWithRefs(body: string, heading: string): string | undefined {
  const f = footnotes(body);
  const sec = sections(f.text).find((x) => x.heading === heading);
  if (!sec) return undefined;
  const cited = new Set([...sec.text.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => m[1]));
  const refs = f.notes.filter((x) => cited.has(x.label)).map((x) => `[^${x.label}]: ${x.text}`);
  return `## ${heading}\n${sec.text}${refs.length ? `\n\n${refs.join("\n")}` : ""}`;
}

export interface Footnote { label: string; n: number; text: string }

// Lines `[^label]: text` are definitions; they leave the text and are numbered in the order the
// text first cites them (then any never cited), one number per distinct reference. A ref with no
// definition stays as written.
export function footnotes(text: string): { text: string; notes: Footnote[] } {
  const defs = new Map<string, string>();
  const kept = text.split("\n").filter((line) => {
    const m = line.match(/^\[\^([^\]\s]+)\]:\s*(.*)$/);
    if (m) defs.set(m[1], m[2].trim());
    return !m;
  }).join("\n").trimEnd();
  const order: string[] = [];
  for (const m of kept.matchAll(/\[\^([^\]\s]+)\]/g)) if (defs.has(m[1]) && !order.includes(m[1])) order.push(m[1]);
  for (const l of defs.keys()) if (!order.includes(l)) order.push(l);
  // Labels with the same reference share its number (the writer gives each fact its own label).
  const byText = new Map<string, number>();
  return { text: kept, notes: order.map((label) => { const text = defs.get(label)!; let n = byText.get(text); if (n === undefined) byText.set(text, n = byText.size + 1); return { label, n, text }; }) };
}

// The wiki's lint (upkeep step 9): review findings only, no model, nothing changed. Details
// name pages, sections and refs, never a line's text. A page is a note with summary: or
// parent:; older notes are left alone. Orphans count only once the brain has a hub page.
// The names and numbers in text the Gardener wrote that the page's own facts don't hold (backlog
// 377): a word with a capital letter that doesn't start a sentence, and any number, must appear in
// `ground` (the page's title, its facts, the notes it links to). Month and day names, "I" and the
// owner's name are always fine; a number matches by value, so "Oct 1" matches 2026-10-01. Prose
// can't be checked for meaning; this catches the names and figures a model makes up.
const ALWAYS = new Set(("i jan feb mar apr may jun jul aug sep sept oct nov dec january february march april june july august september october november december " +
  "mon tue wed thu fri sat sun monday tuesday wednesday thursday friday saturday sunday " +
  "janv fevr fev avr juil aout dec janvier fevrier mars avril mai juin juillet septembre octobre novembre decembre lundi mardi mercredi jeudi vendredi samedi dimanche").split(" "));
const fold = (w: string) => w.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const asNumber = (w: string) => (/^\d+$/.test(w) ? String(Number(w)) : w);
export function ungrounded(text: string, ground: string): string[] {
  const have = new Set(ground.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map((w) => asNumber(fold(w))));
  const out = new Set<string>();
  for (const line of text.replace(/\[\^[^\]\s]+\]/g, " ").split("\n")) {
    // Sentence starts: the line's first word, and the first after . ! ? or :
    let start = true;
    for (const m of line.matchAll(/([\p{L}\p{N}]+)|([.!?:])/gu)) {
      if (m[2]) { start = true; continue; }
      const w = m[1];
      const named = /\p{Lu}/u.test(w) && !start, number = /\d/.test(w);
      start = false;
      if (!named && !number) continue;
      const k = asNumber(fold(w));
      if (!ALWAYS.has(k) && !have.has(k)) out.add(w);
    }
  }
  return [...out];
}

// A model's opening paragraph (owner's yes 2026-11-07, G713, G714): one to three sentences that
// tie a page's facts together, written only from the sentences the page writer already says there.
// It names the labels of the sentences it rests on, at least two, all of them in the hub's text now;
// every name and number it says is in those sentences, the page's title or the owner's name, and so
// is every longer word but a few joining ones ("alongside", "where"). It carries no reference or
// link of its own: its labels go after it, all together, so a read drops it whole once any fact
// behind it is hidden from that reader (view.ts withoutHiddenSentences). Undefined when it fits,
// else why it doesn't.
const JOINING = new Set(("alongside along among where which while whose through together also both their there these those other with within about after before since until because into from your yours".split(" ")));
export const OPENING_MAX = 400;
const stem = (w: string) => fold(w).slice(0, 5);
export function leadSentences(lead: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of lead.split("\n")) {
    if (/^\[\^[^\]\s]+\]:/.test(line)) continue;
    for (const s of line.match(/[^\n]*?(?:\[\^[^\]\s]+\])+/g) ?? [])
      for (const m of s.matchAll(/\[\^([^\]\s]+)\]/g)) out.set(m[1]!, `${out.get(m[1]!) ?? ""} ${s.replace(/\[\^[^\]\s]+\]/g, "")}`.trim());
  }
  return out;
}
const linkTitles = (t: string) => t.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1");
export function openingProblem(text: string, labels: string[], lead: string, also: string[] = []): string | undefined {
  if (!text.trim() || text.length > OPENING_MAX || /\n/.test(text)) return `one paragraph on one line, at most ${OPENING_MAX} characters`;
  if (/\[\^|\[\[|\]\]/.test(text)) return "no reference or link in the text: name the sentences it rests on in labels";
  if ((text.match(/[.!?](?=\s|$)/g) ?? []).length > 3) return "at most three sentences";
  if (!/[.!?]$/.test(text.trim())) return "end it with a full stop";
  const ls = [...new Set(labels)];
  if (ls.length > 16 || ls.some((l) => !/^[A-Za-z0-9_-]{1,60}$/.test(l))) return "labels: at most 16, each a label the page's text uses";
  const said = leadSentences(lead);
  const missing = ls.filter((l) => !said.has(l));
  if (missing.length) return `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} no label of a sentence on this page now`;
  const from = [...new Set(ls.map((l) => said.get(l)!))];
  if (from.length < 2) return "it ties together at least two of the page's sentences; one sentence is said already";
  const ground = linkTitles([...from, ...also].join("\n"));
  const made = ungrounded(text, ground);
  if (made.length) return `${made.slice(0, 5).map((w) => `"${w}"`).join(", ")} ${made.length === 1 ? "is" : "are"} in none of the sentences it cites`;
  const have = new Set(ground.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(stem));
  const words = [...new Set([...text.matchAll(/\p{L}{5,}/gu)].map((m) => m[0]))].filter((w) => !JOINING.has(fold(w)) && !ALWAYS.has(fold(w)) && !have.has(stem(w)));
  if (words.length) return `${words.slice(0, 5).map((w) => `"${w}"`).join(", ")} ${words.length === 1 ? "is" : "are"} in none of the sentences it cites; reword only what they say`;
  return undefined;
}

export interface WikiFinding { rule: string; key: string; kind: "review"; detail: string }

const isPage = (n: Note) => summaryOf(n) !== undefined || parentOf(n) !== undefined;
const REF_RE = new RegExp(`\\b(?:${Object.keys(SCHEMES).map((s) => s.replace(/[-]/g, "\\-")).join("|")}):[^\\s)\\],;]+`, "g");
// A value the owner hasn't seen yet (phone UI spec §7) isn't said on the page, listed or linked.
const live = (r: FactRecord) => !r.valid_to && !r.retired && !r.unseen;
// The source refs a reference names, like gmail:<id> in "Email, Oct 2 (gmail:<id>)".
export const refsIn = (text: string) => [...new Set(text.match(REF_RE) ?? [])];

// One page's own lint: lines in its ## sections without a reference, and references naming a
// source ref none of its current facts cite. Used by wikiLint and by the Gardener's wiki_sync.
export function pageFindings(n: Note): WikiFinding[] {
  const out: WikiFinding[] = [];
  const add = (rule: string, key: string, detail: string) => out.push({ rule, key, kind: "review", detail });
  const f = footnotes(n.body);
  const defined = new Set(f.notes.map((x) => x.label));
  for (const s of sections(f.text)) {
    if (s.heading === undefined) continue;
    const bare = s.text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && ![...l.matchAll(/\[\^([^\]\s]+)\]/g)].some((m) => defined.has(m[1])));
    if (bare.length) add("uncited-line", n.fm.id, `${bare.length} line${bare.length === 1 ? "" : "s"} with no reference, in ${s.heading}`);
  }
  const cited = new Set(Object.values(n.fm.facts ?? {}).flatMap((x) => records(x).filter(live).flatMap((r) => (r.sources ?? []).map((s) => normalizeRef(refString(s))))));
  for (const x of f.notes)
    for (const ref of refsIn(x.text))
      if (!cited.has(normalizeRef(ref))) add("section-drift", n.fm.id, `reference ${x.n} cites ${ref}, which none of this page's facts cite now`);
  return out;
}

export function wikiLint(notes: Note[]): WikiFinding[] {
  const out: WikiFinding[] = [];
  const add = (rule: string, key: string, detail: string) => out.push({ rule, key, kind: "review", detail });
  const tree = pageTree(notes);
  for (const n of notes.filter(isPage)) for (const f of pageFindings(n)) out.push(f);
  for (const id of tree.broken) add("parent-broken", id, `parent: ${parentOf(notes.find((n) => n.fm.id === id)!)} is missing or loops back`);
  const hubs = notes.filter((n) => n.fm.type === "hub");
  if (!hubs.length && notes.some(isPage)) add("missing-hub", "notes/overview", "pages use summary: or parent:, but no page has type: hub");
  if (hubs.length) {
    const linked = new Set(notes.flatMap((n) => linksIn(n.body)));
    for (const n of notes)
      if (n.fm.type !== "hub" && !linked.has(n.fm.id) && !parentOf(n) && !tree.children.has(n.fm.id) && !["merged", "superseded"].includes(n.fm.status))
        add("orphan", n.fm.id, "no page links here, and it has no parent: and no pages under it");
  }
  return out;
}

// Recent updates (docs/wiki.md): one plain line per page a commit touched, newest first. A line
// names the page and the kind of change (a fact's name, a section's heading), never a value or
// a line's text. `visible` drops the pages a reader may not see; the owner passes none.
export interface Update { id: string; text: string; by: string; at: string }

const FEED_DIRS = CONTENT_DIRS.filter((d) => d !== "disputes" && d !== "agents");
const label = (attr: string) => { const w = attr.replace(/[_-]+/g, " ").trim(); return w.charAt(0).toUpperCase() + w.slice(1); };
const an = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
const current = (f: Fact | undefined) => f === undefined ? undefined : JSON.stringify(isDisputed(f) ? f.candidates.map((c) => c.value) : records(f).filter(live).map((r) => r.value));

export function pageChanges(before: Note, after: Note): string[] {
  const t = String(after.fm.title ?? after.fm.id);
  const out: string[] = [];
  if (before.fm.title !== after.fm.title) out.push(`Renamed ${before.fm.title} to ${t}`);
  const bf = before.fm.facts ?? {}, af = after.fm.facts ?? {};
  for (const k of Object.keys(af)) {
    if (!(k in bf)) out.push(`Added the ${label(k)} fact to ${t}`);
    else if (current(bf[k]) !== current(af[k])) out.push(`Changed the ${label(k)} fact on ${t}`);
  }
  for (const k of Object.keys(bf)) if (!(k in af)) out.push(`Removed the ${label(k)} fact from ${t}`);
  const bs = summaryOf(before), as = summaryOf(after);
  if (as !== bs) out.push(!bs ? `Added a summary to ${t}` : !as ? `Removed the summary of ${t}` : `Rewrote the summary of ${t}`);
  if (parentOf(before) !== parentOf(after)) out.push(`Moved ${t} in the page tree`);
  const secs = (n: Note) => new Map(sections(footnotes(n.body).text).map((s) => [s.heading ?? "", s.text]));
  const b = secs(before), a = secs(after);
  for (const [h, text] of a) {
    if (!h) { if ((b.get("") ?? "") !== text) out.push(`Edited the notes of ${t}`); continue; }
    if (!b.has(h)) out.push(`Added ${an(h)} ${h} section to ${t}`);
    else if (b.get(h) !== text) out.push(`Edited the ${h} section of ${t}`);
  }
  for (const h of b.keys()) if (!a.has(h)) out.push(h ? `Removed the ${h} section from ${t}` : `Edited the notes of ${t}`);
  if (!out.length && before.body !== after.body) out.push(`Edited the references of ${t}`);
  return out;
}

export function recentUpdates(root: string, notes: Note[], o: { id?: string; visible?: (id: string) => boolean; limit?: number; commits?: number } = {}): Update[] {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const paths = o.id ? [`${o.id}.md`] : FEED_DIRS;
  const log = git(root, ["log", `-n${o.commits ?? 100}`, "--no-renames", "--name-status", "--format=%x1e%H%x1f%an%x1f%aI", "--", ...paths]);
  const out: Update[] = [];
  const read = (rev: string, path: string) => { const s = git(root, ["show", `${rev}:${path}`]); try { return s ? parseNote(s, path) : undefined; } catch { return undefined; } };
  for (const entry of log.split("\x1e").filter((e) => e.trim())) {
    const [head, ...files] = entry.trim().split("\n");
    const [hash, by, rawAt] = head.split("\x1f");
    const at = gitTime(rawAt ?? "");
    for (const line of files) {
      const [st, path] = line.split("\t");
      if (!path?.endsWith(".md") || st === "D") continue;
      const id = path.slice(0, -3);
      if (!byId.has(id) || (o.visible && !o.visible(id)) || !FEED_DIRS.includes(id.split("/")[0])) continue;
      const after = read(hash, path);
      if (!after) continue;
      const before = st === "A" ? undefined : read(`${hash}^`, path);
      const texts = before ? pageChanges(before, after) : [`New page: ${after.fm.title ?? id}`];
      for (const text of texts) out.push({ id, text, by, at });
      if (out.length >= (o.limit ?? 20)) return out.slice(0, o.limit ?? 20);
    }
  }
  return out;
}

// ---------- the Gardener's wiki sync (slice 4; checks and commit in core.ts gardenerWikiSync) ----------

export interface Rewrite { summary?: string; sections: { heading: string; text: string }[]; references: { label: string; text: string }[] }

// The note with the rewrite applied: the summary replaced, each named section replaced (or added
// at the end), every other section and the text before the first one kept as they were, and the
// given references replacing the definitions with the same label. Facts are never touched.
export function applyRewrite(n: Note, rw: Rewrite): Note {
  const f = footnotes(n.body);
  const secs = sections(f.text);
  for (const w of rw.sections) {
    const at = secs.findIndex((x) => x.heading === w.heading);
    if (at >= 0) secs[at] = { heading: w.heading, text: w.text.trim() };
    else secs.push({ heading: w.heading, text: w.text.trim() });
  }
  const defs = new Map(f.notes.map((x) => [x.label, x.text]));
  for (const r of rw.references) defs.set(r.label, r.text.trim());
  const text = secs.map((x) => (x.heading === undefined ? x.text : `## ${x.heading}\n${x.text}`)).join("\n\n");
  const refs = [...defs].map(([l, t]) => `[^${l}]: ${t}`).join("\n");
  const fm = { ...n.fm };
  if (rw.summary !== undefined) fm.summary = rw.summary.trim();
  return { ...n, fm, body: `${text}${refs ? `\n\n${refs}` : ""}\n` };
}

// Who changed each part of a page last, from its git history: "" is the text before the first
// section, "summary:" the summary, any other key a section heading. Oldest commit first, so the
// last writer wins. A part nobody changed since it appeared belongs to whoever added it.
export function partAuthors(root: string, path: string, commits = 200): Map<string, string> {
  const out = new Map<string, string>();
  const log = git(root, ["log", `-n${commits}`, "--reverse", "--format=%H%x1f%an", "--", path]).split("\n").filter(Boolean);
  const read = (rev: string) => { const s = git(root, ["show", `${rev}:${path}`]); try { return s ? parseNote(s, path) : undefined; } catch { return undefined; } };
  const parts = (n?: Note) => {
    const m = new Map<string, string>();
    if (!n) return m;
    for (const x of sections(footnotes(n.body).text)) m.set(x.heading ?? "", x.text);
    const sum = summaryOf(n);
    if (sum !== undefined) m.set("summary:", sum);
    return m;
  };
  let prev = new Map<string, string>();
  for (const line of log) {
    const [hash, by] = line.split("\x1f");
    const now = parts(read(hash));
    for (const [k, v] of now) if (prev.get(k) !== v) out.set(k, by);
    prev = now;
  }
  return out;
}

// ---------- hand edits (slice 7): an agent can tell a person went in ----------

// Authors that are the hub's own jobs, never a person.
export const HUB_AUTHORS = new Set(["hub", "reflect", "sleep", "upkeep", "relay", "cli", "backup", "pocketBrain", "import", "capture", "pull", "sources", "memsync"]);

// By name, for wiki_sync's "a person wrote it last" (it errs toward a person, which only makes
// the Gardener propose instead of rewrite): neither an agent in policy.yaml nor a hub job.
export function isPersonAuthor(name: string, rules: Rules): boolean {
  return !!name && !(name in rules.policy.agents) && !HUB_AUTHORS.has(name);
}

// A commit made by a person: the hub writes every agent's and job's commit (and the owner's own,
// through the dashboard or CLI) with an @pocketbrain.local address (authorEnv in src/git.ts);
// any other address is someone's own git. By address, so an agent later removed from
// policy.yaml, or a job named nowhere, never reads as the owner.
export function isPersonCommit(email: string): boolean {
  const e = email.trim().toLowerCase();
  return !!e && (!e.endsWith("@pocketbrain.local") || e === "owner@pocketbrain.local" || e === "louis@pocketbrain.local");
}

export interface HandEdits { adopted: string[]; held: { path: string; why: string }[] }

// Notes changed on disk with no commit (a text editor, a sync tool). Each one that parses and
// carries no secret is fine to adopt; the rest are held: left on disk as they are, never
// committed and never put back. A deleted note is held too: deleting is the dashboard's Forget.
export function scanHandEdits(root: string): { ok: string[]; held: { path: string; why: string }[] } {
  const ok: string[] = [], held: { path: string; why: string }[] = [];
  if (!existsSync(join(root, ".git"))) return { ok, held };
  const dirs = CONTENT_DIRS.filter((d) => existsSync(join(root, d)));
  if (!dirs.length) return { ok, held };
  const out = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all", "--no-renames", "--", ...dirs], { cwd: root }).stdout.toString();
  for (const line of out.split("\n").filter(Boolean)) {
    const path = line.slice(3);
    if (!path.endsWith(".md")) continue;
    if (!existsSync(join(root, path))) { held.push({ path, why: "deleted by hand; use Forget on the dashboard instead" }); continue; }
    const text = readFileSync(join(root, path), "utf8");
    const secret = findSecret(text);
    if (secret) { held.push({ path, why: `carries a ${secret}` }); continue; }
    try { parseNote(text, path); } catch { held.push({ path, why: "doesn't parse" }); continue; }
    ok.push(path);
  }
  return { ok, held };
}

// Commit the fine ones as the owner's, in one commit that says it was a hand edit, so whats_new
// and the Recent updates feed show it like any other change. The hub only: a replica commits
// nothing of its own, so it leaves them for its owner.
export function adoptHandEdits(root: string): HandEdits {
  const role = hubRole(root).mode;
  if (role === "replica" || role === "unnamed") return { adopted: [], held: [] };
  const { ok, held } = scanHandEdits(root);
  if (ok.length) {
    // Not commitPaths: on a failed commit it puts files back to HEAD, which would lose the edit.
    // Here a failure only unstages, and the edit stays on disk for the next try.
    const msg = `owner: hand edits (${ok.length} ${ok.length === 1 ? "note" : "notes"})\n\nKind: hand-edit\nFiles: ${ok.join(", ")}`;
    const add = gitRun(root, ["add", "-A", "--", ...ok]);
    let c = add;
    try { if (add.ok) c = gitRun(root, ["commit", "-q", "-m", msg, "--", ...ok], OWNER); }
    catch (e) { c = { ok: false, out: "", err: (e as Error).message }; }
    if (!c.ok) {
      gitRun(root, ["reset", "-q", "--", ...ok]);
      const why = `commit failed: ${(c.err || c.out).split("\n")[0].slice(0, 160)}`;
      return { adopted: [], held: [...held, ...ok.map((path) => ({ path, why }))] };
    }
  }
  return { adopted: ok, held };
}

// ---------- the page writer (outside review 2026-10-25, item 3) ----------
// Every page a commit touched gets an opening paragraph by morning: one plain sentence per live
// fact, each with a reference naming its source, and a line naming the pages its sources also
// name, linked. No model: the text says only what the facts say, so it is grounded by
// construction. The writer owns the opening text only while nobody else wrote it (partAuthors):
// a person's or the Gardener's prose is never replaced. A fact goes in only where every
// assistant that sees the page's text also sees that fact, and a link only where every one of
// them sees the page named, so no reader learns from prose what its view withholds.

const WRITER = "hub";
// A project or decision that no longer stands is not listed among the owner's own (G725).
const DONE = new Set(["archived", "merged", "superseded", "done", "closed", "cancelled", "canceled", "completed"]);
const PAGE_DIRS = new Set(["people", "orgs", "projects", "decisions", "notes"]);
// Contact details are facts, not sentences (and an address in prose is easy to copy on).
const NOT_PROSE = /^(email|emails|phone|phones|mobile|address|home_address|handle|aliases?)$/;
const SOURCE_WORD: Record<string, string> = { gmail: "Email", "gmail-thread": "Email thread", mail: "Email", gcal: "Calendar", slack: "Slack", gdoc: "Document", doc: "Document", zoom: "Call", call: "Call", discord: "Discord", imessage: "Text", granola: "Meeting notes", contacts: "Contact card", url: "Web page", owner: "Your note", louis: "Your note", imsg: "Your text", agent: "An assistant's note", notion: "Notion import", "town-wiki": "An assistant's wiki", "instinct-mem": "An assistant's memory", "town-routine": "An assistant's routine", "agent-relay": "Relayed by an assistant", "agent-log": "An assistant's log", approved: "You approved", prior: "The earlier owner's source", "prior-note": "The earlier owner's note", unverified: "No source given" };

const shown = (v: unknown): string => Array.isArray(v) ? v.map(shown).join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v);
// A value that already reads as what someone did ("sent Sam a request for feedback on …").
const DID = /^(?:[a-z]+ed|sent|met|told|gave|made|wrote|took|got|brought|built|taught|led|ran|knew|is|was|has|had|works|leads|runs|manages|knows|reports|teaches|helps|owns|lives|says|wants|needs|plans|uses)\b/;
// What someone is, where they work or live, is never said as a thing they did, even when it starts
// like a verb ("retired teacher" is a role, not "Hélène Lefebvre retired teacher.", audit v11).
const NOUN_ATTRIBUTE = /^(?:role|title|job|occupation|position|org|company|employer|school|city|kind)$/;
// A next step the owner told as their own to-do ("owe Ben the sample", "need to call Jane"), said
// back to them with "You", on the page as on the home; anything else keeps "Next for".
export function yourToDo(value: string): string | undefined {
  return /^(owe|promised|need to|have to|must|should|have got to|are going to) /i.test(value) ? `You ${value}` : undefined;
}
const MONTHS = MONTHS_SHORT;
// "2026-10-05" reads "5 Oct" in a sentence this year and "5 Oct 2025" from another (the reference
// under the text keeps the whole date); anything else is left as written.
const inWords = (v: string) => v.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => +mo >= 1 && +mo <= 12 ? `${+d} ${MONTHS[+mo - 1]}${y === today().slice(0, 4) ? "" : ` ${y}`}` : m);
// A person is named in full once, then by the first name, the way someone writes about a colleague
// (the owner's canvas, 2026-10-31): never when the first word is a title or an initial ("Dr Lee",
// "M. Dupont", "J. Smith"), or the name is one word.
const TITLE_WORD = /^(?:dr|mr|mrs|ms|mx|m|mme|mlle|prof|monsieur|madame|mademoiselle|miss|sir|dame|rev|fr|sr|st)\.?$/i;
export function firstName(n: Note): string | undefined {
  if (n.fm.type !== "person") return undefined;
  const w = String(n.fm.title ?? "").trim().split(/\s+/);
  return w.length >= 2 && !TITLE_WORD.test(w[0]!) && /^\p{Lu}[\p{L}'’-]+$/u.test(w[0]!) ? w[0] : undefined;
}
// A role read as a title takes "the" ("the design lead at …"); any other is said as the work it is
// ("works as coach tennis at …"), so a role never reads wrong for want of grammar.
const TITLE_NOUN = /(?:^|\s)(?:lead|director|manager|head|coordinator|chair|chairperson|dean|president|officer|editor|founder|co-founder|cofounder|engineer|designer|developer|analyst|advisor|adviser|professor|lecturer|teacher|instructor|consultant|partner|specialist|architect|scientist|owner|administrator|secretary|treasurer|recruiter|researcher|associate|assistant|producer|principal|counsel|accountant|strategist|writer|librarian|nurse|physician|doctor|lawyer|attorney|vp|ceo|cto|cfo|coo|cio|ciso|cpo|cmo)$/i;
const titleRole = (role: string) => { const head = role.trim().split(/\s+(?:of|for)\s+/i)[0]!; return TITLE_NOUN.test(head) || /^[A-Z]{2,5}$/.test(head.split(/\s+/).at(-1)!); };
const whose = (t: string) => /s$/.test(t) ? `${t}'` : `${t}'s`;
// One sentence per fact, shaped by what kind of value it is (rules/checks.yaml: a date, a list,
// a link, an address) rather than by its name, so any attribute reads as words.
function sentence(n: Note, attr: string, values: string[], owner: string[] = [], spec: AttributeSpec = {}, called?: string): string {
  const full = String(n.fm.title ?? n.fm.id), t = called ?? full, words = values.map((x) => inWords(x).replace(/\.$/, ""));
  const v = words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}` : words[0];
  const person = n.fm.type === "person", lab = label(attr).toLowerCase(), many = words.length > 1;
  // On someone else's page the owner is "you", the way a person would write it to them:
  // "Ana Diaz sent you a request for feedback on …", not "Relationship of Ana Diaz: sent Sam …".
  if (person && !many && !NOUN_ATTRIBUTE.test(attr) && DID.test(v) && /\s/.test(v) && !owner.some((o) => o.toLowerCase() === full.toLowerCase())) {
    let said = v;
    for (const o of owner) said = said.replace(new RegExp(`\\b${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:'s|’s)?\\b`, "g"), (m) => /s$/.test(m) && m !== o ? "your" : "you");
    return `${t} ${said}.`;
  }
  // A few attributes say the same thing every page does, so they read as a person would say it.
  if (attr === "relationship" && person) return `How you know ${t}: ${v}.`;
  // Upkeep's guess from the surname (src/family.ts): said as a guess, linking the owner's page.
  if (attr === "family" && person) return `${t} may be family: same surname as ${v}.`;
  // A role is said as the role it is: "the" in front only fits some ("the coach tennis" doesn't).
  if (attr === "role") return `${whose(t)} role is ${v}.`;
  if (attr === "org" && person) return `${t} works at ${v}.`;
  // A person's role and org, from the same facts, are one sentence (the merge in pageLead).
  if (attr === "role+org" && person) { const [role, org] = words; return /^(?:a|an|the)\s/i.test(role!) ? `${t} is ${role} at ${org}.` : titleRole(role!) ? `${t} is the ${role} at ${org}.` : `${t} works as ${role} at ${org}.`; }
  // A preference is the words it was said in, one after the other (G490).
  if (attr === "prefers" && person) return `How ${t} likes things: ${words.join("; ")}.`;
  if (attr === "last_contact") return `You were last in touch with ${t} on ${v}.`;
  if (attr === "status") return `${t} is ${v}.`;
  // A plan or a date something is due: what happens, and on which day if it names one.
  if (attr === "next_step" && !many && yourToDo(v!)) return `${yourToDo(v!)!}.`;
  if (spec.ends_on_date || spec.shelf_life === "until_date") return `${attr === "next_step" ? "Next" : label(attr)} for ${t}: ${v}.`;
  if (spec.normalize === "date") return `${whose(t)} ${lab} ${many ? "dates are" : "is"} ${v}.`;
  // A short value is said in one breath; a long one is quoted as the source gave it.
  if (v.split(/\s+/).length <= 8 && !/[.;:!?]\s/.test(v)) return person || n.fm.type === "org" ? `${whose(t)} ${lab} ${many ? "are" : "is"} ${v}.` : `The ${lab} of ${t} ${many ? "are" : "is"} ${v}.`;
  return `On ${t}, the ${lab}: ${v}.`;
}
// What kind of source it is, in words: an assistant's own note names the assistant; a kind the
// hub has no word for is named by its scheme ("Import"), never just "Source".
export function sourceWord(ref: string): string {
  const scheme = ref.match(/^([a-z-]+):/)?.[1] ?? ref.match(/^[a-z-]+$/)?.[0] ?? "";
  const who = scheme === "agent" ? ref.match(/^agent:([A-Za-z][\w-]{0,39})\//)?.[1] : undefined;
  if (who) return `${who.charAt(0).toUpperCase()}${who.slice(1)}'s note`;
  return SOURCE_WORD[scheme] ?? (scheme ? `${scheme.charAt(0).toUpperCase()}${scheme.slice(1).replace(/-/g, " ")}` : "Source");
}
// Who stands behind a fact with no checked source (Mac sweep 2026-11-07: "No source given" under
// facts an assistant had filed as unverified): an assistant's note, never which one (G720), the owner's own
// word, or the hub's guess from two names (family.ts, G546; G721). Undefined when nobody is known.
function teller(r: FactRecord): string | undefined {
  const by = String(r.by ?? "").trim();
  if (!by) return undefined;
  if (/^(owner|louis)$/i.test(by)) return SOURCE_WORD.owner;
  if (/^(hub|reflect)$/i.test(by)) return r.confidence === "inferred" ? "Guessed from the names" : undefined;
  // Never the assistant's name: page text reaches every reader, and an agent never learns which
  // other assistants exist (agentRecord strips by; G30; builder's slice audit of G720).
  return SOURCE_WORD.agent;
}
export function reference(r: FactRecord): string {
  const refs = (r.sources ?? []).map((s) => normalizeRef(refString(s)));
  const ids = refs.filter((x) => x.includes(":"));
  const unchecked = refs.every((x) => x === "unverified");
  const word = unchecked ? teller(r) ?? SOURCE_WORD.unverified : sourceWord(refs[0]!);
  return `${word}, ${r.as_of}${ids.length ? ` (${ids.join(", ")})` : ""}`;
}
// Every way a page may still say this fact's reference: today's, and the one a writer before G720
// wrote ("No source given" for a fact with no checked source). A read matches a footnote to a hidden
// fact by these (view.ts), so a page not yet rewritten still drops that fact's sentence.
export function referenceForms(r: FactRecord): string[] {
  const now = reference(r);
  const refs = (r.sources ?? []).map((s) => normalizeRef(refString(s)));
  const ids = refs.filter((x) => x.includes(":"));
  const was = `${refs.length ? sourceWord(refs[0]!) : SOURCE_WORD.unverified}, ${r.as_of}${ids.length ? ` (${ids.join(", ")})` : ""}`;
  return was === now ? [now] : [now, was];
}
// Text as bare lower-case words, for "does the page already say this": no references, links read
// as their words, punctuation as spaces.
const plainWords = (t: string) => t.replace(/\[\^[^\]\s]+\]/g, "").replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Source refs written into old text ("(gmail:<id>)", "see gmail:<id>") as references: the kind and,
// when a fact of the page cites the same item, its date; the id stays in the reference, never in
// the sentence a reader sees.
const REF_TOKEN = String.raw`\b(?:gmail|gcal|notion|imsg|imessage|discord|granola|slack|gdoc|zoom|contacts):[A-Za-z0-9._@/-]*[A-Za-z0-9]`;
// A mail's id the way older assistants wrote it into their text: "Gmail 1a0b…", "an email, 1a0b…",
// "decline: 1a0b…" (a Gmail message id is 16 hex digits); and "notion: <32 hex>".
const GMAIL_WORD = /(\b(?:e-?mail|thread|message|reply)\b,?\s+)?\b(?:Gmail\s+)?(?<!:)([0-9a-f]{16})\b/gi; // never the id inside "gmail:<id>", which the ref passes below take whole
const NOTION_SPACED = /\bnotion:\s+([0-9a-f]{32})\b/gi;
// The same ids as words for a reader, wherever someone wrote them into a page's text (the note page
// and the phone page): "an email", never the id. The file keeps them; assistants check sources by them.
export function idsAsWords(text: string): string {
  const word = (ref: string) => { const w = sourceWord(ref).toLowerCase(); return `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`; };
  return text
    .replace(NOTION_SPACED, "a Notion import")
    .replace(GMAIL_WORD, (_m, pre: string | undefined) => pre ? pre.replace(/,?\s+$/, "") : "an email")
    .replace(new RegExp(String.raw`\s*[(\[]\s*${REF_TOKEN}(?:\s*[,;]\s*${REF_TOKEN})*\s*[)\]]`, "g"), "")
    .replace(new RegExp(REF_TOKEN, "g"), word);
}
function inlineRefs(text: string, recs: FactRecord[], defs: Map<string, string>): string {
  const label = (ref: string) => {
    const lab = `e-${itemOf(ref).split(":")[1].replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(-12)}`;
    const rec = recs.find((r) => (r.sources ?? []).some((x) => itemOf(refString(x)) === itemOf(ref)));
    if (!defs.has(lab)) defs.set(lab, `${sourceWord(ref)}${rec?.as_of ? `, ${rec.as_of}` : ""} (${ref})`);
    return `[^${lab}]`;
  };
  return text
    .replace(NOTION_SPACED, (_m, id: string) => `a Notion import${label(`notion:${id}`)}`)
    .replace(GMAIL_WORD, (_m, pre: string | undefined, id: string) => `${pre ? pre.replace(/,?\s+$/, "") : "an email"}${label(`gmail:${id.toLowerCase()}`)}`)
    .replace(new RegExp(String.raw`\s*[(\[]\s*(${REF_TOKEN}(?:\s*[,;]\s*${REF_TOKEN})*)\s*[)\]]`, "g"), (_m, list: string) => list.split(/\s*[,;]\s*/).map(label).join(""))
    .replace(new RegExp(String.raw`(?:,?\s*(?:see|from|via|source:?)\s+)?(${REF_TOKEN})`, "gi"), (_m, ref: string) => label(ref));
}
// The ref without its version (gmail:<id>@<version> and gmail:<id> name one item).
const itemOf = (ref: string) => normalizeRef(ref).replace(/@[^@/]*$/, "");

// Source item -> the name keys it carries: from the capture record (pull.ts distil records
// `name_keys`) and from the night's backfill for items read before keys were kept (NAME_KEYS_FILE).
export const NAME_KEYS_FILE = join("log", "sources", "name-keys.jsonl");
function keysBySource(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (ref: string, keys: unknown[]) => out.set(itemOf(ref), [...new Set([...(out.get(itemOf(ref)) ?? []), ...keys.map(String)])]);
  for (const d of CAPDIRS) {
    if (!existsSync(join(root, d))) continue;
    for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith(".md"))) {
      const head = readFileSync(join(root, d, f), "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1];
      if (!head || !head.includes("name_keys:")) continue;
      try {
        const fm = YAML.parse(head) as { source_ref?: string; name_keys?: unknown };
        if (typeof fm.source_ref === "string" && Array.isArray(fm.name_keys)) add(fm.source_ref, fm.name_keys);
      } catch { /* a record that doesn't parse names nothing */ }
    }
  }
  const file = join(root, NAME_KEYS_FILE);
  if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    try { const r = JSON.parse(line) as { ref?: string; keys?: unknown }; if (typeof r.ref === "string" && Array.isArray(r.keys)) add(r.ref, r.keys); } catch { /* skip a torn line */ }
  }
  return out;
}

// Source item -> the pages it names, matched against today's titles and aliases that fit exactly
// one note (the linking rule).
function namesBySource(root: string, notes: Note[], owner: string): Map<string, string[]> {
  const byKey = new Map<string, string>();
  for (const u of nameIndex(notes, [owner]).values()) if (u.ids.length === 1) byKey.set(nameKey(u.name), u.ids[0]);
  const out = new Map<string, string[]>();
  for (const [ref, keys] of keysBySource(root)) {
    const ids = keys.map((k) => byKey.get(k)).filter((x): x is string => !!x);
    if (ids.length) out.set(ref, [...new Set(ids)]);
  }
  return out;
}

// The pages a commit since `since` touched that the page writer writes.
function touchedPages(root: string, notes: Note[], since: string, always?: string): Note[] {
  const touched = new Set(git(root, ["log", `--since=${since}`, "--name-only", "--format="]).split("\n").filter((p) => p.endsWith(".md")));
  return notes.filter((n) => (touched.has(n.path) || n.fm.id === always) && PAGE_DIRS.has(n.fm.id.split("/")[0]) && n.fm.type !== "hub" && !["archived", "merged", "superseded"].includes(String(n.fm.status)));
}

export const NAME_KEYS_PER_NIGHT = 20;
// Sources read before the hub kept name keys (2026-10-26) name nothing, so their pages link
// nothing. Each night the hub reads again, through the listed source (fetchOne, the recheck's
// path), up to `max` of the items the touched pages' live facts cite that have no keys yet, and
// keeps only the hashes (nameKeys), never the words. An item it can't read is noted with its
// reason and not tried again. One hub commit with a why. Returns how many items it read.
export async function backfillNameKeys(root: string, since: string, max = NAME_KEYS_PER_NIGHT): Promise<{ read: number; failed: number }> {
  if (hubRole(root).mode === "replica") return { read: 0, failed: 0 };
  const { fetchOne } = await import("./pull");
  const have = keysBySource(root);
  const file = join(root, NAME_KEYS_FILE);
  const tried = new Set(existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [itemOf(String((JSON.parse(l) as { ref?: string }).ref))]; } catch { return []; } }) : []);
  const want: string[] = [];
  for (const n of touchedPages(root, loadBrain(root), since))
    for (const f of Object.values(n.fm.facts ?? {})) for (const r of records(f).filter(live)) for (const s of r.sources ?? []) {
      const ref = normalizeRef(refString(s));
      if (/^(gmail|mail|gcal|gdoc|discord|imessage|granola):/.test(ref) && !have.has(itemOf(ref)) && !tried.has(itemOf(ref)) && !want.includes(ref)) want.push(ref);
    }
  let read = 0, failed = 0;
  const lines: string[] = [];
  for (const ref of want.slice(0, max)) {
    const it = await fetchOne(root, ref).catch((e: Error) => e.message);
    if (typeof it === "string" || it.gone) { failed++; lines.push(JSON.stringify({ ref, keys: [], why: typeof it === "string" ? it.slice(0, 120) : "gone", at: today() })); continue; }
    lines.push(JSON.stringify({ ref, keys: nameKeys(redactSecrets([it.text, it.subject].filter(Boolean).join("\n")).text), at: today() }));
    read++;
  }
  if (!lines.length) return { read, failed };
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  appendFileSync(file, lines.join("\n") + "\n");
  git(root, ["add", "--", NAME_KEYS_FILE]);
  git(root, ["commit", "-q", "-m", `hub: name keys for ${read} source item(s)\n\nWhy: they were read before the hub kept name keys, so the pages citing them linked to nothing; hashes only, never the words.\nKind: name-keys`], "hub");
  return { read, failed };
}

// The opening text for one page, with its references, or undefined when no fact may be said.
const FAMILY_ATTRS = new Set(["family", "relationship"]);
// How many other pages a page's sources tie it to, at most (G624).
export const TIES = 3;
// How the pages a page links are tied to each other (G685-G687): "on" an org's people on a project,
// "at" where a project's people work, "with" who else is on a person's project, "too" who else is
// at a person's org. `base` are the page's own facts the sentence rests on, each member's `recs`
// the facts that put that member in it.
// How the owner knows someone as a plain noun, for "…: your colleagues." (G703): "a student",
// "Robin's TA" and "the kitchen contractor" read as one; a value that says what they do ("works
// with Robin on Atlas", "hosts the book club") or whose they are ("Priya's peer") never does.
const FUNCTION_WORD = /\b(?:the|a|an|with|on|in|at|for|of|from|to|and|or|by|as|about|who|that)\b/i;
export function nounOf(v: string, owner: string[]): string | undefined {
  let w = v.trim().replace(/^(?:a|an|the|your|my)\s+/i, "");
  for (const o of owner) w = w.replace(new RegExp(`^${o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:'s|’s)\\s+`, "i"), "");
  if (!w || DID.test(w) || FUNCTION_WORD.test(w) || /['’]s\b/.test(w) || w.split(/\s+/).length > 3) return undefined;
  return w;
}
export type Related = { kind: "on" | "at" | "with" | "too"; group: string; base: FactRecord[]; members: { id: string; recs: FactRecord[] }[] };
// At most this many such sentences on a page; a person's names at most RELATED_NAMES pages, an
// org's or a project's twice that, and a tie with more says nothing rather than some of them.
export const RELATED = 4, RELATED_NAMES = 6;
export function pageLead(n: Note, o: { hidden: (key: string) => boolean; blind: (to: string) => boolean; names: Map<string, string[]>; byId: Map<string, Note>; resolve?: (link: string) => string | undefined; owner?: string[]; spec?: (attr: string) => AttributeSpec; members?: { id: string; recs: FactRecord[] }[]; namedIn?: { from: string; rec: FactRecord }[]; seeAlso?: { from: string; attr?: string; rec: FactRecord }[]; related?: Related[]; said?: string; self?: boolean; ownerPage?: string }): { text: string; refs: { label: string; text: string }[] } | undefined {
  const lines: string[] = [], refs: { label: string; text: string }[] = [];
  const seen = new Map<string, Set<string>>(); // page named -> labels of the facts whose source names it
  // Links in a sentence written by the id they resolve to, so every reader resolves them; one some
  // reader of this page can't see reads as its plain name.
  const linkWords = (s: string) => s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, to: string, words?: string) => { const id = o.resolve?.(to); return id && !o.blind(id) ? `[[${id}|${words ?? o.byId.get(id)?.fm.title ?? to}]]` : (words ?? (id === to ? o.byId.get(id)?.fm.title : undefined) ?? to); });
  const facts: { attr: string; vals: string[]; labs: string[]; waits: boolean }[] = [];
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (NOT_PROSE.test(attr) || isDisputed(f) || o.hidden(`${n.fm.id}#${attr}`)) continue;
    // The owner's own page says what is true of him, not how he knows himself (G624).
    if (o.self && attr === "relationship") continue;
    const recs = records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity)) && r.value !== undefined && r.value !== null && shown(r.value).trim());
    if (!recs.length || recs.some((r) => findSecret(shown(r.value)))) continue;
    // A value a section of the page already says (the Gardener's "Your relationship") isn't said twice.
    if (o.said && recs.every((r) => { const k = plainWords(shown(r.value)).slice(0, 40); return k.length >= 20 && o.said!.includes(k); })) continue;
    // Facts with the same references share one footnote, so a reader sees one number, not two for one email.
    const text = [...new Set(recs.map(reference))].join("; ");
    // Each fact keeps its own label (pf-<attr>), even when another fact cites the same mail: an
    // agent's read drops exactly the sentences of a fact hidden from it (scrubPage in view.ts), and
    // footnotes() gives labels with the same reference one number, so the owner still reads one.
    const lab = `pf-${attr.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    const waits = !isList(f) && typeof (f as { contested?: unknown }).contested === "string";
    // A value that links to a page is written by its id, so every reader resolves it; one nobody
    // made yet, or that some reader of this page can't see, reads as its plain name.
    // A person's org written as plain words ("Town") links when it is the title of exactly one org
    // page; a value that is a page's id ("orgs/town") is that page, read by its name.
    const vals = recs.flatMap((r) => Array.isArray(r.value) ? r.value.map(shown) : [shown(r.value)]).map((v) => { if (v.includes("[[")) return v; if (o.byId.has(v.trim())) return `[[${v.trim()}]]`; if (attr !== "org" || n.fm.type !== "person") return v; const id = o.resolve?.(v.trim()); return id && o.byId.get(id)?.fm.type === "org" ? `[[${v.trim()}]]` : v; });
    facts.push({ attr, vals, labs: [lab], waits });
    if (!refs.some((x) => x.label === lab)) refs.push({ label: lab, text });
    for (const r of recs) for (const s of r.sources ?? []) for (const to of o.names.get(itemOf(refString(s))) ?? [])
      if (to !== n.fm.id && to !== o.ownerPage && o.byId.has(to) && !o.blind(to)) seen.set(to, (seen.get(to) ?? new Set()).add(lab));
  }
  // A person's role and org are one sentence, where the first of them stood, with both their
  // references ("Maya Chen is the design lead at Harbourline Software."); a list or a value
  // waiting to be checked keeps its own sentence.
  const role = facts.findIndex((x) => x.attr === "role"), org = facts.findIndex((x) => x.attr === "org");
  if (n.fm.type === "person" && role >= 0 && org >= 0 && [role, org].every((i) => facts[i]!.vals.length === 1 && !facts[i]!.waits)) {
    const both = { attr: "role+org", vals: [facts[role]!.vals[0]!, facts[org]!.vals[0]!], labs: [...new Set([...facts[role]!.labs, ...facts[org]!.labs])], waits: false };
    facts.splice(Math.max(role, org), 1);
    facts.splice(Math.min(role, org), 1, both);
  }
  // The full name once, then the first name.
  const short = firstName(n);
  // A class the owner teaches or takes (G712, src/teaching.ts), said with its school when every
  // reader may see the course's org fact: "You teach [[projects/prod-20410|PROD 20410]] at
  // [[orgs/north-college|North College]]."
  const schoolOf = (course: string) => {
    const c = o.byId.get(course);
    const f = c?.fm.facts?.org;
    if (!c || !f || isDisputed(f) || o.blind(course) || o.hidden(`${course}#org`)) return undefined;
    const recs = records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity)));
    const to = [...new Set(recs.flatMap((r) => [...shown(r.value).matchAll(/\[\[([^\]|]+)/g)].map((m) => o.resolve?.(m[1]!) ?? m[1]!)))];
    return to.length === 1 && o.byId.has(to[0]!) && !o.blind(to[0]!) ? { org: to[0]!, recs } : undefined;
  };
  const CLASS_VERB: Record<string, string> = { teaches: "teach", takes: "take" };
  // On the course page itself: "You teach PROD 20410 at North College.", in place of its org fact's
  // sentence, cited by both facts (G712).
  const meNow = o.ownerPage && !o.self && !o.blind(o.ownerPage) ? o.byId.get(o.ownerPage) : undefined;
  const classOf = (attr: string) => {
    const f = meNow?.fm.facts?.[attr];
    if (!f || isDisputed(f) || o.hidden(`${meNow!.fm.id}#${attr}`)) return undefined;
    const recs = records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity)));
    return { recs, ids: [...new Set(recs.flatMap((r) => [...shown(r.value).matchAll(/\[\[([^\]|]+)/g)].map((m) => o.resolve?.(m[1]!) ?? m[1]!)))] };
  };
  const mine = Object.keys(CLASS_VERB).map((a) => ({ a, c: classOf(a) })).find((x) => x.c?.ids.includes(n.fm.id));
  const course = mine ? schoolOf(n.fm.id) : undefined;
  for (const x of facts) {
    if (course && x.attr === "org") {
      const lab = `p-in-${meNow!.fm.id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      if (!refs.some((r) => r.label === lab)) refs.push({ label: lab, text: [...new Set(mine!.c!.recs.map(reference))].join("; ") });
      lines.push(`You ${CLASS_VERB[mine!.a]} ${n.fm.title ?? n.fm.id} at [[${course.org}|${o.byId.get(course.org)!.fm.title ?? course.org}]].${x.labs.map((l) => `[^${l}]`).join("")}[^${lab}]`);
      continue;
    }
    const verb = o.self ? CLASS_VERB[x.attr] : undefined;
    const ids = verb ? [...new Set(records(n.fm.facts![x.attr]!).filter(live).flatMap((r) => [...shown(r.value).matchAll(/\[\[([^\]|]+)/g)].map((m) => o.resolve?.(m[1]!) ?? m[1]!)))].filter((id) => o.byId.has(id) && !o.blind(id)) : [];
    if (verb && ids.length) {
      const parts = ids.map((id) => { const sc = schoolOf(id); return `[[${id}|${o.byId.get(id)!.fm.title ?? id}]]${sc ? ` at [[${sc.org}|${o.byId.get(sc.org)!.fm.title ?? sc.org}]]` : ""}`; });
      lines.push(`You ${verb} ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}.${x.labs.map((l) => `[^${l}]`).join("")}${ids.map((id) => { const sc = schoolOf(id); return sc ? `[^p-at-${id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}]` : ""; }).join("")}`);
      for (const id of ids) { const sc = schoolOf(id); const lab = `p-at-${id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`; if (sc && !refs.some((r) => r.label === lab)) refs.push({ label: lab, text: [...new Set(sc.recs.map(reference))].join("; ") }); }
      continue;
    }
    const said = linkWords(sentence(n, x.attr, x.vals, o.owner, o.spec?.(x.attr), lines.length && short ? short : undefined));
    lines.push(`${said}${x.labs.map((l) => `[^${l}]`).join("")}${x.waits ? " A different value is waiting to be checked." : ""}`);
  }
  // The pages whose title names the course ("PROD 20410: intra exam due …") gather on it (G712).
  if (course) {
    const code = String(n.fm.title ?? "");
    const on = code.length >= 5 ? [...o.byId.values()].filter((p) => p.fm.id !== n.fm.id && p.fm.type !== "person" && p.fm.type !== "org" && !o.blind(p.fm.id) && String(p.fm.title ?? "").includes(code) && !["archived", "merged", "superseded"].includes(String(p.fm.status))).sort((a, b) => String(a.fm.title).localeCompare(String(b.fm.title))) : [];
    // All of them or none: a list cut by the alphabet would read as all of them.
    const cited = on.map((p) => ({ p, recs: Object.keys(p.fm.facts ?? {}).filter((a) => !o.hidden(`${p.fm.id}#${a}`)).flatMap((a) => { const f = p.fm.facts![a]!; return isDisputed(f) ? [] : records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity))); }) })).filter((x) => x.recs.length);
    if (cited.length && cited.length <= 2 * RELATED_NAMES) {
      const l = cited.map((x) => `[[${x.p.fm.id}|${x.p.fm.title ?? x.p.fm.id}]]`);
      lines.push(`About it: ${l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0]}.${cited.map((x) => { const lab = `p-see-${x.p.fm.id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`; if (!refs.some((r) => r.label === lab)) refs.push({ label: lab, text: [...new Set(x.recs.map(reference))].join("; ") }); return `[^${lab}]`; }).join("")}`);
    }
  }
  const called = lines.length && short ? short : String(n.fm.title ?? n.fm.id);
  // The people whose org fact names this page, each cited by that fact's sources: a page they
  // link to links back, from facts, never guessed.
  const T = String(n.fm.title ?? n.fm.id);
  const slug = (id: string) => id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase(); // never another fact's label: a read drops it by the page it names (G607)
  // Two pages with the same last name (projects/atlas, decisions/atlas) share a label: its
  // reference then carries both pages' sources, never only the first's (G733, backlog 423).
  const cite = (lab: string, recs: FactRecord[]) => {
    const have = refs.find((x) => x.label === lab), add = [...new Set(recs.map(reference))];
    if (!have) refs.push({ label: lab, text: add.join("; ") });
    else { const was = have.text.split("; "); have.text = [...new Set([...was, ...add])].join("; "); }
    return `[^${lab}]`;
  };
  // One value of another page's fact, as plain words, when this page may say it (G702, G703).
  const said = (id: string, attr: string) => {
    const f = o.byId.get(id)?.fm.facts?.[attr];
    if (!f || isDisputed(f) || o.hidden(`${id}#${attr}`)) return undefined;
    const recs = records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity)) && typeof r.value === "string");
    const v = recs.length === 1 ? String(recs[0]!.value).trim() : "";
    return v && /^[\p{L}][\p{L} '’-]*$/u.test(v) && v.split(/\s+/).length <= 4 && !findSecret(v) ? { v, recs } : undefined;
  };
  // The people whose org fact names this page, each cited by that fact's sources: a page they
  // link to links back, from facts, never guessed.
  const all = (o.members ?? []).filter((m) => m.id !== n.fm.id && o.byId.has(m.id) && !o.blind(m.id)).sort((a, b) => String(o.byId.get(a.id)!.fm.title ?? a.id).localeCompare(String(o.byId.get(b.id)!.fm.title ?? b.id)));
  // The owner's own tie opens the page, from his own role and org facts, never his name in the list
  // (owner, 2026-11-07: "it should have understood by then that I teach there"; G702).
  const own = o.ownerPage && !o.self ? all.find((m) => m.id === o.ownerPage) : undefined;
  if (own) {
    const role = said(own.id, "role");
    const r = role?.v;
    const how = !r ? `You work at ${T}.` : /^(?:a|an|the)\s/i.test(r) ? `You are ${r} at ${T}.` : /^\p{Ll}+$/u.test(r) ? `You work as ${/^[aeiou]/i.test(r) ? "an" : "a"} ${r} at ${T}.` : titleRole(r) ? `You are the ${r} at ${T}.` : `You work as ${r} at ${T}.`;
    // The role's own label (p-in-<owner>): a read drops the sentence once that fact is hidden too.
    lines.unshift(`${how}${cite(`p-at-${slug(own.id)}`, own.recs)}${role ? cite(`p-in-${slug(own.id)}`, role.recs) : ""}`);
  }
  // The classes the owner teaches or takes at this school open the page before his work tie (G712):
  // "You teach [[projects/prod-20410|PROD 20410]] here.", cited by his fact (p-in-<owner>) and the
  // course's org fact (p-at-<course>), each checked again when a reader reads it.
  const me = o.ownerPage && !o.self && !o.blind(o.ownerPage) ? o.byId.get(o.ownerPage) : undefined;
  for (const [attr, verb] of me ? Object.entries(CLASS_VERB).reverse() : []) {
    const f = me!.fm.facts?.[attr];
    if (!f || isDisputed(f) || o.hidden(`${me!.fm.id}#${attr}`)) continue;
    const recs = records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity)));
    const here = [...new Set(recs.flatMap((r) => [...shown(r.value).matchAll(/\[\[([^\]|]+)/g)].map((m) => o.resolve?.(m[1]!) ?? m[1]!)))].filter((id) => o.byId.has(id) && schoolOf(id)?.org === n.fm.id);
    if (!here.length) continue;
    const l = here.map((id) => `[[${id}|${o.byId.get(id)!.fm.title ?? id}]]`);
    lines.unshift(`You ${verb} ${l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0]} here.${cite(`p-in-${slug(me!.fm.id)}`, recs)}${here.map((id) => cite(`p-at-${slug(id)}`, schoolOf(id)!.recs)).join("")}`);
  }
  const members = all.filter((m) => m.id !== o.ownerPage).slice(0, 12);
  if (members.length) {
    const list = (ms: typeof members) => { const l = ms.map((m) => `[[${m.id}|${o.byId.get(m.id)!.fm.title ?? m.id}]]`); return l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0]!; };
    // Said by how the owner knows them (their relationship fact, a few plain words), then the rest
    // (G703): "Ana Diaz and Ben Roy work at North College: your colleagues."
    const groups = new Map<string, { word: string; ms: typeof members; recs: Map<string, FactRecord[]> }>();
    const rest: typeof members = [];
    for (const m of members) {
      const rel = said(m.id, "relationship");
      const word = rel ? nounOf(rel.v, o.owner ?? []) : undefined;
      if (!rel || !word) { rest.push(m); continue; }
      const g = groups.get(word.toLowerCase()) ?? groups.set(word.toLowerCase(), { word, ms: [], recs: new Map() }).get(word.toLowerCase())!;
      g.ms.push(m); g.recs.set(m.id, rel.recs);
    }
    const plural = (w: string) => w.replace(/(\p{L}+)$/u, (x) => /(?:s|x|z|ch|sh)$/i.test(x) ? `${x}es` : /[^aeiou]y$/i.test(x) ? `${x.slice(0, -1)}ies` : `${x}s`);
    for (const g of [...groups.values()].sort((a, b) => b.ms.length - a.ms.length || a.word.localeCompare(b.word))) {
      const one = g.ms.length === 1;
      const labs = g.ms.map((m) => `${cite(`p-at-${slug(m.id)}`, m.recs)}${cite(`p-in-${slug(m.id)}`, g.recs.get(m.id)!)}`).join("");
      lines.push(`${list(g.ms)} ${one ? "works" : "work"} at ${T}: your ${one ? g.word : plural(g.word)}.${labs}`);
    }
    if (rest.length) lines.push(`${list(rest)} ${rest.length > 1 ? "work" : "works"} at ${T}.${rest.map((m) => cite(`p-at-${slug(m.id)}`, m.recs)).join("")}`);
  }
  // The owner's own page lists his live projects and standing decisions (G725, north star
  // 2026-11-07: pages holding no person, org or project fact had no page linking them), one
  // sentence per area when they span more than one: "Your work projects: [[projects/atlas|Atlas]]
  // and …". Never a page more private than his, or one some reader of his page can't see; each
  // name cited by that page's own facts (p-see-<page>, which a read checks against that page:
  // view.ts). All of them or none (G703, G726): past 2 * RELATED_NAMES an area says nothing, and a
  // read drops the whole sentence when one of its pages or facts is hidden from the reader.
  if (o.self) {
    const rank = sensitivityRank(n.fm.sensitivity);
    for (const [type, word] of [["project", "projects"], ["decision", "decisions"]] as const) {
      const cited = [...o.byId.values()].filter((p) => p.fm.type === type && PAGE_DIRS.has(p.fm.id.split("/")[0]!) && !DONE.has(String(p.fm.status)) && !o.blind(p.fm.id) && sensitivityRank(p.fm.sensitivity) <= rank)
        .map((p) => ({ p, recs: Object.entries(p.fm.facts ?? {}).filter(([a, f]) => !NOT_PROSE.test(a) && !isDisputed(f) && !o.hidden(`${p.fm.id}#${a}`)).flatMap(([, f]) => records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= rank) && r.value !== undefined && r.value !== null)) }))
        .filter((x) => x.recs.length);
      const areas = new Map<string, typeof cited>();
      for (const x of cited) { const a = String(x.p.fm.area ?? ""); (areas.get(a) ?? areas.set(a, []).get(a)!).push(x); }
      for (const [area, xs] of [...areas].sort(([a], [b]) => a.localeCompare(b))) {
        if (xs.length > 2 * RELATED_NAMES) continue;
        // Decisions newest first, projects by name.
        xs.sort((a, b) => type === "decision" ? String(b.p.fm.decided_on ?? b.p.fm.created ?? "").localeCompare(String(a.p.fm.decided_on ?? a.p.fm.created ?? "")) || String(a.p.fm.title).localeCompare(String(b.p.fm.title)) : String(a.p.fm.title ?? a.p.fm.id).localeCompare(String(b.p.fm.title ?? b.p.fm.id)));
        const l = xs.map((x) => `[[${x.p.fm.id}|${x.p.fm.title ?? x.p.fm.id}]]`);
        const what = areas.size > 1 && /^[a-z][a-z -]{0,30}$/i.test(area) ? `${area.toLowerCase()} ${word}` : word;
        lines.push(`Your ${what}: ${l.length > 1 ? `${l.slice(0, -1).join(", ")} and ${l.at(-1)}` : l[0]}.${[...new Set(xs.map((x) => cite(`p-see-${slug(x.p.fm.id)}`, x.recs)))].join("")}`);
      }
    }
  }
  // How the pages it links are tied to each other (G685-G687), each sentence linking every page it
  // names and cited by every fact behind it (label p-rel-<group>, which a read checks against
  // each of those pages: view.ts). Never on the owner's own page, which every source names.
  let rels = RELATED;
  const titled = (a: string, b: string) => String(o.byId.get(a)!.fm.title ?? a).localeCompare(String(o.byId.get(b)!.fm.title ?? b));
  const to = (id: string) => `[[${id}|${o.byId.get(id)!.fm.title ?? id}]]`;
  const order = { with: 0, too: 1, on: 2, at: 3 };
  for (const r of o.self ? [] : [...(o.related ?? [])].sort((a, b) => order[a.kind] - order[b.kind] || b.members.length - a.members.length || titled(a.group, b.group))) {
    if (!rels) break;
    if (r.group === n.fm.id || !o.byId.has(r.group) || o.blind(r.group)) continue;
    const ms = r.members.filter((m) => m.id !== n.fm.id && m.id !== o.ownerPage && o.byId.has(m.id) && !o.blind(m.id) && m.recs.length).sort((a, b) => titled(a.id, b.id));
    // Every one of them or none: a list cut by the alphabet would read as all of them. Who else is on
    // a person's project or at their org stops at RELATED_NAMES (past that, that page lists them);
    // an org's or a project's own sentence at twice that, as many as an org's member list.
    if (!ms.length || ms.length > (r.kind === "too" || r.kind === "with" ? RELATED_NAMES : 2 * RELATED_NAMES)) continue;
    rels--;
    const lab = `p-rel-${r.group.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    const text = [...new Set([...r.base, ...ms.flatMap((m) => m.recs)].map(reference))].join("; ");
    if (!refs.some((x) => x.label === lab)) refs.push({ label: lab, text });
    const names = ms.map((m) => to(m.id)), list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    const one = names.length === 1;
    lines.push(`${r.kind === "on" ? `${list} ${one ? "is" : "are"} on ${to(r.group)}` : r.kind === "at" ? `${list} ${one ? "works" : "work"} at ${to(r.group)}` : r.kind === "with" ? `${called} is on ${to(r.group)} with ${list}` : `Also at ${to(r.group)}: ${list}`}.[^${lab}]`);
  }
  // A page the text already links isn't named again in the sources line.
  const linked = new Set([...lines.join(" ").matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]));
  for (const id of linked) seen.delete(id);
  // Pages its sources tie it to (G624, the owner's page on his phone): none on the owner's own
  // page, and never the owner's page on another, since every source names him; on any other page
  // at most TIES in all, each its own sentence, never a run of unrelated pages joined by commas.
  let ties = TIES;
  if (o.self) seen.clear();
  const byTitle = (a: string, b: string) => String(o.byId.get(a)!.fm.title ?? a).localeCompare(String(o.byId.get(b)!.fm.title ?? b));
  const link = (id: string) => `[[${id}|${o.byId.get(id)!.fm.title ?? id}]]`;
  if (seen.size && ties) {
    const ids = [...seen.keys()].sort(byTitle).slice(0, ties);
    ties -= ids.length;
    for (const id of ids) lines.push(`Its sources also name ${link(id)}.${[...seen.get(id)!].map((l) => `[^${l}]`).join("")}`);
  }
  // The other way: pages whose facts cite a source that names this one, cited by that fact's
  // sources, so a page named in someone's mail links back to them from the same evidence.
  const shownNow = new Set([...lines.join(" ").matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]));
  const by = new Map<string, FactRecord[]>();
  for (const x of o.self ? [] : o.namedIn ?? []) if (x.from !== n.fm.id && x.from !== o.ownerPage && !shownNow.has(x.from) && o.byId.has(x.from) && !o.blind(x.from)) by.set(x.from, [...(by.get(x.from) ?? []), x.rec]);
  if (by.size && ties) {
    const ids = [...by.keys()].sort(byTitle).slice(0, ties);
    ties -= ids.length;
    // One sentence for all of them, never one each (owner, 2026-11-07; G704).
    const names = ids.map(link);
    lines.push(`${called} also comes up in the sources of ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}.${ids.map((id) => cite(`p-in-${slug(id)}`, by.get(id)!)).join("")}`);
  }
  // Pages whose facts link this one (and, on the owner's own page, their decisions and money that
  // nothing else links): "See also", cited by those facts' sources (outside review v5, midday:
  // 25 pages with a lead and no link in).
  const shownYet = new Set([...lines.join(" ").matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]));
  const also = new Map<string, FactRecord[]>();
  // On the owner's own page only a person whose own fact says how they are related to him (family,
  // relationship) links back: that is about him, as his mail is not (G624, G546).
  for (const x of o.seeAlso ?? []) if (x.from !== n.fm.id && !(own && x.from === own.id) && !(course && x.from === o.ownerPage) && (!o.self || (FAMILY_ATTRS.has(x.attr ?? "") && o.byId.get(x.from)?.fm.type === "person")) && !shownYet.has(x.from) && o.byId.has(x.from) && !o.blind(x.from) && (x.rec.sources ?? []).length) also.set(x.from, [...(also.get(x.from) ?? []), x.rec]);
  if (also.size && ties) {
    const ids = [...also.keys()].sort(byTitle).slice(0, ties);
    ties -= ids.length;
    for (const id of ids) {
      const text = [...new Set(also.get(id)!.map(reference))].join("; ");
      const lab = `p-see-${id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`; // never another fact's label: a read drops it by the page it names (G607)
      if (!refs.some((x) => x.label === lab)) refs.push({ label: lab, text });
      lines.push(`See also ${link(id)}.[^${lab}]`);
    }
  }
  if (!lines.length) return undefined;
  return { text: lines.join(" "), refs };
}

// The page with `lead` as its opening text: every section kept, the references the sections
// cite kept, the writer's own (p-*) replaced.
function withLead(n: Note, lead: { text: string; refs: { label: string; text: string }[] }, top = ""): string {
  const f = footnotes(n.body);
  const secs = sections(f.text).filter((x) => x.heading !== undefined);
  const rest = secs.map((x) => `## ${x.heading}\n${x.text}`).join("\n\n");
  const order = [...new Set([...`${top}\n${rest}`.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => m[1]))];
  // The other references in the order the text cites them, so a second run writes the same file.
  const defs = [...lead.refs.map((r) => `[^${r.label}]: ${r.text}`), ...order.filter((l) => !/^pf?-/.test(l)).flatMap((l) => f.notes.filter((x) => x.label === l).slice(0, 1)).map((x) => `[^${x.label}]: ${x.text}`)];
  const block = `${lead.text}\n\n${MADE}\n`;
  return `${top ? `${top}\n\n## ${FACTS}\n` : ""}${block}${rest ? `\n${rest}\n` : ""}\n${defs.join("\n")}\n`;
}

// The openings someone other than the writer left at the top of a page, as plain words, from the
// page's history: text the writer once moved under "Earlier notes" goes back up only when it is
// word for word one of these (G683).
function pastOpenings(root: string, path: string, commits = 200): Set<string> {
  const out = new Set<string>();
  const log = git(root, ["log", `-n${commits}`, "--format=%H%x1f%an", "--", path]).split("\n").filter(Boolean);
  for (const line of log) {
    const [hash, by] = line.split("\x1f");
    if ([WRITER, "reflect"].includes(by)) continue;
    let n: Note;
    try { n = parseNote(git(root, ["show", `${hash}:${path}`]), path); } catch { continue; }
    const top = sections(footnotes(n.body).text).find((x) => x.heading === undefined)?.text.trim();
    if (top && !top.includes(MADE)) out.add(plainWords(top));
  }
  return out;
}

// Where someone else's opening text goes once the writer's opens the page, and the headings the
// writer's own text used to sit under (G436 "Related", G442 "From its facts").
const EARLIER = "Earlier notes", YOURS = "Your notes";
const FACTS = "From its facts";
const OLD_HEADS = new Set(["Related", FACTS]);
// Said wherever the writer's text is read (dashboard, an assistant's read, the file): no person
// wrote it, and its facts are where it comes from (outside review v3, 2026-10-26).
export const MADE = "(Written by the hub from this page's facts.)";
// An opening text the writer may replace: its own (its p- references only), last changed by the
// writer or by upkeep's link passes. Any other text, or a person's edit of the writer's, is kept.
const writersOwn = (text: string, by: string) => [WRITER, "reflect"].includes(by) && /\[\^pf?-/.test(text) && [...text.matchAll(/\[\^([^\]\s]+)\]/g)].every((m) => /^pf?-/.test(m[1]));

// What the commit says about why each page was written, and true of each: its facts changed (or
// it is new), a page it's linked with changed, or only something else on it did (a link, its text).
function whyWritten(root: string, written: string[], since: string, via: Set<string>): string {
  let facts = 0, fresh = 0, linked = 0, other = 0;
  for (const path of written) {
    if (via.has(path)) { linked++; continue; }
    const before = git(root, ["rev-list", "-1", `--before=${since}`, "HEAD", "--", path]).trim();
    if (!before) { fresh++; continue; }
    let old: unknown;
    try { old = parseNote(git(root, ["show", `${before}:${path}`]), path).fm.facts; } catch { old = undefined; }
    let now: unknown;
    try { now = parseNote(readFileSync(join(root, path), "utf8"), path).fm.facts; } catch { now = undefined; }
    if (JSON.stringify(old ?? {}) !== JSON.stringify(now ?? {})) facts++; else other++;
  }
  const day = since.slice(0, 10), n = (k: number, one: string, more: string) => `${k} ${k === 1 ? one : more}`;
  return [facts && `${n(facts, "page's facts", "pages' facts")} changed since ${day}`, fresh && `${n(fresh, "page is", "pages are")} new since ${day}`, linked && `${n(linked, "page is", "pages are")} linked with one of those`, other && `${n(other, "page", "pages")} changed only in ${other === 1 ? "its" : "their"} links or text since ${day}`].filter(Boolean).join(", ");
}

export interface PageWrite { written: string[]; kept: string[]; commit?: string }

// Pages whose file a commit since `since` changed, rewritten in one commit by the hub. Called by
// upkeep every night and by scripts/north-star.ts. Run twice, the second run commits nothing.
// The owner's names as the page writer says them, longest first.
export function ownerWordsOf(rules: Rules): string[] {
  const owner = [ownerTitle(rules), ...[rules.policy.owner?.name, ...(rules.policy.owner?.aliases ?? [])].map((x) => String(x ?? "").trim())].filter((x): x is string => !!x && x !== "the owner");
  owner.push(...owner.map((x) => x.split(" ")[0]).filter((x) => x.length > 1));
  return [...new Set(owner)].sort((a, b) => b.length - a.length);
}

// The hub's own block on a page as it stands, without a model's opening on top of it: the text the
// next opening may reword (G713).
export function hubLead(n: Note): string {
  const secs = sections(footnotes(n.body).text);
  const block = secs.find((x) => x.heading === undefined && x.text.includes(MADE)) ?? secs.find((x) => x.heading === FACTS && x.text.includes(MADE));
  const text = block ? block.text.split(MADE)[0]!.trim() : "";
  const op = n.fm.opening?.text;
  return op ? text.split("\n").filter((l) => !l.startsWith(op)).join("\n").trim() : text;
}

export function renderTouchedPages(root: string, since: string): PageWrite {
  const role = hubRole(root).mode;
  if (role === "replica") return { written: [], kept: [] };
  const rules = loadRules(root);
  const notes = loadBrain(root);
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  // The owner's own page lists no pages its sources name (G624): every source names him, so a list there is
  // whatever mail came in, not what is true of him; his own projects and decisions it does list, from
  // the pages themselves (G725). It is written every run, touched or not (G627),
  // so a rule change reaches it the next night; text that comes out the same is not written.
  const self = ownerOf(rules, notes, ownerTitle(rules) ?? "")?.page;
  const pages = touchedPages(root, notes, since, self);
  if (!pages.length) return { written: [], kept: [] };
  const views = Object.keys(rules.policy.agents ?? {}).flatMap((agent) => { try { return [carve(notes, rules, grantFor(rules, agent), { flags: false })]; } catch { return []; } });
  const names = namesBySource(root, notes, ownerName(rules));
  // Title or alias -> the one note it names (a name two notes share names neither).
  const titles = new Map<string, string>(), twice = new Set<string>();
  for (const n of notes) for (const t of new Set([n.fm.title, ...(n.fm.aliases ?? [])].map((x) => String(x ?? "").toLowerCase()).filter(Boolean))) { if (titles.has(t)) twice.add(t); titles.set(t, n.fm.id); }
  for (const t of twice) titles.delete(t);
  const resolve = (to: string) => byId.has(to) ? to : titles.get(to.toLowerCase());
  const via = new Set<string>(); // pages written because a page they're linked with changed
  // Page -> the people whose live org fact links to it (with that fact's records); the page they
  // name is written again whenever one of them is.
  const at = new Map<string, { id: string; recs: FactRecord[] }[]>();
  for (const p of notes) {
    if (p.fm.type !== "person" || ["archived", "merged", "superseded"].includes(String(p.fm.status))) continue;
    const f = p.fm.facts?.org;
    if (!f || isDisputed(f)) continue;
    const recs = records(f).filter(live).filter((r) => !r.share_with && r.value !== undefined && r.value !== null);
    const to = new Set(recs.flatMap((r) => { const v = shown(r.value); return v.includes("[[") ? [...v.matchAll(/\[\[([^\]|]+)/g)].map((m) => resolve(m[1])) : [resolve(v.trim())].filter((id) => id && byId.get(id)?.fm.type === "org"); }).filter((x): x is string => !!x));
    for (const id of to) at.set(id, [...(at.get(id) ?? []), { id: p.fm.id, recs }]);
  }
  for (const p of [...pages]) for (const [id, ms] of at) if (ms.some((m) => m.id === p.fm.id)) { const org = byId.get(id); if (org && !pages.includes(org) && PAGE_DIRS.has(id.split("/")[0]) && !["archived", "merged", "superseded"].includes(String(org.fm.status))) { pages.push(org); via.add(org.path); } }
  // Page -> the facts on other pages whose source names it (name keys), each with its record.
  const namedIn = new Map<string, { from: string; attr: string; rec: FactRecord }[]>();
  for (const p of notes) {
    if (!PAGE_DIRS.has(p.fm.id.split("/")[0]) || ["archived", "merged", "superseded"].includes(String(p.fm.status))) continue;
    for (const [attr, f] of Object.entries(p.fm.facts ?? {})) {
      if (NOT_PROSE.test(attr) || isDisputed(f)) continue;
      for (const rec of records(f).filter(live).filter((r) => !r.share_with && r.value !== undefined && r.value !== null))
        for (const to of new Set((rec.sources ?? []).flatMap((x) => names.get(itemOf(refString(x))) ?? [])))
          if (to !== p.fm.id) namedIn.set(to, [...(namedIn.get(to) ?? []), { from: p.fm.id, attr, rec }]);
    }
  }
  // Pages whose facts cite the same source item are named in each other's sources too, though no
  // name key ties them (real-brain north star, 2026-10-30: 8 of 9 pages with no link in linked out
  // nowhere). Each is cited by the other page's fact that cites that item.
  const citing = new Map<string, { from: string; attr: string; rec: FactRecord }[]>();
  for (const p of notes) {
    if (!PAGE_DIRS.has(p.fm.id.split("/")[0]) || p.fm.type === "hub" || ["archived", "merged", "superseded"].includes(String(p.fm.status))) continue;
    for (const [attr, f] of Object.entries(p.fm.facts ?? {})) {
      if (NOT_PROSE.test(attr) || isDisputed(f)) continue;
      for (const rec of records(f).filter(live).filter((r) => !r.share_with && r.value !== undefined && r.value !== null))
        for (const item of new Set((rec.sources ?? []).map((x) => itemOf(refString(x))).filter((x) => /^(gmail|gcal|imsg|mail|notion):/.test(x))))
          citing.set(item, [...(citing.get(item) ?? []), { from: p.fm.id, attr, rec }]);
    }
  }
  for (const [item, xs] of citing) {
    const ids = new Set(xs.map((x) => x.from));
    if (ids.size < 2 || ids.size > 8) continue; // one item behind many pages is a list or digest, not a tie
    // Only a source that names the page ties it (G624): two pages drawn from one receipt or
    // newsletter are not about each other.
    for (const to of ids) if ((names.get(item) ?? []).includes(to)) for (const x of xs) if (x.from !== to && !(namedIn.get(to) ?? []).some((y) => y.from === x.from && y.rec === x.rec)) namedIn.set(to, [...(namedIn.get(to) ?? []), x]);
  }
  // Page -> the facts on other pages whose value links it: it links back ("See also").
  const active = (p: Note) => PAGE_DIRS.has(p.fm.id.split("/")[0]) && p.fm.type !== "hub" && !["archived", "merged", "superseded"].includes(String(p.fm.status));
  const seeAlso = new Map<string, { from: string; attr: string; rec: FactRecord }[]>();
  const liveRecs = (p: Note) => Object.entries(p.fm.facts ?? {}).filter(([attr, f]) => !NOT_PROSE.test(attr) && !isDisputed(f)).flatMap(([attr, f]) => records(f).filter(live).filter((r) => !r.share_with && r.value !== undefined && r.value !== null).map((rec) => ({ attr, rec })));
  for (const p of notes) {
    if (!active(p)) continue;
    for (const { attr, rec } of liveRecs(p)) {
      const v = shown(rec.value);
      const tos = new Set([...v.matchAll(/\[\[([^\]|]+)/g)].map((m) => resolve(m[1].trim())).concat(byId.has(v.trim()) ? [v.trim()] : []));
      for (const to of tos) if (to && to !== p.fm.id && byId.has(to)) seeAlso.set(to, [...(seeAlso.get(to) ?? []), { from: p.fm.id, attr, rec }]);
    }
  }
  // A [[link]] someone wrote into a page's own text links back the same way, cited by that
  // paragraph's references (G670, pages-ok part 3: the link went one way only). Not the hub's own
  // lead, which links from facts already, and not from or onto the owner's own page (G624). Kept
  // apart so each page's readers are checked before it shows (they must read that text).
  const bodyLinks = new Map<string, { from: string; rec: FactRecord }[]>();
  for (const p of notes) {
    if (!active(p) || p.fm.id === self) continue;
    const f = footnotes(p.body ?? ""), defs = new Map(f.notes.map((x) => [x.label, x.text]));
    for (const s of sections(f.text)) {
      if (s.heading === undefined && s.text.includes(MADE)) continue;
      for (const para of s.text.split(/\n\s*\n/)) {
        const cites = [...para.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => defs.get(m[1]) ?? "").filter((t) => refsIn(t).length);
        if (!cites.length) continue;
        const rec: FactRecord = { value: "", as_of: cites[0].match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? String(p.fm.updated ?? ""), sources: [...new Set(cites.flatMap(refsIn))] } as FactRecord;
        for (const m of para.matchAll(/\[\[([^\]|]+)/g)) {
          const to = resolve(m[1].trim());
          if (to && to !== p.fm.id && to !== self && byId.has(to) && !(bodyLinks.get(to) ?? []).some((x) => x.from === p.fm.id)) bodyLinks.set(to, [...(bodyLinks.get(to) ?? []), { from: p.fm.id, rec }]);
        }
      }
    }
  }
  for (const [id, xs] of bodyLinks) for (const x of xs) if (!(seeAlso.get(id) ?? []).some((y) => y.from === x.from)) seeAlso.set(id, [...(seeAlso.get(id) ?? []), { from: x.from, attr: "", rec: x.rec }]);
  for (const p of [...pages]) for (const [id, xs] of seeAlso) if (xs.some((x) => x.from === p.fm.id)) { const q = byId.get(id); if (q && !pages.includes(q) && active(q)) { pages.push(q); via.add(q.path); } }
  // How the pages a page links are tied to each other, from the facts that tie them (the owner,
  // 2026-11-06: "an org as people who are tied to projects"; audit v12, nothing crossed pages):
  // an org's people on a project (G685), where a project's people work (G686), who else is on a
  // person's project and at their org (G687). Each sentence keeps the facts behind it, so the
  // loop below checks every one for every reader, and the page is written again when one changes.
  type Used = { from: string; attr: string; rec: FactRecord };
  type Rel = { kind: Related["kind"]; group: string; base: Used[]; members: { id: string; used: Used[] }[] };
  const isType = (id: string, t: string) => { const q = byId.get(id); return !!q && active(q) && q.fm.type === t; };
  const orgsOf = new Map<string, { org: string; used: Used[] }[]>();
  for (const [org, ms] of at) for (const m of ms) if (isType(org, "org")) orgsOf.set(m.id, [...(orgsOf.get(m.id) ?? []), { org, used: m.recs.map((rec) => ({ from: m.id, attr: "org", rec })) }]);
  const onProject = new Map<string, { id: string; u: Used }[]>(), projectsOf = new Map<string, { project: string; u: Used }[]>();
  for (const [to, xs] of seeAlso) for (const x of xs) if (x.attr && isType(x.from, "project") && isType(to, "person") && to !== self) {
    onProject.set(x.from, [...(onProject.get(x.from) ?? []), { id: to, u: x }]);
    projectsOf.set(to, [...(projectsOf.get(to) ?? []), { project: x.from, u: x }]);
  }
  const relOf = new Map<string, Rel[]>();
  const add = (page: string, kind: Rel["kind"], group: string, base: Used[], id: string, used: Used[]) => {
    if (page === self || id === page || id === self || group === page) return;
    const rs = relOf.get(page) ?? relOf.set(page, []).get(page)!;
    let r = rs.find((x) => x.kind === kind && x.group === group);
    if (!r) rs.push(r = { kind, group, base, members: [] });
    const m = r.members.find((x) => x.id === id);
    if (m) m.used.push(...used.filter((u) => !m.used.includes(u))); else r.members.push({ id, used });
  };
  for (const [person, os] of orgsOf) for (const { org, used } of os) {
    for (const { project, u } of projectsOf.get(person) ?? []) add(org, "on", project, [], person, [...used, u]);
    for (const m of at.get(org) ?? []) if (m.id !== person) add(person, "too", org, used, m.id, m.recs.map((rec) => ({ from: m.id, attr: "org", rec })));
  }
  for (const [project, ps] of onProject) for (const p of ps) {
    for (const { org, used } of orgsOf.get(p.id) ?? []) add(project, "at", org, [], p.id, [p.u, ...used]);
    for (const q of ps) if (q.id !== p.id) add(p.id, "with", project, [p.u], q.id, [q.u]);
  }
  for (const p of [...pages]) for (const [id, rs] of relOf) if (rs.some((r) => [...r.base, ...r.members.flatMap((m) => m.used)].some((u) => u.from === p.fm.id))) { const q = byId.get(id); if (q && !pages.includes(q) && active(q)) { pages.push(q); via.add(q.path); } }
  // A page named by a touched page's sources is written again with it.
  for (const p of [...pages]) for (const [id, xs] of namedIn) if (xs.some((x) => x.from === p.fm.id)) { const q = byId.get(id); if (q && !pages.includes(q) && PAGE_DIRS.has(id.split("/")[0]) && q.fm.type !== "hub" && !["archived", "merged", "superseded"].includes(String(q.fm.status))) { pages.push(q); via.add(q.path); } }
  const ownerWords = ownerWordsOf(rules);
  const written: string[] = [], kept: string[] = [];
  for (const n of pages) {
    const readers = views.filter((v) => v.visible.get(n.fm.id)?.body);
    const hiddenKeys = new Set(readers.flatMap((v) => v.hiddenFacts.map((h) => h.key)));
    const rank = sensitivityRank(n.fm.sensitivity);
    const members = (at.get(n.fm.id) ?? []).filter((m) => !hiddenKeys.has(`${m.id}#org`) && sensitivityRank(byId.get(m.id)!.fm.sensitivity) <= rank).map((m) => ({ ...m, recs: m.recs.filter((r) => !r.sensitivity || sensitivityRank(r.sensitivity) <= rank) })).filter((m) => m.recs.length);
    // One hub-written block per page. Text a person (or an import, an assistant, the Gardener)
    // left at the top stays on top, its source ids made references, and the hub's block follows it
    // under "From its facts" (audit v12: on 71 of 102 demo pages the paragraph saying why someone
    // matters sat under the template as "Earlier notes"; G682). Text the writer moved under
    // "Earlier notes" before goes back up when it is word for word what someone wrote at the top.
    // With no such text the hub's block opens the page. The writer's old sections ("Related", a
    // "From its facts" it wrote) go, unless someone has since written in one. "Your notes" is only
    // ever text the owner typed (src/owner-say.ts); one the writer moved there is Earlier notes.
    const f = footnotes(n.body), secs = sections(f.text);
    const said = plainWords(secs.filter((x) => x.heading !== undefined && !OLD_HEADS.has(x.heading) && x.heading !== EARLIER && x.heading !== YOURS).map((x) => x.text).join("\n"));
    // The ties between pages it links (G685-G687): every fact behind a sentence said to every
    // reader, and no page in it more private than this one.
    const okU = (u: Used) => !hiddenKeys.has(`${u.from}#${u.attr}`) && sensitivityRank(byId.get(u.from)!.fm.sensitivity) <= rank && (!u.rec.sensitivity || sensitivityRank(u.rec.sensitivity) <= rank);
    const okPage = (id: string) => sensitivityRank(byId.get(id)!.fm.sensitivity) <= rank;
    const related: Related[] = (relOf.get(n.fm.id) ?? []).filter((r) => okPage(r.group) && r.base.every(okU))
      .map((r) => ({ kind: r.kind, group: r.group, base: r.base.map((u) => u.rec), members: r.members.filter((m) => okPage(m.id) && m.used.every(okU)).map((m) => ({ id: m.id, recs: m.used.map((u) => u.rec) })) }))
      .filter((r) => r.members.length);
    const lead = pageLead(n, { related, hidden: (k) => hiddenKeys.has(k), blind: (to) => readers.some((v) => !v.visible.has(to)), names, byId, resolve, owner: ownerWords, spec: (attr) => attributeSpec(rules, String(n.fm.type ?? ""), attr), members, self: n.fm.id === self, ownerPage: self, namedIn: (namedIn.get(n.fm.id) ?? []).filter((x) => !hiddenKeys.has(`${x.from}#${x.attr}`) && sensitivityRank(byId.get(x.from)!.fm.sensitivity) <= rank && (!x.rec.sensitivity || sensitivityRank(x.rec.sensitivity) <= rank)), seeAlso: (seeAlso.get(n.fm.id) ?? []).filter((x) => (x.attr ? !hiddenKeys.has(`${x.from}#${x.attr}`) : readers.every((v) => !!v.visible.get(x.from)?.body)) && sensitivityRank(byId.get(x.from)!.fm.sensitivity) <= rank && (!x.rec.sensitivity || sensitivityRank(x.rec.sensitivity) <= rank)), said });
    // A model's opening (G713) goes first in the hub's block while it still fits what the block says.
    const op = lead && n.fm.opening;
    if (lead && op && typeof op.text === "string" && Array.isArray(op.labels) && !openingProblem(op.text, op.labels.map(String), lead.text, [String(n.fm.title ?? ""), ...(n.fm.aliases ?? []), ...ownerWords]))
      lead.text = `${op.text}${[...new Set(op.labels.map(String))].map((l) => `[^${l}]`).join("")}\n\n${lead.text}`;
    if (!lead) {
      // Nothing left to say (an Undo took the last fact out): the writer's own opening goes with its
      // references, so the page never keeps stating a value it no longer holds (UI thread, 2026-10-27).
      const top = secs.find((x) => x.heading === undefined)?.text.trim() ?? "";
      const auth = partAuthors(root, n.path);
      const hub = (x: Section) => x.heading !== undefined && OLD_HEADS.has(x.heading) && [WRITER, "reflect"].includes(auth.get(x.heading) ?? "") && x.text.includes(MADE);
      const topHub = top.includes(MADE) && writersOwn(top, auth.get("") ?? "");
      if (!topHub && !secs.some(hub)) continue;
      const rest = secs.filter((x) => (x.heading === undefined ? !topHub && !!x.text.trim() : !hub(x))).map((x) => x.heading === undefined ? x.text.trim() : `## ${x.heading}\n${x.text}`).join("\n\n");
      const cited = new Set([...rest.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => m[1]));
      const defs = f.notes.filter((x) => cited.has(x.label)).map((x) => `[^${x.label}]: ${x.text}`).join("\n");
      saveNote(root, { ...n, body: `${rest ? `${rest}\n` : ""}${defs ? `\n${defs}\n` : ""}` });
      written.push(n.path);
      continue;
    }
    const own = secs.find((x) => x.heading === undefined)?.text.trim() ?? "";
    const by = own || secs.some((x) => x.heading && (OLD_HEADS.has(x.heading) || x.heading === YOURS || x.heading === EARLIER)) ? partAuthors(root, n.path) : new Map<string, string>();
    const mine = (h: string) => [WRITER, "reflect"].includes(by.get(h) ?? "");
    const hubs = (x: { heading?: string; text: string }) => !!x.heading && OLD_HEADS.has(x.heading) && mine(x.heading) && (x.text.includes(MADE) || writersOwn(x.text, by.get(x.heading) ?? ""));
    const theirs = own && !writersOwn(own, by.get("") ?? "") ? own : "";
    const recs = Object.values(n.fm.facts ?? {}).flatMap((x) => records(x)).filter((r) => !r.unseen);
    const extra = new Map<string, string>();
    // Someone's own "From its facts" section (kept as theirs) leaves no heading for the hub's
    // block, so then their opening goes under Earlier notes as before.
    const onTop = !secs.some((x) => x.heading === FACTS && !hubs(x));
    const earlier = secs.find((x) => x.heading === EARLIER);
    const back = onTop && !theirs && earlier && mine(EARLIER) && pastOpenings(root, n.path).has(plainWords(earlier.text)) ? earlier.text.trim() : "";
    const moved = [onTop ? "" : theirs, ...secs.filter((x) => x.heading === YOURS && mine(YOURS)).map((x) => x.text.trim())].filter(Boolean);
    const rest: { heading: string; text: string }[] = [];
    for (const x of secs) {
      if (x.heading === undefined || hubs(x) || (x.heading === YOURS && mine(YOURS)) || (back && x === earlier)) continue;
      rest.push({ heading: x.heading, text: x.heading === EARLIER && (moved.length || mine(EARLIER)) ? inlineRefs([...moved, x.text.trim()].join("\n\n"), recs, extra) : x.text });
    }
    if (moved.length && !rest.some((x) => x.heading === EARLIER)) rest.unshift({ heading: EARLIER, text: inlineRefs(moved.join("\n\n"), recs, extra) });
    const top = inlineRefs(onTop && theirs ? theirs : back, recs, extra);
    if (theirs || back) kept.push(n.fm.id);
    const defs = [...f.notes.map((x) => `[^${x.label}]: ${x.text}`), ...[...extra].filter(([l]) => !f.notes.some((x) => x.label === l)).map(([l, t]) => `[^${l}]: ${t}`)].join("\n");
    const body = withLead({ ...n, body: `${rest.map((x) => `## ${x.heading}\n${x.text}`).join("\n\n")}\n\n${defs}\n` }, lead, top);
    if (body.trim() === n.body.trim()) continue;
    saveNote(root, { ...n, body });
    written.push(n.path);
  }
  if (!written.length) return { written, kept };
  git(root, ["add", "--", ...written]);
  git(root, ["commit", "-q", "-m", `${WRITER}: page text for ${written.length} ${written.length === 1 ? "page" : "pages"}\n\nWhy: ${whyWritten(root, written, since, via)}; each opening paragraph says what the page's facts say now, with a reference for each.\nKind: page-writer\nFiles: ${written.join(", ")}`], WRITER);
  return { written: written.map((p) => p.slice(0, -3)), kept, commit: git(root, ["rev-parse", "--short", "HEAD"]).trim() };
}
