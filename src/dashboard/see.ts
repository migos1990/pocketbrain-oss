// SPDX-License-Identifier: AGPL-3.0-only
// See as (plans/as-read-by.md; the owner's ask of 2026-11-14): the owner's memory as one assistant
// is given it. /see/<assistant> lists every page with how much of it that assistant gets;
// /see/<assistant>/<page> is one page, a row per fact: readable when the assistant's own carve
// holds it, one fixed bar when it doesn't. Computed only from carve(grantFor(...)), the same cut
// the assistant reads through, so a row can't say more than the carve does. A view, never access:
// owner-only like every dashboard page, nothing is written and nothing is logged as a read. A
// private value stays shut on the 30-day sign-in exactly as on the page itself (/p).
import type { Note, FactRecord } from "../brain";
import { isList, isDisputed, sensitivityRank } from "../brain";
import { carve, grantFor, records, type CarveResult } from "../carve";
import { scrubLeaves } from "../view";
import { displayName, sayYearly } from "../diary";
import type { State } from "./data";
import { browsable, folderOf, KINDS } from "./browse";
import { agentTitle, cap } from "./labels";
import { markAgents } from "./marks";
import { plain, attrWords } from "./home";
import { esc, href, signInAgain } from "./html-home";
import { appPage } from "./html-app";

export const SEE_COPY = {
  you: "You",
  seeAs: "See as",
  as: "As",
  back: "Who knows",
  open: "Open the page",
  countOne: "facts on this page given to {name} today.",
  countMany: "facts on this page given to {name} today.",
  noFacts: "This page holds no facts yet.",
  bar: "Not given",
  shut: "private · sign in again to see it",
  shutPage: "This page is private. Sign in again to see what {name} is given from it.",
  words: "The page's own words",
  wordsGiven: "Given to {name}.",
  notGiven: "{name} is not given this page. Nothing is given from it.",
  paused: "{name} is paused. It is given nothing.",
  what: "This is what your memory gives {name} today, not what {name} already remembers.",
  change: "Change who sees this page",
  pagesOne: "pages given to {name} today",
  pagesMany: "pages given to {name} today",
  part: "{n} of them in part",
  all: "all of it",
  partOf: "part of it",
  factsOf: "{given} of {of} facts",
  wordsOnly: "its words only",
  nameOnly: "its name only",
};
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

export interface SeeFact { attr: string; label: string; given: boolean; value?: string; shut?: boolean }
export interface SeeView {
  agent: string; name: string; id: string; title: string;
  state: "given" | "not" | "paused"; closed: boolean;
  facts: SeeFact[]; given: number; of: number;
  text: "given" | "not" | "none";
  readers: { agent: string; name: string }[];
}

// The same rule the page uses (html-page.ts): a private value, or one still held for the owner's
// Show, shows only after a fresh sign-in.
const shut = (n: Note, r: FactRecord) => !!r.unseen || sensitivityRank(r.sensitivity ?? n.fm.sensitivity) >= sensitivityRank("private");
// A page's live records per fact, the ones Details lists: nothing disputed, nothing ended.
function liveFacts(n: Note): [string, FactRecord[]][] {
  return Object.entries(n.fm.facts ?? {}).flatMap(([attr, f]) => {
    const live = isDisputed(f) ? [] : (isList(f) ? f.items : [f as FactRecord]).filter((r) => !r.valid_to);
    return live.length ? [[attr, live] as [string, FactRecord[]]] : [];
  });
}
// Given means served as it is (marks.ts): the page and the attribute are in the carve, the fact is
// not hidden, and the view's scrub leaves its value untouched.
function holds(res: CarveResult, hidden: Set<string>, n: Note, attr: string): boolean {
  const v = res.visible.get(n.fm.id);
  if (!v || hidden.has(`${n.fm.id}#${attr}`)) return false;
  if (v.attributes !== "all" && !v.attributes.has(attr)) return false;
  const f = v.note.fm.facts?.[attr];
  const live = f ? records(f).filter((r) => !r.valid_to).map((r) => r.value) : [];
  return JSON.stringify(scrubLeaves(live, res)) === JSON.stringify(live);
}
interface Cut { name: string; paused: boolean; res: CarveResult; hidden: Set<string> }
// One carve for the reader named in the address. A name policy.yaml doesn't hold gets no screen,
// and neither does the hub's own reader inside the wall, which has no read door to be given
// anything through (G803). The cut is the assistant's own grant, its widest door: a reader token
// of the same assistant is capped lower at request time (src/tokenrole.ts), and an OpenFGA copy may
// narrow a cell further, so a door can serve less than this screen says, never more (G804).
function cutFor(s: State, agent: string): Cut | undefined {
  const a = Object.hasOwn(s.rules.policy.agents, agent) ? s.rules.policy.agents[agent] : undefined;
  if (!a || a.inside_wall) return undefined;
  const res = carve(s.notes, s.rules, grantFor(s.rules, agent), { flags: false });
  return { name: agentTitle(s.rules, agent), paused: a.status === "paused", res, hidden: new Set(res.hiddenFacts.map((h) => h.key)) };
}
const readers = (s: State, agent: string, name: string) => {
  const own = markAgents(s.rules);
  return own.some((r) => r.agent === agent) ? own : [...own, { agent, name }];
};

function viewOf(s: State, agent: string, cut: Cut, n: Note, fresh: boolean): SeeView {
  const titleOf = (id: string) => { const t = s.notes.find((m) => m.fm.id === id)?.fm.title; return t === undefined ? undefined : String(t); };
  const vis = cut.paused ? undefined : cut.res.visible.get(n.fm.id);
  const closed = !fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private");
  const facts = liveFacts(n).map(([attr, live]): SeeFact => {
    const given = !!vis && holds(cut.res, cut.hidden, n, attr);
    const label = cap(attrWords(attr));
    if (!given) return { attr, label, given };
    if (closed || (!fresh && live.some((r) => shut(n, r)))) return { attr, label, given, shut: true };
    return { attr, label, given, value: live.map((r) => sayYearly(attr, plain(r.value, titleOf))).join(", ") };
  });
  return {
    agent, name: cut.name, id: n.fm.id, title: displayName(n.fm.id, n.fm.title),
    state: cut.paused ? "paused" : vis ? "given" : "not", closed,
    facts, given: facts.filter((f) => f.given).length, of: facts.length,
    text: !n.body.trim() ? "none" : vis?.body ? "given" : "not",
    readers: readers(s, agent, cut.name),
  };
}
// The pages See as has a screen for: Memory's own list. No conflict packets, and a secret page only
// after a fresh sign-in, by a typed address as in the list.
const listed = (s: State, fresh: boolean) => browsable(s).filter((n) => fresh || n.fm.sensitivity !== "secret");
export function seeView(s: State, agent: string, n: Note, o: { fresh?: boolean } = {}): SeeView | undefined {
  const cut = cutFor(s, agent);
  return cut && listed(s, !!o.fresh).includes(n) ? viewOf(s, agent, cut, n, !!o.fresh) : undefined;
}

export interface SeeRow { id: string; title: string; state: "all" | "part" | "not"; given: number; of: number; text: SeeView["text"]; closed: boolean }
export interface SeeList { agent: string; name: string; paused: boolean; given: number; part: number; of: number; kinds: { label: string; pages: SeeRow[] }[] }
// Every page of Memory (the same list: no conflict packets, a secret page only after a fresh
// sign-in) with how much of it this assistant is given. Titles and counts only.
export function seeList(s: State, agent: string, o: { fresh?: boolean } = {}): SeeList | undefined {
  const cut = cutFor(s, agent);
  if (!cut) return undefined;
  const rows = listed(s, !!o.fresh).map((n): SeeRow & { folder: string } => {
    const v = viewOf(s, agent, cut, n, !!o.fresh);
    const state = v.state !== "given" ? "not" : v.given === v.of && v.text !== "not" ? "all" : "part";
    return { id: n.fm.id, title: v.title, state, given: v.given, of: v.of, text: v.text, closed: v.closed, folder: folderOf(n.fm.id) };
  });
  const folders = [...KINDS.map(([f]) => f), ...[...new Set(rows.map((r) => r.folder))].filter((f) => !KINDS.some(([k]) => k === f)).sort()];
  const label = (f: string) => KINDS.find(([k]) => k === f)?.[1] ?? cap(f);
  return {
    agent, name: cut.name, paused: cut.paused, of: rows.length,
    given: rows.filter((r) => r.state !== "not").length, part: rows.filter((r) => r.state === "part").length,
    kinds: folders.map((f) => ({ label: label(f), pages: rows.filter((r) => r.folder === f).sort((a, b) => a.title.localeCompare(b.title)).map(({ folder: _f, ...r }) => r) })).filter((k) => k.pages.length),
  };
}

const seeHref = (agent: string, id?: string) => `/see/${encodeURIComponent(agent)}${id ? `/${id.split("/").map(encodeURIComponent).join("/")}` : ""}`;
// One bar for anything not given: the same element whatever is behind it, so a picture of this
// screen says nothing about a value's length or kind.
const BAR = `<span class="bar" role="img" aria-label="${SEE_COPY.bar}"></span>`;
const SEE_CSS = `
.see-top h1{font-size:44px;line-height:.92;max-width:none}
.see-as{margin:18px 0 0;font-size:14px;line-height:20px;color:var(--muted)}
.readers{display:flex;gap:8px;margin:6px 0 0;overflow-x:auto;scrollbar-width:none}
.readers a{flex:1 0 auto;min-width:64px;min-height:44px;display:flex;align-items:center;justify-content:center;padding:0 12px;font-size:15px;font-weight:800;color:var(--text);box-shadow:inset 0 0 0 2px var(--text)}
.readers a[aria-current]{background:var(--headline-ink);color:var(--on-headline);box-shadow:none}
.see-count b{white-space:nowrap;font-size:44px}
.see-count span{max-width:none}
.bar{display:block;height:22px;width:100%;background:repeating-linear-gradient(135deg,var(--text) 0 3px,transparent 3px 8px);box-shadow:inset 0 0 0 2px var(--text)}
.facts{list-style:none;margin:16px 0 0;padding:0}
.facts li{border-top:2px solid var(--text);padding:10px 0 12px;display:flex;flex-direction:column;gap:4px}
.facts li:last-child{border-bottom:2px solid var(--text)}
.facts .lab{font-size:13px;line-height:18px;color:var(--muted)}
.facts .val{font-size:19px;line-height:25px;overflow-wrap:anywhere}
.facts .shut{font-size:15px;line-height:21px;color:var(--muted)}
.words{margin:6px 0 0}
.none{margin:18px 0 0;padding:22px 16px;border:2px solid var(--text);font-size:21px;line-height:27px;font-weight:800;background:repeating-linear-gradient(135deg,color-mix(in srgb,var(--text) 14%,transparent) 0 8px,transparent 8px 16px)}
.see-note{margin:22px 0 0;font-size:15px;line-height:21px;color:var(--muted)}
.see-note a{color:var(--text);font-weight:800;text-decoration:underline;text-decoration-color:var(--headline-ink);text-decoration-thickness:3px;text-underline-offset:5px}
.rows .given{flex:none;font-size:13px;line-height:18px;font-weight:500;color:var(--muted);text-align:right}
.rows .bar{flex:none;width:72px;height:16px}
h2.kind-head{margin:26px 0 6px}
`;

export function seePage(s: State, csrf: string, agent: string, n: Note, o: { fresh?: boolean } = {}): string | undefined {
  const v = seeView(s, agent, n, o);
  if (!v) return undefined;
  const name = esc(v.name);
  const row = `<nav class="readers" aria-label="${SEE_COPY.seeAs}"><a href="${href(v.id)}">${SEE_COPY.you}</a>${v.readers.map((r) => `<a href="${seeHref(r.agent, v.id)}"${r.agent === agent ? ' aria-current="true"' : ""}>${esc(r.name)}</a>`).join("")}</nav>`;
  const head = `<header class="top see-top"><p class="day"><a class="top-link" href="${seeHref(agent)}">‹ ${SEE_COPY.as} ${name}</a><a class="top-link" href="${href(v.id)}">${SEE_COPY.open}</a></p><h1>${esc(v.title)}</h1></header><p class="see-as">${SEE_COPY.seeAs}</p>${row}`;
  const note = `<p class="see-note">${esc(fill(SEE_COPY.what, { name: v.name }))} <a href="${href(v.id)}#who">${SEE_COPY.change}</a></p>`;
  let body: string;
  if (v.state !== "given") body = `<p class="none">${esc(fill(v.state === "paused" ? SEE_COPY.paused : SEE_COPY.notGiven, { name: v.name }))}</p>`;
  else {
    const count = v.closed ? "" : v.of ? `<p class="count see-count"><b>${v.given} of ${v.of}</b><span>${esc(fill(v.given === 1 ? SEE_COPY.countOne : SEE_COPY.countMany, { name: v.name }))}</span></p>` : `<p class="see-as">${SEE_COPY.noFacts}</p>`;
    const facts = v.closed ? `<p class="see-as">${esc(fill(SEE_COPY.shutPage, { name: v.name }))}</p>${signInAgain(csrf)}`
      : `${v.of ? `<ul class="facts">${v.facts.map((f) => `<li><span class="lab">${esc(f.label)}</span>${!f.given ? BAR : f.shut ? `<span class="shut">${SEE_COPY.shut}</span>` : `<span class="val">${esc(f.value)}</span>`}</li>`).join("")}</ul>` : ""}${v.facts.some((f) => f.shut) ? signInAgain(csrf) : ""}`;
    const words = v.text === "none" || v.closed ? "" : `<h2>${SEE_COPY.words}</h2><p class="words">${v.text === "given" ? esc(fill(SEE_COPY.wordsGiven, { name: v.name })) : BAR}</p>`;
    body = `${count}${facts}${words}`;
  }
  return appPage(`${v.title} · ${SEE_COPY.as} ${v.name}`, "who", `${head}${body}${note}`, { css: SEE_CSS });
}

// A given page's row in words: all of it, how many of its facts, its words and no fact, or its name.
export const rowWords = (r: SeeRow): string => r.state === "all" ? SEE_COPY.all : r.closed ? SEE_COPY.partOf
  : r.given ? fill(SEE_COPY.factsOf, { given: r.given, of: r.of }) : r.text === "given" ? SEE_COPY.wordsOnly : SEE_COPY.nameOnly;
export function seeListPage(s: State, agent: string, o: { fresh?: boolean } = {}): string | undefined {
  const l = seeList(s, agent, o);
  if (!l) return undefined;
  const name = esc(l.name);
  const how = (r: SeeRow) => r.state === "not" ? BAR
    : `<span class="given">${esc(rowWords(r))}</span>`;
  const count = l.paused ? `<p class="none">${esc(fill(SEE_COPY.paused, { name: l.name }))}</p>`
    : `<p class="count see-count"><b>${l.given} of ${l.of}</b><span>${esc(fill(l.given === 1 ? SEE_COPY.pagesOne : SEE_COPY.pagesMany, { name: l.name }))}${l.part ? `, ${esc(fill(SEE_COPY.part, { n: l.part }))}` : ""}.</span></p>`;
  const kinds = l.kinds.map((k) => `<h2 class="kind-head">${esc(k.label)}</h2><ul class="rows">${k.pages.map((r) => `<li class="changed"><a href="${seeHref(agent, r.id)}"><span class="page"><b>${esc(r.title)}</b></span>${how(r)}</a></li>`).join("")}</ul>`).join("");
  return appPage(`${SEE_COPY.as} ${l.name}`, "who", `<header class="top see-top"><p class="day"><a class="top-link" href="/who">‹ ${SEE_COPY.back}</a></p><h1>${SEE_COPY.as} ${name}</h1></header>${count}<p class="see-note">${esc(fill(SEE_COPY.what, { name: l.name }))}</p>${kinds}`, { css: SEE_CSS });
}
