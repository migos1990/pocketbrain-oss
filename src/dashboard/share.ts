// SPDX-License-Identifier: AGPL-3.0-only
// The share picture, /share (plans/as-read-by.md step 8; the owner's yes of 2026-11-18): one image
// the owner makes from their own memory and shows to someone who has never heard of any of this.
// It speaks in the owner's voice: what a page is, why each assistant gets a different part, one
// example from this memory's own counts, then the split as a table, a row per kind of page and a
// column per assistant, each cell that assistant's own carve of that kind (whole pages, pages in
// part, the rest). Counts come from See as (seeList), so the picture can't say more than the carve does.
// It is made to be public, so it is kinds and counts only. The model below has no field a page
// name, a value or a word of the memory could travel in: a kind is one of SHARE_KINDS (a folder the
// owner named is "other"), and the one free string per reader is the assistant's name from the
// rules. A name that names a person or the owner is drawn as "Assistant 1" (safeNames), and the
// owner can draw every one that way (names: false).
// The hub sends the picture nowhere: the page draws it in the owner's browser, and it leaves only
// when the owner shares or saves it. A view, never access: owner-only, nothing written, nothing
// logged as a read.
import type { State } from "./data";
import { seeList } from "./see";
import { markAgents } from "./marks";
import { folderOf } from "./browse";
import { esc } from "./html-home";
import { appPage } from "./html-app";
import { ownerName } from "../rules";
import { lastSliceProof } from "../slice-proof";
import { sayDay } from "../diary";
import { ownerDay } from "../clock";

export const SHARE_READERS = 6; // columns the picture has room for

// The kinds a row can be, in the order Memory lists them. Any other folder is the owner's own word
// and is counted under "other", never named.
export const SHARE_KINDS = ["people", "projects", "orgs", "money", "decisions", "notes", "agents", "other"] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
export const kindOf = (id: string): ShareKind => { const f = folderOf(id) as ShareKind; return f !== "other" && SHARE_KINDS.includes(f) ? f : "other"; };

export const SHARE_COPY = {
  title: "The picture",
  back: "Who knows",
  intro: "A picture of what each of your assistants gets from your memory, made to show someone else. It has counts only: no names of people or pages, and nothing from the pages.",
  share: "Share",
  save: "Save",
  hold: "Or touch and hold the picture to save it.",
  yours: "It goes nowhere until you share it.",
  namesNote: "The picture shows each assistant by the name you gave it.",
  namesOff: "Hide their names",
  namesOn: "Show their names",
  needsTwo: "This picture needs two assistants. Connect a second one and it draws itself.",
  h: "Each of my AI assistants gets a different part of my life.",
  hSame: "All of my AI assistants get the same pages about my life.",
  sub: "I keep one set of pages about my life, with a page for each {things}. I pick which pages each assistant gets, because I don't want every AI to know everything about me.",
  subSame: "I keep one set of pages about my life, with a page for each {things}. I pick which pages each assistant gets, and right now they all get the same ones.",
  anything: "thing I want remembered",
  mine: "My pages",
  total: "{n} in all",
  totalOne: "1 in all",
  given: "{given} of {of}",
  all: "all",
  none: "none",
  whole: "gets the whole page",
  some: "gets part of it",
  not: "doesn't get it",
  more: "and {n} more assistants",
  moreOne: "and 1 more assistant",
  brand: "Made with pocketBrain",
  only: "This picture shows counts only, with no names and nothing from the pages.",
  tested: "The code that makes the split passed its nightly check on {day}.",
  assistant: "Assistant {n}",
  alt: "{name} gets {given} of {of} pages.",
};
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

// A kind in the owner's voice: its row's label, one of it ("a page for each person"), and how a
// sentence names its pages ("my pages about money").
const KIND_WORDS: Record<ShareKind, { label: string; one?: string; about?: string }> = {
  people: { label: "People", one: "person", about: "about people" },
  projects: { label: "Projects", one: "project", about: "about projects" },
  orgs: { label: "Companies", one: "company", about: "about companies" },
  money: { label: "Money", one: "account", about: "about money" },
  decisions: { label: "Decisions", one: "decision", about: "about decisions" },
  notes: { label: "Notes", about: "of notes" },
  agents: { label: "Routines", about: "about routines" },
  other: { label: "Other" },
};

// A cell is what one assistant gets of one kind: [pages given whole, pages given in part].
export type ShareCell = [number, number];
export interface ShareReader { name: string; pages: number; cells: ShareCell[] }
export interface SharePicture { pages: number; more: number; differ: boolean; kinds: { kind: ShareKind; pages: number }[]; readers: ShareReader[] }

const tokens = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const within = (hay: string[], needle: string[]) => needle.length > 0 && hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));
// An assistant's name is the owner's own label, and the picture is public: one that holds a person
// page's title or other name, or a word of the owner's name, is drawn as "Assistant 1" instead.
// With `shown` false every name is.
function safeNames(s: State, names: string[], shown: boolean): string[] {
  const people = s.notes.filter((n) => folderOf(n.fm.id) === "people").flatMap((n) => [String(n.fm.title ?? ""), ...(n.fm.aliases ?? []).map(String)]).map(tokens);
  const owner = tokens(s.rules.policy.owner?.name ? ownerName(s.rules) : "").filter((w) => w.length >= 3).map((w) => [w]);
  let k = 0;
  return names.map((name) => {
    const t = tokens(name);
    return !shown || [...people, ...owner].some((p) => within(t, p)) || !t.length ? fill(SHARE_COPY.assistant, { n: ++k }) : name;
  });
}

// The picture's numbers: one seeList per assistant the owner runs (not paused), the same list See
// as shows, counted by kind of page. Fewer than two assistants is no picture.
export function sharePicture(s: State, opts: { names?: boolean } = {}): SharePicture | undefined {
  const lists = markAgents(s.rules).flatMap((a) => { const l = seeList(s, a.agent, { fresh: true }); return l && !l.paused ? [l] : []; });
  if (lists.length < 2) return undefined;
  const rowsOf = (l: (typeof lists)[number]) => l.kinds.flatMap((k) => k.pages);
  const all = rowsOf(lists[0]!);
  const kinds = SHARE_KINDS.map((kind) => ({ kind, pages: all.filter((r) => kindOf(r.id) === kind).length })).filter((k) => k.pages);
  const sorted = lists.map((l) => {
    const rows = rowsOf(l);
    const cells = kinds.map((k): ShareCell => { const mine = rows.filter((r) => kindOf(r.id) === k.kind); return [mine.filter((r) => r.state === "all").length, mine.filter((r) => r.state === "part").length]; });
    return { name: l.name, pages: l.given, cells };
  }).sort((a, b) => b.pages - a.pages || b.cells.reduce((n, c) => n + c[0], 0) - a.cells.reduce((n, c) => n + c[0], 0));
  // Named after the sort, so "Assistant 1" is the first one drawn.
  const names = safeNames(s, sorted.map((r) => r.name), opts.names !== false);
  const readers = sorted.map((r, i) => ({ ...r, name: names[i]! }));
  const differ = readers.some((r) => JSON.stringify(r.cells) !== JSON.stringify(readers[0]!.cells));
  return { pages: all.length, more: Math.max(0, readers.length - SHARE_READERS), differ, kinds, readers: readers.slice(0, SHARE_READERS) };
}

// One example of the split, from the counts: the assistant that gets the most of one kind beside
// the one that gets the least. Money first when someone gets none of it, else the widest gap.
// Nothing when no kind differs.
export function exampleLine(p: SharePicture): string {
  const got = (c: ShareCell) => c[0] + c[1];
  const found = p.kinds.flatMap((k, j) => {
    const about = KIND_WORDS[k.kind].about;
    if (!about) return [];
    const hi = p.readers.reduce((m, r) => got(r.cells[j]!) > got(m.cells[j]!) ? r : m), lo = p.readers.reduce((m, r) => got(r.cells[j]!) < got(m.cells[j]!) ? r : m);
    const a = got(hi.cells[j]!), b = got(lo.cells[j]!);
    return a > b ? [{ k, about, hi, lo, a, b, gap: (a - b) / k.pages + (k.kind === "money" && b === 0 ? 2 : 0) }] : [];
  }).sort((x, y) => y.gap - x.gap)[0];
  if (!found) return "";
  const { k, about, hi, lo, a, b } = found, n = k.pages;
  const most = n === 1 ? `my one page ${about}` : a < n ? `${a} of my ${n} pages ${about}` : n === 2 ? `both of my pages ${about}` : `all ${n} of my pages ${about}`;
  const least = b ? `gets only ${b}` : n === 1 ? "doesn't get it" : "gets none of them";
  return `${hi.name} gets ${most}, and ${lo.name} ${least}.`;
}

// The nightly check's line, only when the last finished night found no leak and nothing missing.
function testedLine(s: State): string {
  const p = lastSliceProof(s.root);
  return p && !p.leaks && p.missing === 0 ? fill(SHARE_COPY.tested, { day: sayDay(ownerDay(s.rules, p.at)) }) : "";
}

// Every word on the picture. What a page is comes from the kinds this memory has.
export function shareWords(s: State, p: SharePicture) {
  const ones = p.kinds.flatMap((k) => KIND_WORDS[k.kind].one ?? []).slice(0, 3);
  const things = ones.length < 2 ? SHARE_COPY.anything : `${ones.slice(0, -1).join(", ")} and ${ones.at(-1)}`;
  const cell = (c: ShareCell, of: number) => { const n = c[0] + c[1]; return !n ? SHARE_COPY.none : n === of ? SHARE_COPY.all : fill(SHARE_COPY.given, { given: n, of }); };
  return {
    h: p.differ ? SHARE_COPY.h : SHARE_COPY.hSame,
    sub: fill(p.differ ? SHARE_COPY.sub : SHARE_COPY.subSame, { things }),
    example: exampleLine(p),
    mine: SHARE_COPY.mine, total: p.pages === 1 ? SHARE_COPY.totalOne : fill(SHARE_COPY.total, { n: p.pages }),
    kinds: p.kinds.map((k) => KIND_WORDS[k.kind].label),
    cols: p.readers.map((r) => fill(SHARE_COPY.given, { given: r.pages, of: p.pages })),
    cells: p.readers.map((r) => r.cells.map((c, j) => cell(c, p.kinds[j]!.pages))),
    whole: SHARE_COPY.whole, some: SHARE_COPY.some, not: SHARE_COPY.not,
    more: p.more ? (p.more === 1 ? SHARE_COPY.moreOne : fill(SHARE_COPY.more, { n: p.more })) : "",
    brand: SHARE_COPY.brand, only: SHARE_COPY.only, tested: testedLine(s),
  };
}

const SHARE_CSS = `
.share-top h1{font-size:44px;line-height:.92;max-width:none}
.share-intro{margin:14px 0 0;font-size:17px;line-height:23px}
.shot{display:block;width:100%;height:auto;aspect-ratio:4/5;margin:18px 0 0;box-shadow:0 0 0 2px var(--text);background:var(--raised);-webkit-touch-callout:default}
.share-go{display:flex;gap:10px;margin:16px 0 0}
.share-go button{flex:1;font:inherit;font-size:17px;font-weight:800;min-height:48px;display:flex;align-items:center;justify-content:center;border:0;border-radius:0;cursor:pointer;text-decoration:none;background:var(--headline-ink);color:var(--on-headline)}
.share-go .plain{background:none;color:var(--text);box-shadow:inset 0 0 0 2px var(--text)}
.share-go [hidden]{display:none}
.share-note{margin:12px 0 0;font-size:15px;line-height:20px;color:var(--muted)}
.share-note a{color:var(--text);font-weight:800;display:inline-block;padding:12px 0}
.none{margin:18px 0 0;padding:22px 16px;border:2px solid var(--text);font-size:22px;line-height:27px;font-weight:800}
`;

// The drawing: a 1080 by 1350 canvas (4:5, the tallest a feed shows whole) in the page's own
// colours and face, from the numbers and the words above. It reads nothing else and calls nothing.
const DRAW_JS = `<script>(async function(){
var P=JSON.parse(document.getElementById("pic").textContent),S=JSON.parse(document.getElementById("say").textContent);
var W=1080,H=1350,M=64,c=document.createElement("canvas");c.width=W;c.height=H;var x=c.getContext("2d");
var cs=getComputedStyle(document.documentElement),v=function(n){return cs.getPropertyValue(n).trim()};
var paper=v("--paper"),text=v("--text"),muted=v("--muted"),ink=v("--headline-ink");
var FACE='"Schibsted Grotesk",system-ui,sans-serif';
try{await Promise.all(["900 68px","800 30px","400 30px"].map(function(f){return document.fonts.load(f+" "+FACE)}))}catch(e){}
function F(w,s){x.font=w+" "+s+"px "+FACE}
function sp(n){if("letterSpacing" in x)x.letterSpacing=n+"px"}
function wrap(t,l,y,w,lh){var ws=t.split(" "),line="";for(var i=0;i<ws.length;i++){var tr=line?line+" "+ws[i]:ws[i];if(x.measureText(tr).width>w&&line){x.fillText(line,l,y);y+=lh;line=ws[i]}else line=tr}if(line){x.fillText(line,l,y);y+=lh}return y}
function fit(t,w){if(x.measureText(t).width<=w)return t;while(t.length>1&&x.measureText(t+"…").width>w)t=t.slice(0,-1);return t+"…"}
function bar(l,t,w,h,a,b,of){
 var wa=of?Math.round(w*a/of):0,wb=of?Math.round(w*b/of):0;if(a&&wa<4)wa=4;if(b&&wb<4)wb=4;if(a+b>=of)wb=w-wa;else if(wa+wb>w-4)wb=Math.max(0,w-4-wa);
 x.save();x.strokeStyle=text;x.fillStyle=text;x.lineWidth=2;x.globalAlpha=.5;x.strokeRect(l+1,t+1,w-2,h-2);x.globalAlpha=1;
 if(wa)x.fillRect(l,t,wa,h);
 if(wb){x.strokeRect(l+wa+1,t+1,wb-2,h-2);x.beginPath();x.rect(l+wa,t,wb,h);x.clip();x.beginPath();for(var d=-h;d<wb;d+=7){x.moveTo(l+wa+d,t+h);x.lineTo(l+wa+d+h,t)}x.stroke()}
 x.restore()}
x.fillStyle=paper;x.fillRect(0,0,W,H);x.textBaseline="alphabetic";
var gw=W-2*M,n=P.readers.length,nk=P.kinds.length;
F(900,68);sp(-2);x.fillStyle=ink;var y=wrap(S.h,M-2,M+58,gw,72);sp(0);
F(400,30);x.fillStyle=text;y=wrap(S.sub,M,y-18,gw,42);
if(S.example){F(800,30);y=wrap(S.example,M,y+12,gw,42)}
var top=y-10,foot=H-M-(S.tested?154:120),hh=96,rh=Math.min(124,Math.floor((foot-top-hh)/nk));
var lw=n>=5?250:n===4?290:330,cw=(gw-lw)/n,fs=n>=5?22:n===4?26:30,bh=rh>=70?16:12;
x.fillStyle=text;x.fillRect(M,top,gw,3);
F(800,fs+2);x.fillText(S.mine,M,top+44);F(400,22);x.fillStyle=muted;x.fillText(S.total,M,top+76);
P.readers.forEach(function(r,i){var l=M+lw+i*cw;var ns=fs+2;F(800,ns);while(ns>17&&x.measureText(r.name).width>cw-14){ns--;F(800,ns)}x.fillStyle=text;x.fillText(fit(r.name,cw-14),l,top+44);F(400,n>=5?19:22);x.fillStyle=muted;x.fillText(fit(S.cols[i],cw-10),l,top+76)});
P.kinds.forEach(function(k,j){
 var t=top+hh+j*rh,mid=t+rh/2;x.save();x.globalAlpha=.3;x.fillStyle=text;x.fillRect(M,t,gw,2);x.restore();
 F(800,30);x.fillStyle=text;x.fillText(S.kinds[j],M,mid+11);var kw=x.measureText(S.kinds[j]).width;F(400,24);x.fillStyle=muted;x.fillText(String(k.pages),M+kw+12,mid+11);
 P.readers.forEach(function(r,i){var l=M+lw+i*cw,cl=r.cells[j],w=S.cells[i][j];
  F(w===S.none?400:800,fs);x.fillStyle=w===S.none?muted:text;x.fillText(w,l,mid+2);bar(l,mid+12,cw-18,bh,cl[0],cl[1],k.pages)})});
var ly=top+hh+nk*rh;x.fillStyle=text;x.fillRect(M,ly,gw,3);
F(400,22);var lx=M;[[1,0,S.whole],[0,1,S.some],[0,0,S.not]].forEach(function(e){bar(lx,ly+24,44,14,e[0],e[1],1);x.fillStyle=text;x.fillText(e[2],lx+56,ly+38);lx+=56+x.measureText(e[2]).width+34});
if(S.more){x.fillStyle=muted;x.fillText(S.more,M,ly+74)}
var fy=H-M-(S.tested?66:32);F(800,26);x.fillStyle=ink;x.fillText(S.brand,M,fy);
F(400,22);x.fillStyle=muted;x.fillText(S.only,M,fy+32);if(S.tested)x.fillText(S.tested,M,fy+64);
var url=c.toDataURL("image/png"),img=document.getElementById("shot");img.src=url;
var a=document.getElementById("save");a.hidden=false;a.onclick=function(){var l=document.createElement("a");l.href=url;l.download="pocketbrain-memory.png";document.body.appendChild(l);l.click();l.remove()};
var b=document.getElementById("send");
c.toBlob(function(blob){if(!blob||!window.File)return;var f=new File([blob],"pocketbrain-memory.png",{type:"image/png"});
 if(navigator.canShare&&navigator.canShare({files:[f]})){b.hidden=false;b.onclick=function(){navigator.share({files:[f]}).catch(function(){})}}},"image/png");
})();</script>`;

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function sharePage(s: State, opts: { names?: boolean } = {}): string | undefined {
  const shown = opts.names !== false, p = sharePicture(s, { names: shown });
  const head = `<header class="top share-top"><p class="day"><a class="top-link" href="/who">‹ ${SHARE_COPY.back}</a></p><h1>${SHARE_COPY.title}</h1></header>`;
  if (!p) return appPage(SHARE_COPY.title, "who", `${head}<p class="none">${SHARE_COPY.needsTwo}</p>`, { css: SHARE_CSS });
  const say = shareWords(s, p);
  const alt = [say.h, ...p.readers.map((r) => fill(SHARE_COPY.alt, { name: r.name, given: r.pages, of: p.pages })), say.only].join(" ");
  const names = shown ? `${esc(SHARE_COPY.namesNote)} <a href="/share?names=off">${esc(SHARE_COPY.namesOff)}</a>` : `<a href="/share">${esc(SHARE_COPY.namesOn)}</a>`;
  const body = `${head}<p class="share-intro">${SHARE_COPY.intro}</p>
<img class="shot" id="shot" width="1080" height="1350" alt="${esc(alt)}">
<p class="share-go"><button type="button" id="send" hidden>${SHARE_COPY.share}</button><button type="button" id="save" class="plain" hidden>${SHARE_COPY.save}</button></p>
<p class="share-note">${SHARE_COPY.yours} ${SHARE_COPY.hold}</p>
<p class="share-note">${names}</p>
<script type="application/json" id="pic">${json(p)}</script><script type="application/json" id="say">${json(say)}</script>${DRAW_JS}`;
  return appPage(SHARE_COPY.title, "who", body, { css: SHARE_CSS });
}
