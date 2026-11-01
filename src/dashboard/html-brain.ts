// SPDX-License-Identifier: AGPL-3.0-only
// The Brain tab, written for someone who has never seen a fact key: one box that searches as
// you type and asks on Enter, notes read like a contact card, values change where they sit,
// and a sentence ("Jane became program director") becomes a before and after per fact.
// Design: pocketbrain-design/prototypes/memory-browser.html.
import { paged, pager } from "./paging";
import { isList, isDisputed, parseNote, sensitivityRank, type Note, type FactRecord, type Fact } from "../brain";
import { keptFor, type State } from "./data";
import { esc, button, type Page } from "./html";
import type { EditProposal } from "./edit-chat";
import { lineDiff } from "./edit-chat";
import { term, plain, cap, agentLabel } from "./labels";
import { recentlyForgotten, type EditorCommit } from "./edit";
import type { OAuthConfig, Pending } from "../oauth";
import { lookalike, type NewAgentPreview } from "../addagent";
import { comingBack, comingBackText } from "../access-request";
import type { Rules } from "../rules";
import type { AccessRequest } from "../oauth";
import { isOwnerConfirmed } from "../owner";
import type { Why, WhyRecord } from "../why";
import { kindLabel, folderOf, browsable, kindCounts, audience, factAudience, searchNotes, queryWords, recentChanges, needsLook, freshnessOf, lifeWords, sinceDate, sourceWords, who, connections } from "./browse";
import { pageTree, ancestors, sections, footnotes, summaryOf, recentUpdates, idsAsWords } from "../wiki";
import { ownerLocal } from "../clock";

const val = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
// /note/<id> is the owner's edit page, reached from "Edit this page" on /p; a link that opens a page goes to /p.
const noteHref = (id: string) => `/note/${id.split("/").map(encodeURIComponent).join("/")}`;
const pageHref = (id: string) => `/p/${id.split("/").map(encodeURIComponent).join("/")}`;
export const whyHref = (id: string, attr: string) => `/why/${id.split("/").map(encodeURIComponent).join("/")}?fact=${encodeURIComponent(attr)}`;
const noteLink = (id: string, label = id) => `<a${label === id ? ' class="mono"' : ""} title="${esc(id)}" href="${pageHref(id)}">${esc(label)}</a>`;
const isPrivate = (s: unknown) => sensitivityRank(s as never) >= sensitivityRank("private");
const names = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;

function form(csrf: string, action: string, inner: string, attrs = "") {
  return `<form method="post" action="${action}" ${attrs}><input type="hidden" name="csrf" value="${esc(csrf)}">${inner}</form>`;
}

// Escapes text and marks the query's words in it (marking before escaping, so an entity is never split).
export function markWords(text: string, words: string[]): string {
  if (!words.length) return esc(text);
  const re = new RegExp(words.map((w) => (w.length > 4 ? w.slice(0, -1) : w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\p{L}*").join("|"), "giu");
  let out = "", at = 0;
  for (const m of text.matchAll(re)) { out += esc(text.slice(at, m.index)) + `<mark>${esc(m[0])}</mark>`; at = m.index! + m[0].length; }
  return out + esc(text.slice(at));
}

// The first facts of a note as "Label: value", for a row that has no better snippet.
function factLine(n: Note, max = 2): string {
  return Object.entries(n.fm.facts ?? {}).filter(([, f]) => !isDisputed(f)).slice(0, max).map(([a, f]) => {
    const v = isList(f) ? f.items.filter((i) => !i.valid_to).map((i) => val(i.value)).join(", ") : val((f as FactRecord).value);
    return `${cap(a)}: ${v}`;
  }).join(" · ");
}

// Markdown a view chunk carries ("- **role**: x [verified]") read as plain text, links by title.
const plainChunk = (t: string, titles?: Map<string, string>) => t.replace(/\*\*|__|`/g, "").replace(/^#+ /gm, "").replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, id, l) => l ?? titles?.get(id) ?? id).replace(/\s+/g, " ").trim();

// The line of a note that best shows why it matched: a fact or sentence holding a query word.
function snippetFor(n: Note, match: string, words: string[], titles: Map<string, string>): string {
  const hit = (line: string) => { const l = line.toLowerCase(); return words.some((w) => l.includes(w.length > 4 ? w.slice(0, -1) : w)); };
  const facts = Object.entries(n.fm.facts ?? {}).filter(([, f]) => !isDisputed(f)).map(([a, f]) => `${cap(a)}: ${isList(f) ? f.items.filter((i) => !i.valid_to).map((i) => val(i.value)).join(", ") : val((f as FactRecord).value)}`);
  const sentences = plainChunk(n.body, titles).split(/(?<=[.!?])\s+/);
  return facts.find(hit) ?? sentences.find(hit) ?? (plainChunk(match, titles) || factLine(n));
}

function noteRow(s: State, n: Note, snippet: string, words: string[] = []) {
  const { seen } = audience(s, n.fm.id);
  return `<a class="b-row" href="${pageHref(n.fm.id)}" title="${esc(n.fm.id)}"><span class="b-main"><span><span class="b-title">${markWords(String(n.fm.title ?? n.fm.id), words)}</span> <span class="kind">${esc(kindLabel(folderOf(n.fm.id)))}</span>${isPrivate(n.fm.sensitivity) ? '<span class="kind">Private</span>' : ""}</span>${snippet ? `<span class="b-snip">${markWords(snippet, words)}</span>` : ""}<span class="b-meta">${seen.length ? `${esc(names(seen.map((a) => agentLabel(s.rules, a))))} can see this` : "Only you can see this"} · updated ${esc(sinceDate(n.fm.updated))}${n.fm.by ? ` by ${esc(who(s, n.fm.by))}` : ""}</span></span></a>`;
}

// What sits under the box: results for a query, a kind's notes, or the home sections.
export function brainResults(s: State, csrf: string, q = "", kind?: string, page = 1): string {
  const query = q.trim();
  if (query) {
    const hits = searchNotes(s, query);
    const words = queryWords(query);
    const titles = new Map(s.notes.map((n) => [n.fm.id, String(n.fm.title ?? n.fm.id)]));
    const rows = hits.map((h) => noteRow(s, h.note, snippetFor(h.note, h.match, words, titles), words)).join("");
    return `<div class="b-head"><h2>${hits.length ? `${hits.length} note${hits.length > 1 ? "s" : ""}` : "No notes match"}</h2></div>
<div class="card b-list">${rows}</div>`;
  }
  if (kind) {
    const list = browsable(s).filter((n) => folderOf(n.fm.id) === kind).sort((a, b) => String(a.fm.title).localeCompare(String(b.fm.title)));
    const one = paged(list, page);
    return `<div class="b-head"><h2>${esc(kindLabel(kind))} (${list.length})</h2><a class="sub" href="/brain">All kinds</a></div>
<div class="card b-list">${one.rows.map((n) => noteRow(s, n, factLine(n))).join("") || `<div class="empty">No notes of this kind yet.</div>`}</div>${pager(one, (n) => `/brain?kind=${encodeURIComponent(kind)}${n > 1 ? `&page=${n}` : ""}`, "notes")}`;
  }
  const kinds = keptFor(s.root, "kinds", s.version, () => kindCounts(s));
  const changes = recentChanges(s);
  // Every fact's freshness against today: kept while the brain, rules and day are the same.
  const stale = keptFor(s.root, "needs-look", s.version, () => needsLook(s));
  const byId = new Map(s.notes.map((n) => [n.fm.id, n]));
  const changeRows = changes.map((c) => {
    const n = byId.get(c.id)!;
    return `<a class="b-row" href="${pageHref(c.id)}" title="${esc(c.attr ? `${c.id}#${c.attr}` : c.id)}"><span class="b-main"><span class="b-title">${esc(n.fm.title)}</span><span class="b-snip">${esc(cap(c.attr ? plain(c.attr) : "the note"))}, ${esc(c.why)}</span></span><span class="b-when">${esc(sinceDate(c.at.slice(0, 10)))}</span></a>`;
  }).join("");
  // A page's facts together, its title once (use-it pass, 2026-10-25: a project's status and next
  // step as two rows under one title read as a conflict).
  const firstAt = new Map<string, number>();
  stale.forEach((x, i) => { if (!firstAt.has(x.note.fm.id)) firstAt.set(x.note.fm.id, i); });
  const grouped = stale.map((x, i) => ({ x, i })).sort((a, b) => firstAt.get(a.x.note.fm.id)! - firstAt.get(b.x.note.fm.id)! || a.i - b.i).map(({ x }) => x);
  const staleRows = grouped.map((x, i) => `<div class="b-row" id="look-${esc(x.note.fm.id)}-${esc(x.attr)}"><span class="b-main"><span>${i && grouped[i - 1].note.fm.id === x.note.fm.id ? `<span class="sub">↳ ` : `<a class="b-title" href="${pageHref(x.note.fm.id)}" title="${esc(x.note.fm.id)}">${esc(x.note.fm.title)}</a> <span class="sub">· `}<span title="${esc(x.attr)}">${esc(cap(x.attr))}</span>: ${esc(plainValue(x.value, s))}</span></span><span class="b-meta">Checked ${esc(sinceDate(x.checked))}</span></span><span class="acts">${button(csrf, "fact-confirm", { id: x.note.fm.id, attribute: x.attr }, "Still true")}<a class="btn" href="${noteHref(x.note.fm.id)}?edit=${encodeURIComponent(x.attr)}#f-${esc(x.attr)}">Change</a></span></div>`).join("");
  const helpers = s.agents.map((a) => `<a href="/agent/${encodeURIComponent(a.name)}"${a.label !== a.name ? ` title="${esc(a.name)}"` : ""}>${esc(a.label)}</a>`);
  return `${helpers.length ? `<p class="sub">Your assistants: ${helpers.join(", ")}. Each one sees only the notes you share with it.</p>` : ""}<div class="b-head"><h2>Browse</h2></div>
<div class="b-kinds">${kinds.map((k) => `<a class="b-kind" href="/brain?kind=${encodeURIComponent(k.folder)}" title="${esc(k.folder)}/"><span>${esc(k.label)}</span><b>${k.count}</b></a>`).join("") || '<div class="empty">No notes yet. Run <code>pocketbrain init</code> or import from Notion.</div>'}</div>
<div class="b-head"><h2>Changed this week</h2><a class="sub" href="/history">See every change</a></div>
<div class="card b-list">${changeRows || '<div class="empty">Nothing changed in the last 7 days. Changes your assistants save show up here.</div>'}</div>
<div class="b-head"><h2>Needs a look${stale.length ? ` (${stale.length})` : ""}</h2></div>
<div class="card b-list">${staleRows || '<div class="empty">Everything has been checked recently.</div>'}</div>${forgottenSection(s, csrf)}`;
}

// Notes the owner forgot, still in git: one click puts each back exactly as it was.
function forgottenSection(s: State, csrf: string) {
  const list = keptFor(s.root, "forgotten", s.dayKey, () => recentlyForgotten(s.root));
  if (!list.length) return "";
  return `<div class="b-head"><h2>Recently forgotten</h2></div><div class="card b-list">${list.map((f) => `<div class="b-row"><span class="b-main"><span class="b-title" title="${esc(f.id)}">${esc(f.title)}</span><span class="b-meta">Forgotten ${esc(sinceDate(f.at.slice(0, 10)))} · no assistant sees it</span></span><span class="acts">${button(csrf, "note-bring-back", { hash: f.hash }, "Bring back")}</span></div>`).join("")}</div>`;
}

// The one box: typing searches (on this computer, no model). A question goes in the home's box
// (src/owner-say.ts); the old Ask box is gone.
function searchBox(q = "") {
  return `<form method="get" action="/brain" id="b-search" class="b-search" role="search"><input type="search" id="q" name="q" value="${esc(q)}" placeholder="Search" aria-label="Search" autocomplete="off" spellcheck="false"><button>Search</button></form>`;
}

const SEARCH_SCRIPT = `<script>
(()=>{const q=document.getElementById("q"),out=document.getElementById("results");if(!q||!out)return;let t,last=q.value;
q.addEventListener("input",()=>{clearTimeout(t);t=setTimeout(async()=>{const v=q.value;if(v===last)return;last=v;
try{const r=await fetch("/brain/results?q="+encodeURIComponent(v),{credentials:"same-origin"});if(r.ok&&q.value===v){out.innerHTML=await r.text();history.replaceState(null,"",v.trim()?"/brain?q="+encodeURIComponent(v):"/brain")}}catch{}},120)});
q.addEventListener("keydown",e=>{if(e.key==="Escape"&&q.value){q.value="";q.dispatchEvent(new Event("input"))}});
if(!q.value)q.focus()})();
</script>`;

export function brainPage(s: State, csrf: string, opts: { q?: string; kind?: string; page?: number } = {}): Page {
  const body = `<h1>Brain</h1>${searchBox(opts.q)}<div id="results" aria-live="polite">${brainResults(s, csrf, opts.q, opts.kind, opts.page)}</div>${SEARCH_SCRIPT}`;
  return { title: "Brain", tab: "brain", body };
}

// One fact's quieter second line: where it came from, who added it, how fresh it is.
function recMeta(s: State, n: Note, attr: string, r: FactRecord, csrf: string) {
  const bits: string[] = [];
  const src = sourceWords(r.sources);
  const mine = isOwnerConfirmed(r.verification);
  if (src && !mine) bits.push(`from ${esc(src)}`);
  if (!mine) bits.push(`${term(r.verification)}`);
  const by = who(s, r.by);
  if (by !== "you") bits.push(`added by ${esc(by)}`);
  const fresh = freshnessOf(s, n, attr, r);
  bits.push(r.last_confirmed ? `confirmed ${esc(sinceDate(r.last_confirmed))}` : `dated ${esc(sinceDate(r.as_of))}`);
  const title = (r.sources ?? []).map((x) => (typeof x === "string" ? x : x.ref)).join(", ");
  if (fresh === "stale" || fresh === "due") bits.push("may be out of date");
  const life = lifeWords(s, n, attr, r);
  if (life) bits.push(life);
  return `<div class="b-meta" title="${esc(title)}">${bits.join(" · ")}</div>`;
}

function recTags(s: State, n: Note, attr: string, r: FactRecord) {
  const t: string[] = [];
  if (isOwnerConfirmed(r.verification)) t.push(`<span class="kind" title="${esc(r.verification)}">your word</span>`);
  if (r.sensitivity && isPrivate(r.sensitivity) && !isPrivate(n.fm.sensitivity)) t.push(`<span class="kind" title="${esc(r.sensitivity)}">private</span>`);
  if (r.share_with) t.push(`<span class="kind">only ${r.share_with.length ? esc(names(r.share_with.map((a) => agentLabel(s.rules, a)))) : "you"}</span>`);
  return t.join("");
}

function whoWillSee(s: State, n: Note, attr: string, isNew = false) {
  const aud = isNew ? audience(s, n.fm.id).seen : factAudience(s, n.fm.id, attr);
  return aud.length ? `${esc(names(aud.map((a) => agentLabel(s.rules, a))))} will see ${isNew ? "it" : "the new value"}.` : "No assistant sees this, only you.";
}

function editForm(s: State, csrf: string, n: Note, attr: string, current: string, open: boolean, label: string, isNew = false) {
  return form(csrf, "/action/fact-set", `<input type="hidden" name="id" value="${esc(n.fm.id)}"><input type="hidden" name="attribute" value="${esc(attr)}"><input type="text" name="value" value="${esc(current)}" aria-label="${esc(label)}" autocomplete="off">
<div class="b-foot"><span>${whoWillSee(s, n, attr, isNew)} </span><span class="b-gap"></span><input type="text" name="as_of" placeholder="since (today)" aria-label="as of" class="b-asof"><a class="btn" href="${noteHref(n.fm.id)}#f-${esc(attr)}" data-cancel>Cancel</a><button class="go">Save</button></div>`, `class="b-edit"${open ? "" : " hidden"}`);
}

function factRow(s: State, csrf: string, n: Note, attr: string, f: Fact, editAttr?: string) {
  const name = `<div class="b-k" title="${esc(attr)}">${esc(cap(attr))}<a class="b-why sub" href="${whyHref(n.fm.id, attr)}">Where from</a></div>`;
  const open = editAttr === attr;
  if (isDisputed(f)) {
    return `<div class="b-fact" id="f-${esc(attr)}">${name}<div class="b-v"><div><span class="kind k-disputed" title="${esc(f.dispute)}">two answers disagree</span> <a href="/settle/${esc(f.dispute)}">Settle it</a></div>${f.candidates.map((c, i) => `<div class="b-meta">(${i + 1}) <b>${esc(plainValue(c.value, s))}</b>, from ${esc(sourceWords(c.sources) || "a source")}, added by ${esc(who(s, c.by))}</div>`).join("")}</div></div>`;
  }
  // A conflict waiting beside the live value (`contested`, G425) keeps the value and links to its screen.
  const waits = (isList(f) ? f.items.filter((i) => !i.valid_to && !i.retired) : [f as FactRecord]).map((r) => r.contested).find((x): x is string => typeof x === "string");
  const settle = waits ? `<div><span class="kind k-disputed" title="${esc(waits)}">two answers disagree</span> <a href="/settle/${esc(waits)}">Settle it</a></div>` : "";
  if (isList(f)) {
    const live = f.items.filter((i) => !i.valid_to && !i.retired);
    return `<div class="b-fact" id="f-${esc(attr)}">${name}<div class="b-v">${settle}${live.map((i) => `<div class="b-item"><div class="b-show">${esc(plainValue(i.value, s))}${recTags(s, n, attr, i)}</div>${recMeta(s, n, attr, i, csrf)}</div>`).join("") || '<div class="b-meta">No items yet.</div>'}
<a class="b-add" href="${noteHref(n.fm.id)}?edit=${encodeURIComponent(attr)}#f-${esc(attr)}" data-edit="${esc(attr)}">+ Add to ${esc(plain(attr))}</a>${editForm(s, csrf, n, attr, "", open, `new value for ${attr}`)}</div></div>`;
  }
  const r = f as FactRecord;
  return `<div class="b-fact${open ? " editing" : ""}" id="f-${esc(attr)}">${name}<div class="b-v">${settle}<div class="b-show"${open ? " hidden" : ""}><a class="b-val" href="${noteHref(n.fm.id)}?edit=${encodeURIComponent(attr)}#f-${esc(attr)}" data-edit="${esc(attr)}" title="Click to change">${esc(plainValue(r.value, s))}</a>${recTags(s, n, attr, r)}</div>${open ? "" : recMeta(s, n, attr, r, csrf)}${editForm(s, csrf, n, attr, val(r.value), open, `new value for ${attr}`)}</div>${["stale", "due"].includes(freshnessOf(s, n, attr, r)) && !open ? `<div class="b-side">${button(csrf, "fact-confirm", { id: n.fm.id, attribute: attr }, "Still true")}</div>` : '<div class="b-hint-edit" aria-hidden="true">Click to change</div>'}</div>`;
}

// [[id]] and [[id|label]] links in a note's text, shown by title (the id on hover).
// A link by a title or alias that fits one note goes there too; one that fits none reads as its
// words, without the brackets.
export function wikiLinks(s: State, text: string) {
  const titles = new Map(s.notes.map((n) => [n.fm.id, String(n.fm.title ?? n.fm.id)]));
  const named = new Map<string, string | null>();
  for (const n of s.notes) for (const t of new Set([n.fm.title, ...(n.fm.aliases ?? [])].map((x) => String(x ?? "").toLowerCase()).filter(Boolean))) named.set(t, named.has(t) ? null : n.fm.id);
  return esc(text).replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, to: string, label?: string) => {
    const id = titles.has(to) ? to : named.get(to.toLowerCase()) ?? undefined;
    return id ? noteLink(id, label ?? titles.get(id)!) : (label ?? to);
  });
}
// A fact's value as plain words: a [[link]] in it shows its words, and a page's id ("orgs/town",
// linked or not) shows that page's name.
const plainValue = (v: unknown, s?: State) => {
  const title = (id: string) => { const n = s?.notes.find((x) => x.fm.id === id); return n ? String(n.fm.title ?? id) : undefined; };
  const t = val(v);
  return title(t.trim()) ?? t.replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_m, to: string, label?: string) => label ?? title(to) ?? to);
};

// A reference as words: "Email, 5 Oct 2026" with the source refs it names on hover, never as text.
const REF_IN = /\s*\(((?:[a-z][a-z-]*:[^\s(),;]+(?:,\s*)?)+)\)/g;
function referenceText(s: State, text: string): string {
  const refs: string[] = [];
  const words = text.replace(REF_IN, (_m, r: string) => { refs.push(...r.split(/,\s*/)); return ""; }).replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (d) => `\u0000${d}\u0000`);
  const html = wikiLinks(s, words).replace(/\u0000(\d{4}-\d{2}-\d{2})\u0000/g, (_m, d: string) => day(d));
  return refs.length ? `<span title="${esc(refs.join(", "))}">${html}</span>` : html;
}

const quotesOf = (text: string, quote?: (ref: string) => string[]) => !quote ? "" : [...new Set([...new Set([...text.matchAll(REF_IN)].flatMap((m) => m[1].split(/,\s*/)))].flatMap((r) => quote(r)))].filter((q) => q.trim()).map((q) => `<details class="quote"><summary>What the source said</summary><blockquote>${esc(q)}</blockquote></details>`).join("");

// The notes text as wiki sections: `## ` headings, footnote refs as numbers, the references
// listed under the text (src/wiki.ts). A body with neither reads exactly as before.
// `quote` (the owner's page only, G451): the words a reference's source said, kept outside git,
// shown folded under the reference so they open on a tap.
// `level`: the heading level of its sections, one under the page's own (the owner's page has no
// h2 above its text, so its sections are h2: a jump from h1 to h3 fails the UI audit).
// `paras` (the owner's page): its text in paragraphs, a blank line between them and a line break
// kept as one, a "# " line as a heading (Mac, 2026-10-31: a heading ran into its first line).
export function wikiBody(s: State, body: string, quote?: (ref: string) => string[], level = 3, paras = false) {
  const h = `h${level}`;
  const f = footnotes(body);
  const num = new Map(f.notes.map((x) => [x.label, x.n]));
  // Labels that share a number (one mail behind two facts) read as one reference: "[1]", not "[1][1]".
  const sup = (n: number) => `<sup><a href="#fn-${n}" class="b-ref">[${n}]</a></sup>`;
  const refs = (html: string) => html.replace(/(?:\[\^[^\]\s]+\])+/g, (run) => {
    const seen = new Set<number>();
    return [...run.matchAll(/\[\^([^\]\s]+)\]/g)].map((m) => {
      const n = num.get(m[1]!);
      if (n === undefined) return m[0];
      if (seen.has(n)) return "";
      seen.add(n);
      return sup(n);
    }).join("");
  });
  const text = (t: string) => {
    if (!paras) return refs(wikiLinks(s, idsAsWords(t)));
    const out: string[] = [];
    for (const p of t.split(/\n\s*\n/)) {
      let lines: string[] = [];
      const flush = () => { if (lines.length) out.push(`<p>${lines.map((l) => refs(wikiLinks(s, idsAsWords(l)))).join("<br>")}</p>`); lines = []; };
      for (const l of p.split("\n").map((x) => x.trim()).filter(Boolean)) {
        const m = l.match(/^#{1,6} +(.+)$/);
        if (m) { flush(); out.push(`<${h}>${esc(m[1]!)}</${h}>`); } else lines.push(l);
      }
      flush();
    }
    return out.join("");
  };
  const parts = sections(f.text).map((x) => `${x.heading !== undefined ? `<${h}>${esc(x.heading)}</${h}>` : ""}${text(x.text)}`);
  const list = f.notes.length ? `<${h}>References</${h}><ol class="b-refs">${f.notes.filter((x, i) => f.notes.findIndex((y) => y.n === x.n) === i).map((x) => `<li id="fn-${x.n}">${referenceText(s, x.text)}${quotesOf(x.text, quote)}</li>`).join("")}</ol>` : "";
  return parts.join("") + list;
}

const NOTE_SCRIPT = `<script>
(()=>{const open=(row,attr)=>{document.querySelectorAll("form.b-edit:not([hidden])").forEach(f=>{f.hidden=true;const sh=f.parentElement.querySelector(".b-show");if(sh)sh.hidden=false;f.closest(".b-fact")?.classList.remove("editing")});
const f=row.querySelector("form.b-edit");if(!f)return;const sh=row.querySelector(".b-show");if(sh&&!row.querySelector(".b-item"))sh.hidden=true;f.hidden=false;row.classList.add("editing");const i=f.querySelector("input[name=value]");i.focus();i.select()};
document.addEventListener("click",e=>{const a=e.target.closest("[data-edit]");if(a){e.preventDefault();open(a.closest(".b-fact,.b-addfact"),a.dataset.edit);return}
const c=e.target.closest("[data-cancel]");if(c){e.preventDefault();const f=c.closest("form");f.reset();f.hidden=true;const row=f.closest(".b-fact,.b-addfact");row?.classList.remove("editing");const sh=row?.querySelector(".b-show");if(sh)sh.hidden=false;const t=document.getElementById("b-text");if(f.id==="b-text-form"&&t)t.hidden=false;return}
const t=e.target.closest("#b-text");if(t&&!e.target.closest("a")){t.hidden=true;const f=document.getElementById("b-text-form");f.hidden=false;f.querySelector("textarea").focus()}});
document.addEventListener("keydown",e=>{if(e.key==="Escape"){const f=e.target.closest&&e.target.closest("form.b-edit,#b-text-form");if(f)f.querySelector("[data-cancel]")?.click()}
if((e.key==="Enter"||e.key===" ")&&e.target.id==="b-text"){e.preventDefault();e.target.click()}});})();
</script>`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-09-28" -> "28 Sep 2026"; partial dates stay as partial as they are.
const day = (d: string) => { const m = d.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/); return !m ? esc(d) : m[3] ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : m[2] ? `${MONTHS[+m[2] - 1]} ${m[1]}` : m[1]; };

// Replaced-by and merged-into go at the top: the one link that changes what you do with the note.
function replacedBanner(s: State, n: Note) {
  const c = connections(s, n);
  const title = (id: string) => s.notes.find((x) => x.fm.id === id)?.fm.title;
  if (c.mergedInto) return `<div class="flash">This note was merged into ${title(c.mergedInto) ? noteLink(c.mergedInto, String(title(c.mergedInto))) : esc(c.mergedInto)}. Read that one instead.</div>`;
  if (c.replacedBy) return `<div class="flash">Replaced by ${title(c.replacedBy) ? noteLink(c.replacedBy, String(title(c.replacedBy))) : esc(c.replacedBy)}. This one is kept as history; assistants are told not to act on it.</div>`;
  return "";
}

// Each ## section can be edited on its own, by hand or with chat (docs/wiki.md); the rest of the
// note stays as it is, and the commit says which section changed and how.
function sectionEdits(csrf: string, n: Note) {
  const secs = sections(footnotes(n.body).text).filter((x) => x.heading !== undefined);
  if (!secs.length) return "";
  return secs.map((x) => `<details class="b-hist b-sec"><summary>Edit the ${esc(x.heading!)} section</summary><div class="card">${form(csrf, "/action/section-save", `<input type="hidden" name="id" value="${esc(n.fm.id)}"><input type="hidden" name="heading" value="${esc(x.heading!)}"><textarea name="text" rows="4" aria-label="${esc(x.heading!)} section">${esc(x.text)}</textarea><div class="b-foot"><span class="b-gap"></span><button class="go">Save section</button></div>`)}${form(csrf, `/propose/${n.fm.id}`, `<input type="hidden" name="section" value="${esc(x.heading!)}"><input type="text" name="instruction" placeholder="Or say what to change in it" aria-label="what to change in the ${esc(x.heading!)} section" autocomplete="off"><button>Edit with chat</button>`, 'class="b-tell"')}</div></details>`).join("");
}

// Recent updates (src/wiki.ts): on a hub page the whole brain's, on any other page its own.
// The lines name pages and kinds of change, never values.
function updatesSection(s: State, n: Note) {
  const hub = n.fm.type === "hub";
  const lines = recentUpdates(s.root, s.notes, hub ? { limit: 10 } : { id: n.fm.id, limit: 5, commits: 30 });
  if (!lines.length) return "";
  return `<h2>Recent updates</h2><div class="b-plain">${lines.map((u) => `<div class="b-row"><span class="b-main"><span>${hub && u.id !== n.fm.id ? noteLink(u.id, u.text) : esc(u.text)}</span><span class="b-meta">${esc(sinceDate(u.at.slice(0, 10)))} by ${esc(who(s, u.by))}</span></span></div>`).join("")}</div>`;
}

// Everything this note is tied to, as lists you can click. Only links the brain records.
function connectionsSection(s: State, n: Note) {
  const c = connections(s, n);
  const title = (id: string) => s.notes.find((x) => x.fm.id === id)?.fm.title;
  const groups: string[] = [];
  const noteRows = (xs: Note[]) => xs.map((x) => `<a class="b-row" href="${pageHref(x.fm.id)}" title="${esc(x.fm.id)}"><span class="b-main"><span class="b-title">${esc(x.fm.title)}</span><span class="b-meta">${esc(kindLabel(folderOf(x.fm.id)))}</span></span></a>`).join("");
  if (c.replaces.length) groups.push(`<h3>Replaces</h3><div class="b-plain">${c.replaces.map((id) => title(id) ? noteRows([s.notes.find((x) => x.fm.id === id)!]) : `<div class="b-row"><span class="b-main mono">${esc(id)}</span></div>`).join("")}</div>`);
  if (c.sources.length) groups.push(`<h3>Where it came from</h3><div class="b-plain">${c.sources.map((u) => `<div class="b-row"><span class="b-main"><span>${u.url ? `<a href="${esc(u.url)}" target="_blank" rel="noopener noreferrer" title="${esc(u.ref)}">${esc(cap(u.words))}</a>` : `<span title="${esc(u.ref)}">${esc(cap(u.words))}</span>`} <span class="sub">dated ${day(u.dated)}</span></span><span class="b-meta">Gave ${u.attrs.map((a) => `<a href="#f-${esc(a)}" title="${esc(a)}">${esc(plain(a))}</a>`).join(", ")}</span></span></div>`).join("")}</div>`);
  const under = pageTree(s.notes).children.get(n.fm.id) ?? [];
  if (under.length) groups.push(`<h3>Pages under this</h3><div class="b-plain">${noteRows(under.map((id) => s.notes.find((x) => x.fm.id === id)!))}</div>`);
  if (c.mentionedIn.length) groups.push(`<h3>Mentioned in</h3><div class="b-plain">${noteRows(c.mentionedIn)}</div>`);
  if (c.linksTo.length) groups.push(`<h3>Links to</h3><div class="b-plain">${noteRows(c.linksTo)}</div>`);
  return `<h2 id="b-connections">Connections</h2>${groups.join("") || '<div class="empty">Nothing links here yet. Write [[people/jane-roy]] in the notes to link another note.</div>'}`;
}

const LEVEL_WORDS: [string, string][] = [["public", "Public"], ["personal", "Personal"], ["private", "Private: only assistants allowed private notes"], ["secret", "Secret: no assistant"]];

// Narrow (or undo a narrowing) without the CLI: hide the note from one assistant by name, or
// change the note's level. Showing again only removes a by-name hide; it never adds a share.
function whoCanSee(s: State, csrf: string, n: Note, seen: string[]) {
  const id = n.fm.id;
  const rows = s.agents.map((a) => {
    const hidden = (s.rules.policy.agents[a.name]?.exclude ?? []).includes(id);
    const act = seen.includes(a.name) ? button(csrf, "note-hide", { id, agent: a.name }, `Hide from ${a.label}`)
      : hidden ? button(csrf, "note-show", { id, agent: a.name }, `Show to ${a.label} again`)
      : `<span class="sub">doesn't get it through its share</span>`;
    return `<div class="b-row"><span class="b-main"><span title="${esc(a.name)}">${esc(a.label)}</span><span class="b-meta">${seen.includes(a.name) ? "can see it" : hidden ? "hidden by you" : "can't see it"}</span></span><span class="acts">${act}</span></div>`;
  }).join("");
  const level = form(csrf, "/action/note-sensitivity", `<input type="hidden" name="id" value="${esc(id)}"><select name="sensitivity" aria-label="how private">${LEVEL_WORDS.map(([v, l]) => `<option value="${v}"${v === n.fm.sensitivity ? " selected" : ""}>${esc(l)}</option>`).join("")}</select> <button>Save</button>`, 'class="inline" data-confirm="Change how private this note is? A less private level can let more assistants see it."');
  return `<details class="b-hist b-who"><summary>Change who can see it</summary><div class="card b-list">${rows || '<div class="empty">No assistants yet.</div>'}<div class="b-row"><span class="b-main"><span>How private</span><span class="b-meta">Facts you marked private stay private whatever the note is.</span></span><span class="acts">${level}</span></div></div></details>`;
}

export function notePage(s: State, csrf: string, note: Note, text: string, editor?: string, editAttr?: string): Page {
  const fm = note.fm;
  const facts = Object.entries(fm.facts ?? {});
  const { seen, unseen } = audience(s, fm.id);
  const priv = isPrivate(fm.sensitivity);
  const history = Object.entries(fm.history ?? {}).flatMap(([a, rs]) => rs.map((r) => ({ a, r })));
  const kind = kindLabel(folderOf(fm.id));
  const seenStrip = `<div class="b-seen">${priv ? '<span class="kind" title="' + esc(fm.sensitivity) + '">Private</span>' : ""}<span>${seen.length ? (priv ? "Only you and" : "Who can see this:") : "Only you can see this."}</span>${seen.map((a) => `<a class="kind" href="/agent/${encodeURIComponent(a)}" title="${esc(a)}">${esc(agentLabel(s.rules, a))}</a>`).join("")}${seen.length && unseen.length ? `<span class="sub">· ${esc(names(unseen.map((a) => agentLabel(s.rules, a))))} can't</span>` : ""}${priv && seen.length ? `<span class="b-why">${seen.map((a) => { const ag = s.agents.find((x) => x.name === a); return `${esc(agentLabel(s.rules, a))} can see it through its share: ${esc((ag?.slices ?? []).join(", ") || "all")}.`; }).join(" ")} <a href="/agent/${encodeURIComponent(seen[0])}">Change</a></span>` : ""}${editor ? `<span class="sub">· your editor (${esc(editor)}) can change it directly</span>` : ""}</div>`;
  const addOpen = editAttr === "_new";
  const whoBox = whoCanSee(s, csrf, note, seen);
  const addFact = `<div class="b-addfact${addOpen ? " editing" : ""}"><a class="b-add" href="${noteHref(fm.id)}?edit=_new#b-facts" data-edit="_new">+ Add a fact</a>${form(csrf, "/action/fact-set", `<input type="hidden" name="id" value="${esc(fm.id)}"><div class="b-pair"><input type="text" name="attribute" placeholder="What, e.g. phone" aria-label="what"><input type="text" name="value" placeholder="Value" aria-label="value" autocomplete="off"></div><div class="b-foot"><span>${whoWillSee(s, note, "", true)}</span><span class="b-gap"></span><input type="text" name="as_of" placeholder="since (today)" aria-label="as of" class="b-asof"><a class="btn" href="${noteHref(fm.id)}#b-facts" data-cancel>Cancel</a><button class="go">Add</button></div>`, `class="b-edit"${addOpen ? "" : " hidden"}`)}</div>`;
  const body = note.body.trim();
  const prose = `<h2>Notes</h2><div id="b-text" class="b-text" tabindex="0" role="button" aria-label="Edit the notes" title="Click to edit">${body ? wikiBody(s, body) : '<span class="sub">Add notes about this, in your own words.</span>'}</div>
${form(csrf, "/action/note-body-save", `<input type="hidden" name="id" value="${esc(fm.id)}"><textarea name="body" rows="6" aria-label="notes">${esc(body)}</textarea><div class="b-foot"><span>${seen.length ? `${esc(names(seen.map((a) => agentLabel(s.rules, a))))} will see this text.` : "Only you see this text."}</span><span class="b-gap"></span><a class="btn" href="${noteHref(fm.id)}" data-cancel>Cancel</a><button class="go">Save notes</button></div>`, 'id="b-text-form" class="b-textform" hidden')}`;
  const earlier = history.length ? `<details class="b-hist"><summary>Earlier values (${history.length})</summary><div class="card b-list">${history.map(({ a, r }) => `<div class="b-row"><span class="b-main"><span><span class="sub" title="${esc(a)}">${esc(cap(a))}:</span> <s>${esc(plainValue(r.value, s))}</s></span><span class="b-meta">${r.as_of ? `from ${esc(r.as_of)}` : ""}${r.ended_by?.correction ? ` · never right, corrected by ${esc(who(s, r.ended_by.by))} ${esc(r.ended_by.at)}` : r.ended_by ? ` until ${esc(r.ended_by.at)}, replaced by ${esc(who(s, r.ended_by.by))}` : r.retired ? ` · forgotten ${esc(r.retired.at)}` : ""} · added by ${esc(who(s, r.by))}</span></span></div>`).join("")}</div></details>` : "";
  const tell = form(csrf, `/propose/${fm.id}`, `<input type="text" name="instruction" placeholder="What changed?" aria-label="What changed?" autocomplete="off"><button>Suggest</button>`, 'class="b-tell"');
  const page = `<div class="b-crumbs"><a href="/brain">Brain</a> / <a href="/brain?kind=${encodeURIComponent(folderOf(fm.id))}">${esc(kind)}</a>${ancestors(s.notes, fm.id).map((id) => ` / ${noteLink(id, String(s.notes.find((x) => x.fm.id === id)?.fm.title ?? id))}`).join("")}</div>
<div class="b-notehead"><div><h1 title="${esc(fm.id)}">${esc(fm.title)}</h1><div class="sub">${esc(cap(fm.type))} · ${esc(fm.area)}${fm.status && fm.status !== "active" ? ` · ${esc(plain(fm.status))}` : ""} · updated ${esc(sinceDate(fm.updated))} by ${esc(who(s, fm.by))} · <a href="/history/${fm.id.split("/").map(encodeURIComponent).join("/")}">History</a></div>${summaryOf(note) ? `<p class="b-summary">${esc(plainValue(summaryOf(note)!.replace(/\[\^[^\]\s]+\]/g, "")))}</p>` : ""}</div></div>
${replacedBanner(s, note)}${seenStrip}${whoBox}${tell}
<div class="b-facts" id="b-facts">${facts.map(([a, f]) => factRow(s, csrf, note, a, f, editAttr)).join("") || '<div class="empty">No facts yet.</div>'}${addFact}</div>
${prose}${sectionEdits(csrf, note)}${updatesSection(s, note)}${connectionsSection(s, note)}${earlier}
<details class="b-hist"><summary>Edit file</summary>${form(csrf, "/action/note-save", `<input type="hidden" name="id" value="${esc(fm.id)}"><textarea name="text" rows="24" spellcheck="false" class="b-raw" aria-label="the whole note as text">${esc(text)}</textarea><div style="margin-top:8px"><button>Save note</button> <span class="sub">Keep the id line as it is. Passwords and card numbers are refused.</span></div>`, 'class="card"')}</details>${folderOf(fm.id) === "agents" ? "" : `<div class="acts b-forget">${button(csrf, "note-forget", { id: fm.id }, "Forget", "danger", "Forget this note? No assistant will see it again. You can bring it back from the Brain tab.")}</div>`}${NOTE_SCRIPT}`;
  return { title: fm.title, tab: "brain", body: page };
}

// What a proposal changes, fact by fact: [label code, before, after].
export function factChanges(before: string, after: string): { attr: string; from?: string; to?: string }[] {
  let a: Note, b: Note;
  try { a = parseNote(before, "x.md"); b = parseNote(after, "x.md"); } catch { return []; }
  const show = (f: Fact | undefined) => f === undefined ? undefined : isDisputed(f) ? "(in dispute)" : isList(f) ? f.items.filter((i) => !i.valid_to).map((i) => val(i.value)).join(", ") : val((f as FactRecord).value);
  const out: { attr: string; from?: string; to?: string }[] = [];
  for (const attr of new Set([...Object.keys(a.fm.facts ?? {}), ...Object.keys(b.fm.facts ?? {})])) {
    const x = show(a.fm.facts?.[attr]), y = show(b.fm.facts?.[attr]);
    if (x !== y) out.push({ attr, from: x, to: y });
  }
  return out;
}

export function proposalPage(s: State, csrf: string, p: EditProposal): Page {
  const diff = lineDiff(p.before, p.after);
  const changed = diff.filter(([k]) => k !== " ").length;
  const facts = factChanges(p.before, p.after);
  const bodyOf = (t: string) => t.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const textChanged = bodyOf(p.before) !== bodyOf(p.after);
  const note = s.notes.find((n) => n.fm.id === p.noteId);
  const { seen } = audience(s, p.noteId);
  const rows = diff.map(([k, l], i) => {
    const near = diff.slice(Math.max(0, i - 3), i + 4).some(([x]) => x !== " ");
    if (k === " " && !near) return "";
    const bg = k === "+" ? "background:color-mix(in srgb,var(--good) 16%,transparent)" : k === "-" ? "background:color-mix(in srgb,var(--bad) 16%,transparent)" : "";
    return `<div style="${bg};padding:0 8px;white-space:pre-wrap">${k} ${esc(l)}</div>`;
  }).join("");
  const list = [
    ...facts.map((c) => `<div class="b-change"><div class="sub" title="${esc(c.attr)}">${esc(cap(c.attr))}</div><div>${c.from !== undefined ? `<s>${esc(c.from)}</s> <span class="sub">to</span> ` : '<span class="sub">new:</span> '}${c.to !== undefined ? `<b>${esc(c.to)}</b>` : '<span class="sub">removed</span>'}</div></div>`),
    ...(textChanged ? [`<div class="b-change"><div class="sub">Notes</div><div>The text changes. <span class="sub">See the exact change below.</span></div></div>`] : []),
  ].join("");
  const body = `<div class="b-crumbs"><a href="/brain">Brain</a> / ${note ? noteLink(note.fm.id, String(note.fm.title)) : esc(p.noteId)}</div><h1>Suggested change</h1>
<p class="sub">You wrote: “${esc(p.instruction)}”</p>
<div class="card b-list">${changed ? list || '<div class="b-change"><div class="sub">Details</div><div>Only formatting changes.</div></div>' : '<div class="empty">The model changed nothing.</div>'}</div>
${changed ? `<div class="b-seen">${seen.length ? `${esc(names(seen.map((a) => agentLabel(s.rules, a))))} will see the new values.` : "No assistant sees this note."} Old values are kept under Earlier values.</div>` : ""}
<div class="acts" style="margin-top:16px;align-items:center">${changed ? button(csrf, "proposal-apply", { pid: p.id }, "Apply the change", "go") : ""}${button(csrf, "proposal-discard", { pid: p.id }, "Discard", "")}</div>
${changed ? `<details class="b-hist"><summary>Show the exact text change</summary><div class="card mono" style="padding:8px 0;font-size:12px">${rows}</div></details>` : ""}`;
  return { title: "Suggested change", tab: "brain", body };
}

export function editorCard(s: State, csrf: string, editor: string | undefined, commits: EditorCommit[]): string {
  const agents = s.agents.map((a) => a.name);
  const choose = form(csrf, "/action/editor-set", `<select name="agent" aria-label="editor">${agents.map((a) => `<option${a === editor ? " selected" : ""}>${esc(a)}</option>`).join("")}</select> <button>${editor ? "Change editor" : "Make it my editor"}</button>`, `class="inline" data-confirm="Let this agent change the brain directly, without your approval? Its writes still pass every check, and you can remove it here."`);
  const head = editor
    ? `<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center"><div><b>${esc(editor)}</b> is your editor: its writes skip the inbox and apply directly. Every check, the leak tripwire, secrets and rules/ protection still apply, and Pause still stops it.</div><div class="acts">${button(csrf, "editor-clear", {}, "Remove editor", "danger")}</div></div><div style="margin-top:8px" class="sub">Change to: ${choose}</div>`
    : `<div>No editor. Every assistant's write that isn't its own area goes to your inbox. You can name one assistant (for example the one you talk to most) to edit on your behalf.</div><div style="margin-top:8px">${choose}</div>`;
  const list = editor ? (commits.length
    ? `<h3>Its recent changes</h3><table><tbody>${commits.map((c) => `<tr><td class="sub">${esc(ownerLocal(c.at).replace("T", " ").slice(0, 16))}</td><td class="mono">${esc(c.subject)}</td><td>${c.reverted ? '<span class="kind">reverted</span>' : button(csrf, "commit-revert", { hash: c.hash }, "Revert", "danger", "Undo this change? It becomes a new commit by you.")}</td></tr>`).join("")}</tbody></table>`
    : '<div class="empty">No changes by it yet.</div>') : "";
  return `<h2>Your editor</h2><div class="card">${head}${list}</div>`;
}

// Assistants that signed in through the OAuth door and wait for the owner to say which agent
// they are (src/oauth.ts bindClient, the same as `pocketbrain oauth bind`). A client id and
// user agent come from whoever registered, so they are only ever shown escaped.
export function oauthCard(s: State, csrf: string, c: OAuthConfig | undefined, pending: Pending[]): string {
  if (!c) return "";
  const agents = s.agents.map((a) => a.name);
  const rows = pending.map((p) => {
    const approve = form(csrf, "/action/oauth-bind", `<input type="hidden" name="client_id" value="${esc(p.client_id)}"><select name="agent" aria-label="agent for ${esc(p.client_id)}">${agents.map((a) => `<option>${esc(a)}</option>`).join("")}</select> <input type="text" name="name" placeholder="label (optional)" aria-label="label for ${esc(p.client_id)}" style="width:130px"> <button class="go">Approve</button>`, `class="inline" data-confirm="Let this connection read and write as the chosen agent? It replaces any connection that agent already has. Only approve a sign-in you just made yourself."`);
    const slices = Object.keys(s.rules.slices).filter((x) => x !== "all").sort();
    // An access request the assistant filed itself (request_access): untrusted text, shown escaped,
    // and only a suggestion; the owner reviews the same preview and can narrow before Approve.
    // The id comes first; name and purpose are marked as the assistant's own words. Only area
    // slices and slices marked requestable are pre-checked; others are listed, unknown ones struck.
    const rq = p.request;
    const pre = rq ? rq.slices.filter((x) => requestable(s.rules, x)) : [];
    const back = rq ? comingBack(s.rules, c, rq) : undefined;
    const fresh = `<details${rq ? " open" : ""}><summary>or as a new assistant</summary><form method="get" action="/agents/new"><input type="hidden" name="client_id" value="${esc(p.client_id)}"><input type="text" name="agent" required pattern="[a-z][a-z0-9\-]{1,30}" placeholder="name, e.g. newbot" value="${esc(rq?.agent ?? "")}" aria-label="name of a new agent, sign-in ${esc(p.client_id)}" style="width:130px"> <input type="text" name="name" placeholder="label (optional)" value="${esc(rq?.name ?? "")}" aria-label="shown name of a new agent, sign-in ${esc(p.client_id)}" style="width:130px"><div>${slices.map((x) => `<label><input type="checkbox" name="slices" value="${esc(x)}"${pre.includes(x) ? " checked" : ""}> ${esc(x)}</label>`).join(" ")}</div><button>See what it would get</button></form></details>`;
    const review = rq && pre.length && !back ? `/agents/new?${new URLSearchParams([["client_id", p.client_id], ["agent", rq.agent], ["name", rq.name], ...pre.map((x) => ["slices", x])]).toString()}` : "";
    const askedFor = (x: string) => !s.rules.slices[x] ? `<s title="no such slice">${esc(x)}</s>` : pre.includes(x) ? esc(x) : `${esc(x)} <span title="only area slices and slices marked requestable are pre-checked">(not pre-checked)</span>`;
    const warn = back ? `<b class="h1-sub">You ${esc(comingBackText(back))}. Check it is the same assistant you meant to stop before you let it in.</b><br>` : "";
    const asked = rq ? `<div class="card-req"><span class="mono">${esc(rq.agent)}</span>, a new trial assistant. ${warn}The assistant says its name is “${esc(rq.said ?? rq.name)}” and its purpose: “${esc(rq.purpose)}”<br>Asks for: ${rq.slices.length ? rq.slices.map(askedFor).join(", ") : "no slice"}. ${review ? `<a class="go" href="${esc(review)}">Review and approve as trial</a>` : ""}</div>` : "";
    return `<tr><td class="mono">${esc(p.client_id)}</td><td class="sub">${asked}${p.calls} call(s), first ${esc(ownerLocal(p.first_seen).replace("T", " ").slice(0, 16))}, last ${esc(ownerLocal(p.last_seen).replace("T", " ").slice(0, 16))}${p.user_agent ? `<br>${esc(p.user_agent.slice(0, 120))}` : ""}</td><td>${approve}${fresh}</td><td>${button(csrf, "oauth-decline", { client_id: p.client_id }, "Decline", "danger", "Refuse this connection for good? The assistant has to reconnect to try again.")}</td></tr>`;
  }).join("");
  const bound = Object.entries(c.clients ?? {});
  const list = bound.length ? `<h3>Approved</h3><table><tbody>${bound.map(([id, b]) => `<tr><td class="mono">${esc(id)}</td><td>${esc(b.agent)}${b.name ? ` <span class="sub">(${esc(b.name)})</span>` : ""}</td><td class="sub">since ${esc(b.bound)}</td></tr>`).join("")}</tbody></table><div class="sub">Revoke access on an assistant above cuts its sign-in connections too.</div>` : "";
  // Replaced by a Reconnect (backlog 289): refused here, still an app at the sign-in service.
  const old = Object.entries(c.replaced ?? {});
  const gone = old.length ? `<h3>Replaced by a reconnect</h3><div class="sub">Refused here already. Each is still an app at your sign-in service, which holds only so many.</div><table><tbody>${old.map(([id, r]) => `<tr><td class="mono">${esc(id)}</td><td>${esc(r.agent)}</td><td class="sub">on ${esc(r.on)}</td></tr>`).join("")}</tbody></table>${c.management_client_id ? button(csrf, "oauth-cleanup", {}, `Delete ${old.length} old app${old.length === 1 ? "" : "s"} at the sign-in service`, "danger", "Delete these old apps at your sign-in service? They are already cut off here.") : `<div class="sub">To delete them in one click, set a management client: <code>pocketbrain oauth management &lt;client-id&gt;</code> (docs/oauth.md). Or delete them by hand in the sign-in service's Applications list.</div>`}` : "";
  return `<h2 title="OAuth connections">Sign-in connections</h2><div class="card">${pending.length ? `<div>These assistants signed in to your brain <span class="sub" title="${esc(c.resource)}">(through its sign-in door)</span> and wait for you to say which assistant they are. Until then they get nothing.</div><table><tbody>${rows}</tbody></table>` : '<div class="empty">No connection is waiting for approval.</div>'}${list}${gone}</div>`;
}

// A slice an access request may have pre-checked: an area, or one the owner marked requestable
// (a named slice can be as wide as all, or name people).
const requestable = (rules: Rules, x: string) => x !== "all" && !!rules.slices[x] && (x.startsWith("area:") || rules.slices[x].requestable === true);

// What a new agent for a waiting sign-in would get, before the owner says yes: the same carve the
// server will apply. Approve creates it as trial and lets that one connection in.
export function newAgentPage(csrf: string, clientId: string, req: { agent: string; name?: string; slices: string[] }, p: NewAgentPreview): Page {
  const kinds = Object.entries(p.kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k)} ${n}`).join(", ");
  const facts = [
    `<li><b>${esc(req.agent)}</b> would see ${p.notes} notes (of ${p.total})${kinds ? `: ${kinds}` : ""}.</li>`,
    `<li>Areas: ${p.areas.length ? p.areas.map(esc).join(", ") : "none"}. Slices: ${req.slices.map(esc).join(", ")}.</li>`,
    `<li>${p.money ? "<b>Includes money notes.</b>" : "No money."} ${p.private ? "<b>Includes private notes.</b>" : "No private notes."}</li>`,
    `<li>Writes wait for you (trial). You can revoke it on the Assistants page at any time.</li>`,
  ].join("");
  const sample = p.sample.length ? `<div class="sub">For example: ${p.sample.map(esc).join(" · ")}</div>` : "";
  const approve = form(csrf, "/action/oauth-new-agent", `<input type="hidden" name="client_id" value="${esc(clientId)}"><input type="hidden" name="agent" value="${esc(req.agent)}"><input type="hidden" name="name" value="${esc(req.name ?? "")}"><input type="hidden" name="slices" value="${esc(req.slices.join(","))}"><button class="go">Approve ${esc(req.agent)}</button>`, `data-confirm="Create ${esc(req.agent)} as a trial agent and let this sign-in in? Only approve a sign-in you just made yourself."`);
  return { title: `New agent ${req.agent}`, tab: "agents", body: `<h1>New assistant: ${esc(req.agent)}</h1><div class="card"><div class="sub">For the sign-in <span class="mono">${esc(clientId)}</span></div><ul>${facts}</ul>${sample}${approve} <a href="/agents">Back</a></div>` };
}

// Where one fact came from (docs/why.md): its sources and how strong they are, earlier values, and
// every write on it, refused and held ones included. The owner's page: nothing is left out.
export function whyPage(s: State, note: Note, attr: string, w: Why): Page {
  const rec = (r: WhyRecord, old: boolean) => `<div class="b-row"><span class="b-main"><span>${old ? `<s>${esc(plainValue(r.value, s))}</s>` : `<b>${esc(plainValue(r.value, s))}</b>`}</span><span class="b-meta">${esc(cap(r.strength))} · as of ${esc(r.as_of)}${r.ended ? ` · ended ${esc(r.ended)}` : ""}${r.last_confirmed ? ` · last checked ${esc(r.last_confirmed)}` : ""} · added by ${esc(who(s, r.by))}${r.recorded ? ` on ${esc(r.recorded)}` : ""}</span><span class="b-meta">${r.sources.length ? r.sources.map((x) => `<code title="${esc(x.kind)}">${esc(x.ref)}</code>`).join(", ") : "no source cited"}</span></span></div>`;
  const events = w.events.map((e) => `<div class="b-row"><span class="b-main"><span>${esc(ownerLocal(e.at).slice(0, 16).replace("T", " "))} · ${esc(who(s, e.by))}${e.token ? ` (${esc(plain(e.token))})` : ""}: ${esc(e.outcome ?? e.event)}</span>${e.checks?.length || e.step ? `<span class="b-meta">${e.step ? `conflict step ${e.step}` : ""}${e.step && e.checks?.length ? " · " : ""}${e.checks?.length ? `checks: ${esc(e.checks.join(", "))}` : ""}</span>` : ""}</span></div>`);
  const body = `<p class="sub"><a href="${noteHref(note.fm.id)}#f-${esc(attr)}">${esc(note.fm.title)}</a></p>
<h1>Where ${esc(plain(attr))} came from</h1>
${w.disputed ? `<p><span class="kind k-disputed" title="${esc(String(w.disputed))}">two answers disagree</span> <a href="${typeof w.disputed === "string" ? `/settle/${esc(w.disputed)}` : "/home"}">Settle it</a></p>` : ""}
<h2>Now</h2><div class="card b-list">${w.current.map((r) => rec(r, false)).join("") || '<div class="empty">No current value.</div>'}</div>
${w.earlier?.length ? `<h2>Before</h2><div class="card b-list">${w.earlier.map((r) => rec(r, true)).join("")}</div>` : ""}
<h2>Writes</h2><div class="card b-list">${events.join("") || '<div class="empty">No writes logged for this fact (it came with an import or a hand edit).</div>'}</div>`;
  return { title: `Where ${attr} came from`, tab: "brain", body };
}
