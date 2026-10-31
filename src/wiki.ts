// SPDX-License-Identifier: AGPL-3.0-only
// The wiki shape of a note, read-only (docs/wiki.md): a one-line `summary:`, a `parent:` and the
// page tree computed from parents (never stored), sections from `## ` headings, and Markdown
// footnotes for refs. Every field is optional; a note without them reads as it always did.
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
// text first cites them (then any never cited). A ref with no definition stays as written.
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
  return { text: kept, notes: order.map((label, i) => ({ label, n: i + 1, text: defs.get(label)! })) };
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
const PAGE_DIRS = new Set(["people", "orgs", "projects", "decisions", "notes"]);
// Contact details are facts, not sentences (and an address in prose is easy to copy on).
const NOT_PROSE = /^(email|emails|phone|phones|mobile|address|home_address|handle|aliases?)$/;
const SOURCE_WORD: Record<string, string> = { gmail: "Email", "gmail-thread": "Email thread", mail: "Email", gcal: "Calendar", slack: "Slack", gdoc: "Document", doc: "Document", zoom: "Call", call: "Call", discord: "Discord", imessage: "Text", granola: "Meeting notes", contacts: "Contact card", url: "Web page", owner: "Your note", louis: "Your note", imsg: "Your text", agent: "An assistant's note", notion: "Notion import", "town-wiki": "An assistant's wiki", "instinct-mem": "An assistant's memory", "town-routine": "An assistant's routine", "agent-relay": "Relayed by an assistant", "agent-log": "An assistant's log", approved: "You approved", prior: "The earlier owner's source", "prior-note": "The earlier owner's note", unverified: "No source given" };

const shown = (v: unknown): string => Array.isArray(v) ? v.map(shown).join(", ") : typeof v === "object" && v ? JSON.stringify(v) : String(v);
// A value that already reads as what someone did ("sent Sam a request for feedback on …").
const DID = /^(?:[a-z]+ed|sent|met|told|gave|made|wrote|took|got|brought|built|taught|led|ran|knew|is|was|has|had|works|leads|runs|manages|knows|reports|teaches|helps|owns|lives|says|wants|needs|plans|uses)\b/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
  if (person && !many && DID.test(v) && /\s/.test(v) && !owner.some((o) => o.toLowerCase() === full.toLowerCase())) {
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
  if (spec.ends_on_date || spec.shelf_life === "until_date") return `${attr === "next_step" ? "Next" : label(attr)} for ${t}: ${v}.`;
  if (spec.normalize === "date") return `${whose(t)} ${lab} ${many ? "dates are" : "is"} ${v}.`;
  // A short value is said in one breath; a long one is quoted as the source gave it.
  if (v.split(/\s+/).length <= 8 && !/[.;:!?]\s/.test(v)) return person || n.fm.type === "org" ? `${whose(t)} ${lab} ${many ? "are" : "is"} ${v}.` : `The ${lab} of ${t} ${many ? "are" : "is"} ${v}.`;
  return `On ${t}, the ${lab}: ${v}.`;
}
// What kind of source it is, in words: an assistant's own note names the assistant; a kind the
// hub has no word for is named by its scheme ("Import"), never just "Source".
function sourceWord(ref: string): string {
  const scheme = ref.match(/^([a-z-]+):/)?.[1] ?? ref.match(/^[a-z-]+$/)?.[0] ?? "";
  const who = scheme === "agent" ? ref.match(/^agent:([A-Za-z][\w-]{0,39})\//)?.[1] : undefined;
  if (who) return `${who.charAt(0).toUpperCase()}${who.slice(1)}'s note`;
  return SOURCE_WORD[scheme] ?? (scheme ? `${scheme.charAt(0).toUpperCase()}${scheme.slice(1).replace(/-/g, " ")}` : "Source");
}
export function reference(r: FactRecord): string {
  const refs = (r.sources ?? []).map((s) => normalizeRef(refString(s)));
  const ids = refs.filter((x) => x.includes(":"));
  return `${refs.length ? sourceWord(refs[0]) : SOURCE_WORD.unverified}, ${r.as_of}${ids.length ? ` (${ids.join(", ")})` : ""}`;
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
const GMAIL_WORD = /(\b(?:e-?mail|thread|message|reply)\b,?\s+)?\b(?:Gmail\s+)?([0-9a-f]{16})\b/gi;
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
function touchedPages(root: string, notes: Note[], since: string): Note[] {
  const touched = new Set(git(root, ["log", `--since=${since}`, "--name-only", "--format="]).split("\n").filter((p) => p.endsWith(".md")));
  return notes.filter((n) => touched.has(n.path) && PAGE_DIRS.has(n.fm.id.split("/")[0]) && n.fm.type !== "hub" && !["archived", "merged", "superseded"].includes(String(n.fm.status)));
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
export function pageLead(n: Note, o: { hidden: (key: string) => boolean; blind: (to: string) => boolean; names: Map<string, string[]>; byId: Map<string, Note>; resolve?: (link: string) => string | undefined; owner?: string[]; spec?: (attr: string) => AttributeSpec; members?: { id: string; recs: FactRecord[] }[]; namedIn?: { from: string; rec: FactRecord }[]; seeAlso?: { from: string; rec: FactRecord }[]; said?: string }): { text: string; refs: { label: string; text: string }[] } | undefined {
  const lines: string[] = [], refs: { label: string; text: string }[] = [];
  const seen = new Map<string, Set<string>>(); // page named -> labels of the facts whose source names it
  // Links in a sentence written by the id they resolve to, so every reader resolves them; one some
  // reader of this page can't see reads as its plain name.
  const linkWords = (s: string) => s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, to: string, words?: string) => { const id = o.resolve?.(to); return id && !o.blind(id) ? `[[${id}|${words ?? o.byId.get(id)?.fm.title ?? to}]]` : (words ?? (id === to ? o.byId.get(id)?.fm.title : undefined) ?? to); });
  const facts: { attr: string; vals: string[]; labs: string[]; waits: boolean }[] = [];
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (NOT_PROSE.test(attr) || isDisputed(f) || o.hidden(`${n.fm.id}#${attr}`)) continue;
    const recs = records(f).filter(live).filter((r) => !r.share_with && (!r.sensitivity || sensitivityRank(r.sensitivity) <= sensitivityRank(n.fm.sensitivity)) && r.value !== undefined && r.value !== null && shown(r.value).trim());
    if (!recs.length || recs.some((r) => findSecret(shown(r.value)))) continue;
    // A value a section of the page already says (the Gardener's "Your relationship") isn't said twice.
    if (o.said && recs.every((r) => { const k = plainWords(shown(r.value)).slice(0, 40); return k.length >= 20 && o.said!.includes(k); })) continue;
    // Facts with the same references share one footnote, so a reader sees one number, not two for one email.
    const text = [...new Set(recs.map(reference))].join("; ");
    const lab = refs.find((x) => x.text === text)?.label ?? `p-${attr.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    const waits = !isList(f) && typeof (f as { contested?: unknown }).contested === "string";
    // A value that links to a page is written by its id, so every reader resolves it; one nobody
    // made yet, or that some reader of this page can't see, reads as its plain name.
    // A person's org written as plain words ("Town") links when it is the title of exactly one org
    // page; a value that is a page's id ("orgs/town") is that page, read by its name.
    const vals = recs.flatMap((r) => Array.isArray(r.value) ? r.value.map(shown) : [shown(r.value)]).map((v) => { if (v.includes("[[")) return v; if (o.byId.has(v.trim())) return `[[${v.trim()}]]`; if (attr !== "org" || n.fm.type !== "person") return v; const id = o.resolve?.(v.trim()); return id && o.byId.get(id)?.fm.type === "org" ? `[[${v.trim()}]]` : v; });
    facts.push({ attr, vals, labs: [lab], waits });
    if (!refs.some((x) => x.label === lab)) refs.push({ label: lab, text });
    for (const r of recs) for (const s of r.sources ?? []) for (const to of o.names.get(itemOf(refString(s))) ?? [])
      if (to !== n.fm.id && o.byId.has(to) && !o.blind(to)) seen.set(to, (seen.get(to) ?? new Set()).add(lab));
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
  for (const x of facts) {
    const said = linkWords(sentence(n, x.attr, x.vals, o.owner, o.spec?.(x.attr), lines.length && short ? short : undefined));
    lines.push(`${said}${x.labs.map((l) => `[^${l}]`).join("")}${x.waits ? " A different value is waiting to be checked." : ""}`);
  }
  const called = lines.length && short ? short : String(n.fm.title ?? n.fm.id);
  // The people whose org fact names this page, each cited by that fact's sources: a page they
  // link to links back, from facts, never guessed.
  const members = (o.members ?? []).filter((m) => m.id !== n.fm.id && o.byId.has(m.id) && !o.blind(m.id)).sort((a, b) => String(o.byId.get(a.id)!.fm.title ?? a.id).localeCompare(String(o.byId.get(b.id)!.fm.title ?? b.id))).slice(0, 12);
  if (members.length) {
    const labs: string[] = [];
    for (const m of members) {
      const text = [...new Set(m.recs.map(reference))].join("; ");
      const lab = refs.find((x) => x.text === text)?.label ?? `p-at-${m.id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      if (!refs.some((x) => x.label === lab)) refs.push({ label: lab, text });
      if (!labs.includes(lab)) labs.push(lab);
    }
    const links = members.map((m) => `[[${m.id}|${o.byId.get(m.id)!.fm.title ?? m.id}]]`);
    lines.push(`${links.length > 1 ? `${links.slice(0, -1).join(", ")} and ${links.at(-1)} work` : `${links[0]} works`} at ${n.fm.title ?? n.fm.id}.${labs.map((l) => `[^${l}]`).join("")}`);
  }
  // A page the text already links isn't named again in the sources line.
  const linked = new Set([...lines.join(" ").matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]));
  for (const id of linked) seen.delete(id);
  if (seen.size) {
    const ids = [...seen.keys()].sort((a, b) => String(o.byId.get(a)!.fm.title ?? a).localeCompare(String(o.byId.get(b)!.fm.title ?? b))).slice(0, 8);
    const links = ids.map((id) => `[[${id}|${o.byId.get(id)!.fm.title ?? id}]]`);
    const labs = [...new Set(ids.flatMap((id) => [...seen.get(id)!]))];
    lines.push(`Its sources also name ${links.length > 1 ? `${links.slice(0, -1).join(", ")} and ${links.at(-1)}` : links[0]}.${labs.map((l) => `[^${l}]`).join("")}`);
  }
  // The other way: pages whose facts cite a source that names this one, cited by that fact's
  // sources, so a page named in someone's mail links back to them from the same evidence.
  const shownNow = new Set([...lines.join(" ").matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]));
  const by = new Map<string, FactRecord[]>();
  for (const x of o.namedIn ?? []) if (x.from !== n.fm.id && !shownNow.has(x.from) && o.byId.has(x.from) && !o.blind(x.from)) by.set(x.from, [...(by.get(x.from) ?? []), x.rec]);
  if (by.size) {
    const ids = [...by.keys()].sort((a, b) => String(o.byId.get(a)!.fm.title ?? a).localeCompare(String(o.byId.get(b)!.fm.title ?? b))).slice(0, 8);
    const labs: string[] = [];
    for (const id of ids) {
      const text = [...new Set(by.get(id)!.map(reference))].join("; ");
      const lab = refs.find((x) => x.text === text)?.label ?? `p-in-${id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      if (!refs.some((x) => x.label === lab)) refs.push({ label: lab, text });
      if (!labs.includes(lab)) labs.push(lab);
    }
    const links = ids.map((id) => `[[${id}|${o.byId.get(id)!.fm.title ?? id}]]`);
    lines.push(`${called} also comes up in the sources of ${links.length > 1 ? `${links.slice(0, -1).join(", ")} and ${links.at(-1)}` : links[0]}.${labs.map((l) => `[^${l}]`).join("")}`);
  }
  // Pages whose facts link this one (and, on the owner's own page, their decisions and money that
  // nothing else links): "See also", cited by those facts' sources (outside review v5, midday:
  // 25 pages with a lead and no link in).
  const shownYet = new Set([...lines.join(" ").matchAll(/\[\[([^\]|]+)/g)].map((m) => m[1]));
  const also = new Map<string, FactRecord[]>();
  for (const x of o.seeAlso ?? []) if (x.from !== n.fm.id && !shownYet.has(x.from) && o.byId.has(x.from) && !o.blind(x.from) && (x.rec.sources ?? []).length) also.set(x.from, [...(also.get(x.from) ?? []), x.rec]);
  if (also.size) {
    const ids = [...also.keys()].sort((a, b) => String(o.byId.get(a)!.fm.title ?? a).localeCompare(String(o.byId.get(b)!.fm.title ?? b))).slice(0, 8);
    const labs: string[] = [];
    for (const id of ids) {
      const text = [...new Set(also.get(id)!.map(reference))].join("; ");
      const lab = refs.find((x) => x.text === text)?.label ?? `p-see-${id.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
      if (!refs.some((x) => x.label === lab)) refs.push({ label: lab, text });
      if (!labs.includes(lab)) labs.push(lab);
    }
    const links = ids.map((id) => `[[${id}|${o.byId.get(id)!.fm.title ?? id}]]`);
    lines.push(`See also ${links.length > 1 ? `${links.slice(0, -1).join(", ")} and ${links.at(-1)}` : links[0]}.${labs.map((l) => `[^${l}]`).join("")}`);
  }
  if (!lines.length) return undefined;
  return { text: lines.join(" "), refs };
}

// The page with `lead` as its opening text: every section kept, the references the sections
// cite kept, the writer's own (p-*) replaced.
function withLead(n: Note, lead: { text: string; refs: { label: string; text: string }[] }): string {
  const f = footnotes(n.body);
  const secs = sections(f.text).filter((x) => x.heading !== undefined);
  const rest = secs.map((x) => `## ${x.heading}\n${x.text}`).join("\n\n");
  const cited = new Set([...rest.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => m[1]));
  const defs = [...lead.refs.map((r) => `[^${r.label}]: ${r.text}`), ...f.notes.filter((x) => cited.has(x.label) && !x.label.startsWith("p-")).map((x) => `[^${x.label}]: ${x.text}`)];
  return `${lead.text}\n\n${MADE}\n${rest ? `\n${rest}\n` : ""}\n${defs.join("\n")}\n`;
}

// Where someone else's opening text goes once the writer's opens the page, and the headings the
// writer's own text used to sit under (G436 "Related", G442 "From its facts").
const EARLIER = "Earlier notes", YOURS = "Your notes";
const OLD_HEADS = new Set(["Related", "From its facts"]);
// Said wherever the writer's text is read (dashboard, an assistant's read, the file): no person
// wrote it, and its facts are where it comes from (outside review v3, 2026-10-26).
export const MADE = "(Written by the hub from this page's facts.)";
// An opening text the writer may replace: its own (its p- references only), last changed by the
// writer or by upkeep's link passes. Any other text, or a person's edit of the writer's, is kept.
const writersOwn = (text: string, by: string) => [WRITER, "reflect"].includes(by) && /\[\^p-/.test(text) && [...text.matchAll(/\[\^([^\]\s]+)\]/g)].every((m) => m[1].startsWith("p-"));

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
export function renderTouchedPages(root: string, since: string): PageWrite {
  const role = hubRole(root).mode;
  if (role === "replica") return { written: [], kept: [] };
  const rules = loadRules(root);
  const notes = loadBrain(root);
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const pages = touchedPages(root, notes, since);
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
  for (const xs of citing.values()) {
    const ids = new Set(xs.map((x) => x.from));
    if (ids.size < 2 || ids.size > 8) continue; // one item behind many pages is a list or digest, not a tie
    for (const to of ids) for (const x of xs) if (x.from !== to && !(namedIn.get(to) ?? []).some((y) => y.from === x.from && y.rec === x.rec)) namedIn.set(to, [...(namedIn.get(to) ?? []), x]);
  }
  // Page -> the facts on other pages whose value links it: it links back ("See also"). The owner's
  // own page links their decision and money pages that no other page links.
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
  const self = ownerOf(rules, notes, ownerTitle(rules) ?? "")?.page;
  if (self && byId.has(self)) {
    const into = new Set<string>();
    for (const p of notes) if (p.fm.id !== self && active(p)) for (const m of p.body.matchAll(/\[\[([^\]|]+)/g)) { const id = resolve(m[1].trim()); if (id) into.add(id); }
    for (const [to] of seeAlso) into.add(to);
    for (const q of notes) if (["decision", "money"].includes(String(q.fm.type)) && active(q) && !into.has(q.fm.id) && !(seeAlso.get(self) ?? []).some((x) => x.from === q.fm.id))
      for (const { attr, rec } of liveRecs(q).slice(0, 3)) seeAlso.set(self, [...(seeAlso.get(self) ?? []), { from: q.fm.id, attr, rec }]);
  }
  for (const p of [...pages]) for (const [id, xs] of seeAlso) if (xs.some((x) => x.from === p.fm.id)) { const q = byId.get(id); if (q && !pages.includes(q) && active(q)) { pages.push(q); via.add(q.path); } }
  // A page named by a touched page's sources is written again with it.
  for (const p of [...pages]) for (const [id, xs] of namedIn) if (xs.some((x) => x.from === p.fm.id)) { const q = byId.get(id); if (q && !pages.includes(q) && PAGE_DIRS.has(id.split("/")[0]) && q.fm.type !== "hub" && !["archived", "merged", "superseded"].includes(String(q.fm.status))) { pages.push(q); via.add(q.path); } }
  const owner = [ownerTitle(rules), ...[rules.policy.owner?.name, ...(rules.policy.owner?.aliases ?? [])].map((x) => String(x ?? "").trim())].filter((x): x is string => !!x && x !== "the owner");
  owner.push(...owner.map((x) => x.split(" ")[0]).filter((x) => x.length > 1));
  const ownerWords = [...new Set(owner)].sort((a, b) => b.length - a.length);
  const written: string[] = [], kept: string[] = [];
  for (const n of pages) {
    const readers = views.filter((v) => v.visible.get(n.fm.id)?.body);
    const hiddenKeys = new Set(readers.flatMap((v) => v.hiddenFacts.map((h) => h.key)));
    const rank = sensitivityRank(n.fm.sensitivity);
    const members = (at.get(n.fm.id) ?? []).filter((m) => !hiddenKeys.has(`${m.id}#org`) && sensitivityRank(byId.get(m.id)!.fm.sensitivity) <= rank).map((m) => ({ ...m, recs: m.recs.filter((r) => !r.sensitivity || sensitivityRank(r.sensitivity) <= rank) })).filter((m) => m.recs.length);
    // One hub-written block per page, and it opens the page (phone check, 2026-10-26): text someone
    // else left at the top is kept word for word under "Earlier notes", its source ids made
    // references, and the writer's old sections ("Related", "From its facts") go, unless someone
    // has since written in one. "Your notes" is only ever text the owner typed (src/owner-say.ts);
    // one the writer moved there before is Earlier notes too.
    const f = footnotes(n.body), secs = sections(f.text);
    const said = plainWords(secs.filter((x) => x.heading !== undefined && !OLD_HEADS.has(x.heading) && x.heading !== EARLIER && x.heading !== YOURS).map((x) => x.text).join("\n"));
    const lead = pageLead(n, { hidden: (k) => hiddenKeys.has(k), blind: (to) => readers.some((v) => !v.visible.has(to)), names, byId, resolve, owner: ownerWords, spec: (attr) => attributeSpec(rules, String(n.fm.type ?? ""), attr), members, namedIn: (namedIn.get(n.fm.id) ?? []).filter((x) => !hiddenKeys.has(`${x.from}#${x.attr}`) && sensitivityRank(byId.get(x.from)!.fm.sensitivity) <= rank && (!x.rec.sensitivity || sensitivityRank(x.rec.sensitivity) <= rank)), seeAlso: (seeAlso.get(n.fm.id) ?? []).filter((x) => !hiddenKeys.has(`${x.from}#${x.attr}`) && sensitivityRank(byId.get(x.from)!.fm.sensitivity) <= rank && (!x.rec.sensitivity || sensitivityRank(x.rec.sensitivity) <= rank)), said });
    if (!lead) {
      // Nothing left to say (an Undo took the last fact out): the writer's own opening goes with its
      // references, so the page never keeps stating a value it no longer holds (UI thread, 2026-10-27).
      const top = secs.find((x) => x.heading === undefined)?.text.trim() ?? "";
      if (!top.includes(MADE) || !writersOwn(top, partAuthors(root, n.path).get("") ?? "")) continue;
      const rest = secs.filter((x) => x.heading !== undefined).map((x) => `## ${x.heading}\n${x.text}`).join("\n\n");
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
    const moved = [theirs, ...secs.filter((x) => x.heading === YOURS && mine(YOURS)).map((x) => x.text.trim())].filter(Boolean);
    const rest: { heading: string; text: string }[] = [];
    for (const x of secs) {
      if (x.heading === undefined || hubs(x) || (x.heading === YOURS && mine(YOURS))) continue;
      rest.push({ heading: x.heading, text: x.heading === EARLIER && (moved.length || mine(EARLIER)) ? inlineRefs([...moved, x.text.trim()].join("\n\n"), recs, extra) : x.text });
    }
    if (moved.length && !rest.some((x) => x.heading === EARLIER)) rest.unshift({ heading: EARLIER, text: inlineRefs(moved.join("\n\n"), recs, extra) });
    if (theirs) kept.push(n.fm.id);
    const defs = [...f.notes.map((x) => `[^${x.label}]: ${x.text}`), ...[...extra].filter(([l]) => !f.notes.some((x) => x.label === l)).map(([l, t]) => `[^${l}]: ${t}`)].join("\n");
    const body = withLead({ ...n, body: `${rest.map((x) => `## ${x.heading}\n${x.text}`).join("\n\n")}\n\n${defs}\n` }, lead);
    if (body.trim() === n.body.trim()) continue;
    saveNote(root, { ...n, body });
    written.push(n.path);
  }
  if (!written.length) return { written, kept };
  git(root, ["add", "--", ...written]);
  git(root, ["commit", "-q", "-m", `${WRITER}: page text for ${written.length} ${written.length === 1 ? "page" : "pages"}\n\nWhy: ${whyWritten(root, written, since, via)}; each opening paragraph says what the page's facts say now, with a reference for each.\nKind: page-writer\nFiles: ${written.join(", ")}`], WRITER);
  return { written: written.map((p) => p.slice(0, -3)), kept, commit: git(root, ["rev-parse", "--short", "HEAD"]).trim() };
}
