// SPDX-License-Identifier: AGPL-3.0-only
// The share picture, /share (plans/as-read-by.md step 8; the owner's yes of 2026-11-18): one image
// the owner makes from their own memory and posts. "One memory. Three readers.": a square per page,
// the same squares once per assistant, each filled as that assistant's own carve gives the page
// (whole, in part, not given). Counts and rows come from See as (seeList), so the picture can't say
// more than the carve does.
// It is made to be public, so it is shapes and counts only. The model below has no field a page
// name, a value or a word of the memory could travel in; the one string it holds per reader is the
// assistant's name from the rules, and a name that names a person or the owner is drawn as
// "Assistant 1" (safeNames). A square's place comes from a hash of the page's address, so where a
// square sits says nothing about its title.
// The hub sends the picture nowhere: the page draws it in the owner's browser, and it leaves only
// when the owner shares or saves it. A view, never access: owner-only, nothing written, nothing
// logged as a read.
import type { State } from "./data";
import { seeList, type SeeRow } from "./see";
import { markAgents } from "./marks";
import { folderOf } from "./browse";
import { esc } from "./html-home";
import { appPage } from "./html-app";
import { ownerName } from "../rules";
import { sha256 } from "../util";
import { lastSliceProof, sliceProofLine } from "../slice-proof";
import { sayDay } from "../diary";
import { ownerDay } from "../clock";

export const SHARE_READERS = 6;   // rows the picture has room for
export const SHARE_SQUARES = 600; // squares a row has room for; past it a square is several pages

export const SHARE_COPY = {
  title: "The picture",
  back: "Who knows",
  intro: "What each of your assistants is given from your memory, as one picture. It shows shapes and counts only: no names, no words, nothing private.",
  share: "Share",
  save: "Save",
  hold: "Or touch and hold the picture to save it.",
  yours: "It goes nowhere until you share it.",
  needsTwo: "This picture needs two assistants. Connect a second one and it draws itself.",
  memory: "One memory.",
  readers: "{n} readers.",
  sub: "Each square is one page of one person's memory. Each assistant is given a different part. The owner sets the rules. The code makes the cut.",
  subMany: "Each square is {per} pages of one person's memory. Each assistant is given a different part. The owner sets the rules. The code makes the cut.",
  pages: "{given} of {of} pages",
  facts: "{given} of {of} facts",
  part: "{n} pages in part",
  partOne: "1 page in part",
  all: "Given",
  some: "Given in part",
  none: "Not given",
  more: "and {n} more assistants",
  moreOne: "and 1 more assistant",
  brand: "pocketBrain",
  line: "a memory you own, shared by your assistants",
  only: "Shapes and counts only. No names, no words.",
  tested: "Checked {day} on made-up memories: {line}.",
  assistant: "Assistant {n}",
  alt: "{name} is given {given} of {of} pages.",
};
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];

// 2 the whole page, 1 part of it, 0 not given.
export type Square = 0 | 1 | 2;
export interface ShareReader { name: string; pages: number; part: number; facts: number; squares: Square[] }
export interface SharePicture { pages: number; facts: number; per: number; more: number; readers: ShareReader[] }

// One square per page while they fit; past `max`, a square is `per` pages in a row: whole only
// when every one of them is given whole, empty only when none is given at all.
export function squares(states: Square[], max: number): { per: number; squares: Square[] } {
  const per = Math.max(1, Math.ceil(states.length / Math.max(1, max)));
  if (per === 1) return { per, squares: states };
  const out: Square[] = [];
  for (let i = 0; i < states.length; i += per) {
    const g = states.slice(i, i + per);
    out.push(g.every((c) => c === 2) ? 2 : g.every((c) => c === 0) ? 0 : 1);
  }
  return { per, squares: out };
}

const tokens = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const within = (hay: string[], needle: string[]) => needle.length > 0 && hay.some((_, i) => needle.every((w, j) => hay[i + j] === w));
// An assistant's name is the owner's own label, and the picture is public: one that holds a person
// page's title or other name, or a word of the owner's name, is drawn as "Assistant 1" instead.
function safeNames(s: State, names: string[]): string[] {
  const people = s.notes.filter((n) => folderOf(n.fm.id) === "people").flatMap((n) => [String(n.fm.title ?? ""), ...(n.fm.aliases ?? []).map(String)]).map(tokens);
  const owner = tokens(s.rules.policy.owner?.name ? ownerName(s.rules) : "").filter((w) => w.length >= 3).map((w) => [w]);
  let k = 0;
  return names.map((name) => {
    const t = tokens(name);
    return [...people, ...owner].some((p) => within(t, p)) || !t.length ? fill(SHARE_COPY.assistant, { n: ++k }) : name;
  });
}

// The picture's numbers: one seeList per assistant the owner runs (not paused), the same list See
// as shows. Fewer than two readers is no picture.
export function sharePicture(s: State): SharePicture | undefined {
  const lists = markAgents(s.rules).flatMap((a) => { const l = seeList(s, a.agent, { fresh: true }); return l && !l.paused ? [l] : []; });
  if (lists.length < 2) return undefined;
  const rowsOf = (l: (typeof lists)[number]) => l.kinds.flatMap((k) => k.pages);
  // One order for every row: by kind as Memory lists them, then by a hash of the page's address.
  const order = lists[0]!.kinds.flatMap((k) => k.pages.map((r) => ({ id: r.id, h: sha256(r.id) })).sort((a, b) => a.h.localeCompare(b.h))).map((r) => r.id);
  const state = (r: SeeRow | undefined): Square => !r || r.state === "not" ? 0 : r.state === "all" ? 2 : 1;
  let per = 1;
  const sorted = lists.map((l): ShareReader => {
    const rows = rowsOf(l), by = new Map(rows.map((r) => [r.id, r]));
    const cut = squares(order.map((id) => state(by.get(id))), SHARE_SQUARES);
    per = cut.per;
    return { name: l.name, pages: l.given, part: l.part, facts: rows.reduce((n, r) => n + r.given, 0), squares: cut.squares };
  }).sort((a, b) => b.pages - a.pages || b.facts - a.facts);
  // Named after the sort, so "Assistant 1" is the first one drawn.
  const names = safeNames(s, sorted.map((r) => r.name));
  const all = sorted.map((r, i) => ({ ...r, name: names[i]! }));
  return { pages: order.length, facts: rowsOf(lists[0]!).reduce((n, r) => n + r.of, 0), per, more: Math.max(0, all.length - SHARE_READERS), readers: all.slice(0, SHARE_READERS) };
}

// The nightly check's line, only when the last finished night found no leak and nothing missing.
function testedLine(s: State): string {
  const p = lastSliceProof(s.root);
  return p && !p.leaks && p.missing === 0 ? fill(SHARE_COPY.tested, { day: sayDay(ownerDay(s.rules, p.at)), line: sliceProofLine(p) }) : "";
}

const SHARE_CSS = `
.share-top h1{font-size:44px;line-height:.92;max-width:none}
.share-intro{margin:14px 0 0;font-size:16px;line-height:23px}
.shot{display:block;width:100%;height:auto;aspect-ratio:4/5;margin:18px 0 0;box-shadow:0 0 0 2px var(--text);background:var(--raised);-webkit-touch-callout:default}
.share-go{display:flex;gap:10px;margin:16px 0 0}
.share-go button{flex:1;font:inherit;font-size:17px;font-weight:800;min-height:48px;display:flex;align-items:center;justify-content:center;border:0;border-radius:0;cursor:pointer;text-decoration:none;background:var(--headline-ink);color:var(--on-headline)}
.share-go .plain{background:none;color:var(--text);box-shadow:inset 0 0 0 2px var(--text)}
.share-go [hidden]{display:none}
.share-note{margin:12px 0 0;font-size:14px;line-height:20px;color:var(--muted)}
.none{margin:18px 0 0;padding:22px 16px;border:2px solid var(--text);font-size:21px;line-height:27px;font-weight:800}
`;

// The drawing: a 1080 by 1350 canvas (4:5, the tallest a feed shows whole) in the page's own
// colours and face, from the numbers and the fixed words below. It reads nothing else and calls nothing.
const DRAW_JS = `<script>(async function(){
var P=JSON.parse(document.getElementById("pic").textContent),S=JSON.parse(document.getElementById("say").textContent);
var W=1080,H=1350,M=72,c=document.createElement("canvas");c.width=W;c.height=H;var x=c.getContext("2d");
var cs=getComputedStyle(document.documentElement),v=function(n){return cs.getPropertyValue(n).trim()};
var paper=v("--paper"),text=v("--text"),muted=v("--muted"),ink=v("--headline-ink");
var FACE='"Schibsted Grotesk",system-ui,sans-serif';
try{await Promise.all(["900 104px","800 34px","400 28px"].map(function(f){return document.fonts.load(f+" "+FACE)}))}catch(e){}
function F(w,s){x.font=w+" "+s+"px "+FACE}
function sp(n){if("letterSpacing" in x)x.letterSpacing=n+"px"}
function wrap(t,l,y,w,lh){var ws=t.split(" "),line="";for(var i=0;i<ws.length;i++){var tr=line?line+" "+ws[i]:ws[i];if(x.measureText(tr).width>w&&line){x.fillText(line,l,y);y+=lh;line=ws[i]}else line=tr}if(line){x.fillText(line,l,y);y+=lh}return y}
function sq(k,l,t,s){
 x.fillStyle=text;x.strokeStyle=text;
 if(k===2){x.fillRect(l,t,s,s);return}
 var b=s>=14?2:1;x.lineWidth=b;
 if(k===1){x.beginPath();x.moveTo(l,t);x.lineTo(l,t+s);x.lineTo(l+s,t+s);x.closePath();x.fill();x.strokeRect(l+b/2,t+b/2,s-b,s-b);return}
 x.save();x.globalAlpha=.55;x.strokeRect(l+b/2,t+b/2,s-b,s-b);
 if(s>=10){x.beginPath();x.rect(l,t,s,s);x.clip();x.lineWidth=s>=20?2:1;var st=s>=20?7:4;x.beginPath();for(var d=-s;d<s;d+=st){x.moveTo(l+d,t+s);x.lineTo(l+d+s,t)}x.stroke()}
 x.restore()}
x.fillStyle=paper;x.fillRect(0,0,W,H);x.textBaseline="alphabetic";
F(900,104);sp(-4);x.fillStyle=ink;x.fillText(S.h1,M-4,M+84);x.fillText(S.h2,M-4,M+84+96);sp(0);
F(400,26);x.fillStyle=text;var y=wrap(S.sub,M,M+84+96+62,W-2*M,37);
var top=y+2,foot=H-M-(S.tested?148:112),n=P.readers.length,bh=(foot-top)/n,gw=W-2*M;
var tight=n>3,hd=tight?64:106,N=P.readers[0].squares.length,gh=bh-hd-12,g=4,s=0,cols=0;
function fit(t,w){if(x.measureText(t).width<=w)return t;while(t.length>1&&x.measureText(t+"…").width>w)t=t.slice(0,-1);return t+"…"}
for(cols=Math.max(8,Math.ceil(gw/44));cols<=240;cols++){g=cols>60?2:cols>36?3:4;s=Math.min(40,Math.floor((gw+g)/cols)-g);if(s<2)break;if(Math.ceil(N/cols)*(s+g)-g<=gh)break}
if(s<2)s=2;
P.readers.forEach(function(r,i){
 var t=top+i*bh;x.fillStyle=text;x.fillRect(M,t,gw,3);
 var fs=tight?30:36,by=tight?44:52;F(800,fs);var pw=x.measureText(S.rows[i].pages).width;
 x.textAlign="right";x.fillText(S.rows[i].pages,W-M,t+by);
 if(tight){F(400,22);x.fillStyle=muted;var dw=x.measureText(S.rows[i].facts).width;x.fillText(S.rows[i].facts,W-M-pw-18,t+by);pw+=dw+18}
 else{F(400,24);x.fillStyle=muted;x.fillText(S.rows[i].detail,W-M,t+86)}
 x.textAlign="left";x.fillStyle=text;F(800,fs);x.fillText(fit(r.name,gw-pw-28),M,t+by);
 for(var k=0;k<r.squares.length;k++)sq(r.squares[k],M+(k%cols)*(s+g),t+hd+Math.floor(k/cols)*(s+g),s)});
var ly=foot+10;x.fillStyle=text;x.fillRect(M,ly-10,gw,3);
F(400,22);var lx=M;[[2,S.all],[1,S.some],[0,S.none]].forEach(function(e){sq(e[0],lx,ly+14,22);x.fillStyle=text;x.fillText(e[1],lx+32,ly+33);lx+=32+x.measureText(e[1]).width+30});
if(S.more){x.fillStyle=muted;x.textAlign="right";x.fillText(S.more,W-M,ly+33);x.textAlign="left"}
var fy=ly+84;F(800,26);x.fillStyle=ink;x.fillText(S.brand,M,fy);var bw=x.measureText(S.brand).width;F(400,26);x.fillStyle=text;x.fillText(" · "+S.line,M+bw,fy);
F(400,22);x.fillStyle=muted;x.fillText(S.only,M,fy+34);if(S.tested)x.fillText(S.tested,M,fy+66);
var url=c.toDataURL("image/png"),img=document.getElementById("shot");img.src=url;
var a=document.getElementById("save");a.hidden=false;a.onclick=function(){var l=document.createElement("a");l.href=url;l.download="pocketbrain-memory.png";document.body.appendChild(l);l.click();l.remove()};
var b=document.getElementById("send");
c.toBlob(function(blob){if(!blob||!window.File)return;var f=new File([blob],"pocketbrain-memory.png",{type:"image/png"});
 if(navigator.canShare&&navigator.canShare({files:[f]})){b.hidden=false;b.onclick=function(){navigator.share({files:[f]}).catch(function(){})}}},"image/png");
})();</script>`;

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function sharePage(s: State): string | undefined {
  const p = sharePicture(s);
  const head = `<header class="top share-top"><p class="day"><a class="top-link" href="/who">‹ ${SHARE_COPY.back}</a></p><h1>${SHARE_COPY.title}</h1></header>`;
  if (!p) return appPage(SHARE_COPY.title, "who", `${head}<p class="none">${SHARE_COPY.needsTwo}</p>`, { css: SHARE_CSS });
  const count = p.readers.length + p.more;
  const say = {
    h1: SHARE_COPY.memory, h2: fill(SHARE_COPY.readers, { n: WORDS[count] ?? count }),
    sub: p.per === 1 ? SHARE_COPY.sub : fill(SHARE_COPY.subMany, { per: p.per }),
    rows: p.readers.map((r) => ({
      pages: fill(SHARE_COPY.pages, { given: r.pages, of: p.pages }),
      facts: fill(SHARE_COPY.facts, { given: r.facts, of: p.facts }),
      detail: [fill(SHARE_COPY.facts, { given: r.facts, of: p.facts }), ...(r.part ? [r.part === 1 ? SHARE_COPY.partOne : fill(SHARE_COPY.part, { n: r.part })] : [])].join(" · "),
    })),
    all: SHARE_COPY.all, some: SHARE_COPY.some, none: SHARE_COPY.none,
    more: p.more ? (p.more === 1 ? SHARE_COPY.moreOne : fill(SHARE_COPY.more, { n: p.more })) : "",
    brand: SHARE_COPY.brand, line: SHARE_COPY.line, only: SHARE_COPY.only, tested: testedLine(s),
  };
  const alt = [say.h1, say.h2, ...p.readers.map((r) => fill(SHARE_COPY.alt, { name: r.name, given: r.pages, of: p.pages })), say.only].join(" ");
  const body = `${head}<p class="share-intro">${SHARE_COPY.intro}</p>
<img class="shot" id="shot" width="1080" height="1350" alt="${esc(alt)}">
<p class="share-go"><button type="button" id="send" hidden>${SHARE_COPY.share}</button><button type="button" id="save" class="plain" hidden>${SHARE_COPY.save}</button></p>
<p class="share-note">${SHARE_COPY.yours} ${SHARE_COPY.hold}</p>
<script type="application/json" id="pic">${json(p)}</script><script type="application/json" id="say">${json(say)}</script>${DRAW_JS}`;
  return appPage(SHARE_COPY.title, "who", body, { css: SHARE_CSS });
}
