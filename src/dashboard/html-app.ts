// SPDX-License-Identifier: AGPL-3.0-only
// The owner app (brief 2026-10-30, docs/owner-home.md): four tabs and nothing else. On your mind
// (/home) is the box and the memories, each with its marks (marks.ts); Memory (/memory) is the
// wiki's kinds, search and this week's pages; Ask (/ask) is the box on its own; Who knows (/who) is
// the assistants' rows and Settings. Each is a page over functions that already exist; no script, no
// model decides anything here. Fixed words are in APP_COPY, held to the owner's words by
// test/owner-copy.test.ts.
import type { HomeView, HomeLine, Waiting, ChangedPage } from "./home";
import type { Mark } from "./marks";
import type { WrongLine } from "./home-beliefs";
import type { SayReply } from "../owner-say";
import { esc, hidden, href, replyHtml, signInAgain, HOME_COPY } from "./html-home";

export const APP_COPY = {
  tabs: "Tabs",
  tabMind: "On your mind",
  tabMemory: "Memory",
  tabAsk: "Ask",
  tabWho: "Who knows",
  mind: "On your mind",
  box: "What's on your mind?",
  boxLabel: "Tell your memory something",
  ask: "Ask",
  askBox: "Ask your memory anything…",
  askOlder: "Earlier answers here show again right after you sign in.",
  open: "Open {title}",
  askHint: "Ask about anyone or anything in your memory, or tell it what changed. It answers here.",
  me: "You and your assistants",
  more: "{n} more on your mind",
  quiet: "Nothing new on your mind since yesterday.",
  onlyYou: "Only you know this",
  stranger: "From an address your pages don't hold",
  readIt: "Read it",
  seeThem: "See them",
  settle: "Settle",
  decide: "Decide",
  gardener: "The Gardener looks at this tonight",
  knownBy: "Known by {names}",
  notBy: "{names} doesn't get it",
  notByMany: "{names} don't get it",
  nobody: "None of your assistants get it",
  justSaid: "You said so just now",
  letMark: "Let {name} know this?",
  letTitle: "Let {name} know this?",
  letWhyArea: "{name} doesn't get your {area} pages.",
  letWhy: "{name} doesn't get this page.",
  justOne: "Just this one",
  justOneWhy: "{name} reads this page once, the next time it checks in. What it sees stays the same.",
  onItsWay: "{name} reads this page once at its next check-in.",
  letArea: "Everything in {area}",
  letAreaWhy: "{name} gets every {area} page from now on: {n} pages. You change it in Settings.",
  keepFrom: "Keep it from {name}",
  keepFromWhy: "{name} won't get this page, even if you share {area} later.",
  notNow: "Not now",
  letFoot: "Only you can widen what an assistant sees. A page's Who sees this takes it back.",
  memory: "Memory",
  search: "Search your memory",
  searchGo: "Search",
  found: "Found for “{q}”",
  nothingFound: "Nothing in your memory matches “{q}”.",
  allKinds: "All kinds",
  nothingWeek: "Nothing changed this week.",
  searchHint: "Search people, projects, decisions…",
  holds: "{pages} pages · {people} people",
  changedPages: "Pages that changed",
  thisWeek: "this week",
  allChanges: "All changes",
  somethingNew: "something new",
  who: "Who knows",
  assistants: "Your assistants",
  settings: "Settings",
  yourMemory: "Your memory",
  backupNone: "Not backed up yet",
  readTimes: "Read your brain {n} times today",
  readOnce: "Read your brain once today",
  readNot: "Hasn't read your brain today",
  seesAll: "Sees all your pages",
  seesSome: "Sees {sees} pages",
  seeAs: "See as",
  trial: "trial",
  trialWhy: "what it writes waits for you",
  asked: "What it asked today ({n})",
  settingsWhy: "Everything else: sign-ins, sources, spending, history",
} as const;

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const and = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// The look (brief 2026-10-30): white ground, one accent, soft rounded blocks, a four-item tab bar.
// The typeface is named, never fetched: the hub serves no outside files (its CSP is default-src
// 'none'), so a phone without Plus Jakarta Sans gets its own sans.
const LIGHT = "--t-work:#e0e3ff;--t-work-text:#2e2a9e;--t-teaching:#ffe8c2;--t-teaching-text:#6b3f00;--t-personal:#d5f2ec;--t-personal-text:#0b5b52;--bg:#ffffff;--soft:#f6f6f9;--line:#ececf1;--text:#111318;--text-2:#4f5361;--muted:#5f6370;--accent:#4338ca;--accent-text:#4338ca;--on-accent:#ffffff;--ink:#111318;--on-ink:#ffffff;--warn:#7a3e00;--warn-bg:#fff4e6;--dash:#9ea2ae;";
const DARK = "--t-work:#26264d;--t-work-text:#c7cbff;--t-teaching:#3a2a10;--t-teaching-text:#f5c77e;--t-personal:#0f2f2a;--t-personal-text:#8fe0cf;--bg:#15161a;--soft:#202128;--line:#2c2e36;--text:#ecedf1;--text-2:#b9bcc8;--muted:#a3a7b3;--accent:#a5b4fc;--accent-text:#a5b4fc;--on-accent:#15161a;--ink:#ecedf1;--on-ink:#15161a;--warn:#f5c77e;--warn-bg:#33270f;--dash:#6b6f7b;";
const FONT = '"Plus Jakarta Sans",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,sans-serif';
export const APP_CSS = `
:root{color-scheme:light;${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${DARK}}}
:root[data-theme="dark"]{color-scheme:dark;${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:500 15px/22px ${FONT};-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:var(--accent-text);text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.wrap{max-width:640px;margin:0 auto;padding:calc(20px + env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) calc(112px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.top{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin:0 0 14px}
.top .day{margin:0;font-size:13px;line-height:18px;font-weight:600;color:var(--muted)}
h1{margin:0;font-size:30px;line-height:36px;font-weight:800;letter-spacing:-.02em}
h2{font-size:13px;line-height:20px;font-weight:700;color:var(--muted);margin:22px 0 8px}
.me{width:44px;height:44px;border-radius:50%;background:var(--ink);color:var(--on-ink);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex:none}
form.box{display:flex;align-items:center;gap:8px;min-height:52px;padding:0 4px 0 18px;background:var(--soft);border-radius:999px;margin:0 0 16px}
form.box input[type=text]{flex:1;min-width:0;border:0;background:transparent;font:inherit;font-size:16px;color:var(--text);padding:12px 0}
form.box input[type=text]::placeholder{color:var(--muted)}
form.box button{font:inherit;font-weight:700;border:0;border-radius:999px;padding:0 16px;min-height:44px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.bubble{background:var(--soft);border-radius:20px 20px 20px 6px;padding:11px 15px;margin:0 0 10px;max-width:94%}
.you{background:var(--accent);color:var(--on-accent);border-radius:20px 20px 6px 20px;margin-left:auto;max-width:86%}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.talk{list-style:none;margin:0;padding:0}.answer p{margin:0}.answer .cites{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}.answer .cites a{font-size:13px;line-height:18px;font-weight:700;background:var(--bg);color:var(--text);border-radius:999px;padding:5px 11px}.talk .bubble{width:fit-content}.chips form{margin:0}
.chips .open{display:inline-flex;align-items:center;min-height:44px;padding:0 14px;border-radius:999px;background:var(--soft);color:var(--text);font-weight:700}
.chips button{font:inherit;font-weight:700;color:var(--accent-text);background:none;border:1.5px solid var(--accent);border-radius:999px;padding:0 14px;min-height:44px;cursor:pointer}
ul{list-style:none;margin:0;padding:0}
.mind{display:flex;flex-direction:column;gap:10px}
.card{background:var(--soft);border-radius:18px;padding:14px 16px;display:flex;flex-direction:column;gap:8px}
.card.warn{background:var(--warn-bg)}
.card .what{font-size:16px;line-height:23px;font-weight:600;color:var(--text);overflow-wrap:anywhere}
.foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.foot small{font-size:13px;line-height:18px;color:var(--muted);flex:1;min-width:0}
.foot .acts{display:flex;align-items:center;gap:8px;margin-left:auto}
.foot form{margin:0}
.foot>.pill,.foot>form{margin-left:auto}
.warn .note{font-size:13px;line-height:18px;font-weight:700;color:var(--warn);display:inline-flex;align-items:center;gap:6px}
.pill{font:inherit;font-size:13px;line-height:18px;font-weight:700;border-radius:999px;padding:0 14px;min-height:44px;display:inline-flex;align-items:center;cursor:pointer;color:var(--accent-text);background:none;border:1.5px solid var(--accent)}
.pill.solid{color:var(--on-ink);background:var(--ink);border-color:var(--ink)}
.marks{display:inline-flex;align-items:center;gap:4px}
.mark{min-width:24px;height:24px;padding:0 4px;border-radius:7px;background:var(--ink);color:var(--on-ink);font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center}
.mark.not{background:var(--bg);border:1.5px dashed var(--dash);color:var(--muted)}
a.mark.not{position:relative;border-color:var(--accent);color:var(--accent-text)}
a.mark.not::after{content:"";position:absolute;inset:-10px}
.card.told{background:var(--bg);border:2px solid var(--accent)}
.sheet{display:flex;flex-direction:column;gap:16px}
.sheet .head{display:flex;gap:14px;align-items:center}
.sheet .big{flex:none;width:48px;height:48px;border-radius:14px;background:var(--accent);color:var(--on-accent);font-size:17px;font-weight:800;display:flex;align-items:center;justify-content:center}
.sheet h1{font-size:24px;line-height:30px}
.sheet .sub{margin:2px 0 0;font-size:14px;line-height:20px;color:var(--muted)}
.sheet .said{background:var(--soft);border-radius:16px;padding:12px 14px;font-weight:600}
.choice{display:flex;flex-direction:column;gap:2px;background:var(--soft);border-radius:16px;padding:14px 16px;min-height:56px;color:var(--text);font:inherit;text-align:left;border:0;width:100%;cursor:pointer}
.choice.done{cursor:default;margin:0}.choice b{font-weight:700}.choice small{font-size:13px;line-height:18px;color:var(--muted)}
.sheet form{margin:0}
.plain{display:flex;justify-content:center;align-items:center;min-height:48px;color:var(--muted);font-weight:600}
.foot-note{font-size:12px;line-height:16px;color:var(--muted);text-align:center;margin:0}
.state{font-size:13px;color:var(--muted)}
.more{display:flex;justify-content:center;align-items:center;min-height:44px;margin:6px 0 0;font-size:14px;font-weight:700}
.quiet{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.tile{background:var(--soft);border-radius:18px;padding:14px 16px;min-height:96px;display:flex;flex-direction:column;justify-content:space-between;gap:12px;color:var(--text)}
.tile b{display:block;font-size:22px;line-height:26px;font-weight:800}.tile span{font-size:13px;line-height:18px;font-weight:600}
.tile.t-work{background:var(--t-work);color:var(--t-work-text)}.tile.t-teaching{background:var(--t-teaching);color:var(--t-teaching-text)}.tile.t-personal{background:var(--t-personal);color:var(--t-personal-text)}
.tile.rest{justify-content:flex-start;gap:0;padding:6px 16px}.tile.rest a{display:flex;justify-content:space-between;align-items:center;min-height:44px;color:var(--text);font-weight:600}.tile.rest a b{font-size:17px;line-height:22px}
.week-head{display:flex;justify-content:space-between;align-items:baseline}.week-head span{font-size:13px;font-weight:600;color:var(--muted)}
.rows li.changed a{gap:12px;font-weight:400}.rows .dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--dash)}
.dot.a-work{background:var(--accent)}.dot.a-teaching{background:var(--t-teaching-text)}.dot.a-personal{background:var(--t-personal-text)}
.rows .page{flex:1;min-width:0;display:flex;flex-direction:column}.rows .page b{font-weight:700}.rows .page small{font-size:13px;line-height:18px;color:var(--muted)}.rows .when{flex:none;font-size:12px;font-weight:600;color:var(--muted)}
.rows a{display:flex;align-items:center;min-height:44px;padding:10px 0;border-bottom:1px solid var(--line);color:var(--text);font-weight:600}
.rows li:last-child a{border-bottom:0}
.line{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);min-height:44px}
.line .t{min-width:0;flex:1;overflow-wrap:anywhere}
.line .t a{color:var(--text)}
.line small{display:block;color:var(--text-2);font-size:13px;line-height:18px}
.line button{font:inherit;font-size:13px;font-weight:700;color:var(--accent-text);background:none;border:1.5px solid var(--accent);border-radius:999px;padding:0 14px;min-height:44px;cursor:pointer}
.line.ask,.line.wrong{padding-left:12px}.line.ask{min-height:0;padding-top:6px;padding-bottom:6px}.line.who b{font-weight:700}
.reads{color:var(--text-2);font-size:13px;margin:0}
.who-block{background:var(--soft);border-radius:18px;padding:4px 16px;margin:0 0 10px}
.who-block .line:last-child{border-bottom:0}
.top-link{font-weight:700;min-height:44px;display:inline-flex;align-items:center}
.numbers{background:var(--ink);color:var(--on-ink);border-radius:20px;padding:16px 18px;margin:0 0 6px}
.numbers h2{margin:0 0 10px;color:inherit;opacity:.75}.numbers .nums{display:flex;gap:22px}.numbers .nums p{margin:0;display:flex;flex-direction:column}
.numbers b{font-size:26px;line-height:30px;font-weight:800}.numbers span{font-size:12px;line-height:16px;opacity:.8}.numbers .backup{margin:12px 0 0;font-size:13px;font-weight:600;opacity:.8}
.agents{display:flex;flex-direction:column;gap:10px}.agent{background:var(--soft);border-radius:20px;padding:14px 16px}
.who-head{display:flex;align-items:center;gap:12px}.who-head .t{flex:1;min-width:0}.who-head b{font-weight:700}.who-head small{display:block;font-size:13px;line-height:18px;color:var(--muted)}
.av{flex:none;width:36px;height:36px;border-radius:10px;background:var(--ink);color:var(--on-ink);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800}
.badge{margin-left:6px;font-size:11px;font-weight:700;color:var(--warn);background:var(--warn-bg);border-radius:6px;padding:2px 6px}
.see{font-weight:700;min-height:44px;display:inline-flex;align-items:center}.sees{margin:8px 0 0;font-size:13px;line-height:18px;color:var(--text-2)}
.wrongs{margin:8px 0 0;background:var(--bg);border-radius:14px;padding:0 12px}.wrongs .line:last-child{border-bottom:0}
.agent details{margin:8px 0 0}.agent summary{min-height:44px;display:flex;align-items:center;font-size:13px;font-weight:700;color:var(--accent-text);cursor:pointer}
.settings{display:flex;flex-direction:column;justify-content:center;min-height:56px;background:var(--soft);border-radius:18px;padding:10px 16px;margin:16px 0 0;color:var(--text);font-weight:700}
.settings small{font-weight:500;color:var(--muted);font-size:13px}
nav.tabbar{position:fixed;left:0;right:0;bottom:0;height:calc(84px + env(safe-area-inset-bottom));background:var(--bg);border-top:1px solid var(--line);display:flex;justify-content:space-around;align-items:flex-start;padding:8px 8px env(safe-area-inset-bottom)}
nav.tabbar a{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:64px;min-height:56px;padding-top:4px;color:var(--muted);font-size:11px;line-height:14px;font-weight:600}
nav.tabbar a[aria-current]{color:var(--accent-text);font-weight:700}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const ICON = (d: string) => `<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const LOCK = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
export type Tab = "mind" | "memory" | "ask" | "who";
const TABS: [Tab, string, string, string][] = [
  ["mind", "/home", APP_COPY.tabMind, '<path d="M9 3a4 4 0 0 0-4 4v1a3 3 0 0 0-1 5.5V15a4 4 0 0 0 4 4h1V3z"></path><path d="M15 3a4 4 0 0 1 4 4v1a3 3 0 0 1 1 5.5V15a4 4 0 0 1-4 4h-1V3z"></path>'],
  ["memory", "/memory", APP_COPY.tabMemory, '<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path><path d="M8 7h8M8 11h8M8 15h5"></path>'],
  ["ask", "/ask", APP_COPY.tabAsk, '<path d="M4 6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5 4z"></path>'],
  ["who", "/who", APP_COPY.tabWho, '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"></path><path d="M9 12l2 2 4-4"></path>'],
];
export const tabBar = (on: Tab) => `<nav class="tabbar" aria-label="${APP_COPY.tabs}">${TABS.map(([t, path, name, d]) => `<a href="${path}"${t === on ? ' aria-current="page"' : ""}>${ICON(d)}${esc(name)}</a>`).join("")}</nav>`;

export function appPage(title: string, on: Tab, body: string, o: { css?: string; wrap?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${APP_CSS}${o.css ?? ""}</style></head><body><main class="wrap${o.wrap ? ` ${o.wrap}` : ""}">
${body}
</main>${tabBar(on)}</body></html>`;
}

// One mark per assistant: filled when it gets the line, dashed when it doesn't. The group says it
// in words for a screen reader; a filled letter is only drawn, a dashed one opens its sheet (/let),
// which asks before anything widens. The link carries the fact's key and the assistant, never a value.
export const letHref = (key: string, agent: string) => `/let?key=${encodeURIComponent(key)}&agent=${encodeURIComponent(agent)}`;
export function marksHtml(marks: Mark[], key?: string): string {
  const yes = marks.filter((m) => m.holds).map((m) => m.name), no = marks.filter((m) => !m.holds).map((m) => m.name);
  const said = [yes.length ? fill(APP_COPY.knownBy, { names: and(yes) }) : APP_COPY.nobody, ...(yes.length && no.length ? [fill(no.length === 1 ? APP_COPY.notBy : APP_COPY.notByMany, { names: and(no) })] : [])].join("; ");
  return `<span class="marks"><span class="sr">${esc(said)}</span>${marks.map((m) => m.holds || !key
    ? `<span class="mark${m.holds ? "" : " not"}" aria-hidden="true">${esc(m.short)}</span>`
    : `<a class="mark not" href="${esc(letHref(key, m.agent))}" aria-label="${esc(fill(APP_COPY.letMark, { name: m.name }))}">${esc(m.short)}</a>`).join("")}</span>`;
}

const lock = (stranger?: boolean) => `<span class="note">${LOCK}${esc(stranger ? `${APP_COPY.stranger} · ${APP_COPY.onlyYou}` : APP_COPY.onlyYou)}</span>`;

// A memory: the line in the owner's words, where it came from, Undo, and who knows it.
export function memoryCard(l: HomeLine, csrf: string): string {
  const from = `<small>${esc(l.from)}${l.maybe ? ` · ${HOME_COPY.maybe}` : ""}${l.was !== undefined ? ` · ${HOME_COPY.was} ${esc(l.was)}` : ""}</small>`;
  const undo = l.undo === "undo" ? `<form method="post" action="/action/diary-undo">${hidden(csrf, { token: l.token })}<button class="pill" aria-label="${esc(`${HOME_COPY.undo}: ${l.what}`)}">${HOME_COPY.undo}</button></form>`
    : l.undo === "changed" ? `<a class="state" href="${href(l.page)}">${HOME_COPY.changed}</a>`
    : l.undo === "undone" ? `<span class="state">${HOME_COPY.undone}</span>` : "";
  // A held value's memory is locked; its one Read it is its card above (G550: never twice).
  const who = l.held ? lock() : l.marks?.length ? marksHtml(l.marks, l.key) : "";
  const fromLine = l.just ? `<small>${APP_COPY.justSaid}${l.was !== undefined ? ` · ${HOME_COPY.was} ${esc(l.was)}` : ""}</small>` : from;
  return `<li class="card${l.held ? " warn" : l.just ? " told" : ""}"><a class="what" href="${href(l.page)}">${esc(l.what)}</a><div class="foot">${fromLine}<span class="acts">${undo}${who}</span></div></li>`;
}

// What waits on the owner, as the first things on their mind.
function waitingCard(w: Waiting, csrf: string, gardener = false): string {
  if (w.seen) return `<li class="card warn"><span class="what">${esc(w.what)}</span><div class="foot">${lock(w.stranger)}<form method="post" action="/action/diary-seen">${hidden(csrf, { key: w.seen })}<button class="pill solid" aria-label="${esc(`${APP_COPY.readIt}: ${w.what}`)}">${APP_COPY.readIt}</button></form></div></li>`;
  if (w.href === "/home?all=1") return `<li class="card warn"><span class="what">${esc(w.what)}</span><div class="foot">${lock()}<a class="pill solid" href="${esc(w.href)}">${APP_COPY.seeThem}</a></div></li>`;
  if (gardener) return `<li class="card"><a class="what" href="${esc(w.href)}">${esc(w.what)}</a><div class="foot"><small>${APP_COPY.gardener}</small></div></li>`;
  const verb = w.href.startsWith("/settle/m-") ? APP_COPY.decide : APP_COPY.settle;
  // One link per block: the question opens from its Settle (or Decide), never twice.
  return `<li class="card"><span class="what">${esc(w.what)}</span><div class="foot"><a class="pill" href="${esc(w.href)}" aria-label="${esc(`${verb}: ${w.what}`)}">${verb}</a></div></li>`;
}

const header = (day: string, title: string, initial: string) => `<header class="top"><div><p class="day">${esc(day)}</p><h1>${esc(title)}</h1></div><a class="me" href="/who" aria-label="${APP_COPY.me}">${esc(initial)}</a></header>`;
const box = (csrf: string, f: Record<string, string>, placeholder: string) => `<form class="box" method="post" action="/say">${hidden(csrf, f)}<label class="sr" for="q">${APP_COPY.boxLabel}</label><input type="text" id="q" name="q" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="send" maxlength="500"><button>${HOME_COPY.send}</button></form>`;

// On your mind (/home): the box, then what waits on the owner, then the memories, least certain and
// newest first (homeView's order), the day inside each line, never a heading.
export function homePage(v: HomeView, csrf: string, o: { said?: string; reply?: SayReply; flash?: string } = {}): string {
  const lines = [...v.since, ...v.earlier.flatMap((d) => d.lines)];
  const more = v.folded + v.earlierFolded;
  const cards = [...v.waiting.map((w) => waitingCard(w, csrf)), ...v.gardener.map((w) => waitingCard(w, csrf, true)), ...lines.map((l) => memoryCard(l, csrf))];
  return appPage(APP_COPY.mind, "mind", `${header(v.date, APP_COPY.mind, v.name.slice(0, 1))}
${box(csrf, {}, APP_COPY.box)}${replyHtml(csrf, o)}
${cards.length ? `<ul class="mind">${cards.join("")}</ul>` : `<p class="quiet">${APP_COPY.quiet}</p>`}${more ? `<a class="more" href="/home?all=1">${esc(fill(APP_COPY.more, { n: more }))}</a>` : ""}`);
}

// Ask (/ask): the box on its own, its answer above it. The same gate as the home's box.
// Ask (/ask): the conversation so far, oldest first, then the box. Each turn keeps its Undo and,
// after a write, a link to the page; only the last answer's chips can still be tapped, as only
// those count as a tap (server.ts). Turns hidden because the sign-in is older say so in one line.
export interface AskTurnView { said: string; reply: SayReply; title?: string; prose?: { html: string; cites: { href: string; label: string }[] } }
export function askPage(v: Pick<HomeView, "date" | "name">, csrf: string, o: { turns?: AskTurnView[]; older?: number; flash?: string } = {}): string {
  const turns = o.turns ?? [];
  const turn = (t: AskTurnView, last: boolean) => {
    const acts = [
      t.reply.undo_token ? `<form method="post" action="/action/diary-undo">${hidden(csrf, { token: t.reply.undo_token })}<button>${HOME_COPY.undo}</button></form>` : "",
      t.reply.undo_token && t.reply.page && t.title ? `<a class="open" href="${href(t.reply.page)}">${esc(fill(APP_COPY.open, { title: t.title }))}</a>` : "",
      ...(last ? (t.reply.chips ?? []).map((c) => `<form method="post" action="/say">${hidden(csrf, { q: c.say, chip: "1", from: "ask" })}<button>${esc(c.label)}</button></form>`) : []),
    ].filter(Boolean);
    // An answer about a page is that page's own prose, with what it cites under it.
    const answer = t.prose ? `<div class="bubble answer"${last ? ' role="status"' : ""}><p>${t.prose.html}</p><p class="cites">${t.prose.cites.map((c) => `<a href="${esc(c.href)}">${esc(c.label)}</a>`).join("")}</p></div>` : `<p class="bubble"${last ? ' role="status"' : ""}>${esc(t.reply.text)}</p>`;
    return `<li><p class="bubble you">${esc(t.said)}</p>${answer}${acts.length ? `<div class="chips">${acts.join("")}</div>` : ""}${last && t.reply.signin ? signInAgain(csrf) : ""}</li>`;
  };
  const older = o.older ? `<p class="quiet">${APP_COPY.askOlder}</p>` : "";
  const talk = turns.length ? `<ol class="talk">${turns.map((t, i) => turn(t, i === turns.length - 1)).join("")}</ol>` : older ? "" : `<p class="bubble">${APP_COPY.askHint}</p>`;
  return appPage(APP_COPY.ask, "ask", `${header(v.date, APP_COPY.ask, v.name.slice(0, 1))}
${older}${talk}${o.flash ? `<p class="bubble" role="status">${esc(o.flash)}</p>` : ""}
${box(csrf, { from: "ask" }, APP_COPY.askBox)}`);
}

// Memory (/memory): the kinds with their counts, a kind's pages, a search, and this week's pages.
// Titles only: a page opens on /p, which shuts what is private on its own.
export interface MemoryPage { id: string; title: string; area?: string }
export interface MemoryView { pages: number; people: number; name: string; kinds: { folder: string; label: string; count: number }[]; q?: string; kind?: { label: string; pages: MemoryPage[] }; found?: MemoryPage[]; week: ChangedPage[]; allWeek?: boolean }
// The three area tints (brief 2026-10-30); any other area is a grey dot.
const AREA = new Set(["work", "teaching", "personal"]);
const dot = (area?: string) => `<span class="dot a-${area && AREA.has(area) ? area : "none"}" aria-hidden="true"></span>`;
// The first three kinds get a tinted tile each, in the order people, projects, organisations; the
// rest share a fourth, one link per kind.
const TINT: Record<string, string> = { people: "t-work", projects: "t-personal", orgs: "t-teaching" };
export const WEEK_ROWS = 5;
export function memoryPage(m: MemoryView): string {
  const rows = (ps: MemoryPage[]) => `<ul class="rows">${ps.map((p) => `<li class="changed"><a href="${href(p.id)}">${dot(p.area)}<span class="page"><b>${esc(p.title)}</b></span></a></li>`).join("")}</ul>`;
  const changed = (ps: ChangedPage[]) => `<ul class="rows">${ps.map((p) => `<li class="changed"><a href="${href(p.id)}">${dot(p.area)}<span class="page"><b>${esc(p.title)}</b><small>${esc([p.what.length ? p.what.slice(0, 3).join(", ") : APP_COPY.somethingNew, p.from].join(" · "))}</small></span><span class="when">${esc(p.day)}</span></a></li>`).join("")}</ul>`;
  const search = `<form class="box" method="get" action="/memory"><label class="sr" for="mq">${APP_COPY.search}</label><input type="text" id="mq" name="q" value="${esc(m.q ?? "")}" placeholder="${esc(APP_COPY.searchHint)}" autocomplete="off" enterkeyhint="search" maxlength="200"><button>${APP_COPY.searchGo}</button></form>`;
  const tinted = m.kinds.filter((k) => TINT[k.folder]), rest = m.kinds.filter((k) => !TINT[k.folder]);
  const tiles = `<div class="tiles">${tinted.map((k) => `<a class="tile ${TINT[k.folder]}" href="/memory?kind=${encodeURIComponent(k.folder)}"><b>${k.count}</b><span>${esc(k.label)}</span></a>`).join("")}${rest.length ? `<div class="tile rest">${rest.map((k) => `<a href="/memory?kind=${encodeURIComponent(k.folder)}"><span>${esc(k.label)}</span><b>${k.count}</b></a>`).join("")}</div>` : ""}</div>`;
  const weekHead = `<div class="week-head"><h2>${APP_COPY.changedPages}</h2><span>${APP_COPY.thisWeek}</span></div>`;
  const week = m.week.length ? changed(m.allWeek ? m.week : m.week.slice(0, WEEK_ROWS)) : `<p class="quiet">${APP_COPY.nothingWeek}</p>`;
  const below = m.found !== undefined
    ? `<h2>${esc(fill(APP_COPY.found, { q: m.q ?? "" }))}</h2>${m.found.length ? rows(m.found) : `<p class="quiet">${esc(fill(APP_COPY.nothingFound, { q: m.q ?? "" }))}</p>`}`
    : m.kind ? `<h2>${esc(m.kind.label)}</h2>${rows(m.kind.pages)}<a class="more" href="/memory">${APP_COPY.allKinds}</a>`
    : m.allWeek ? `${weekHead}${week}<a class="more" href="/memory">${APP_COPY.allKinds}</a>`
    : `${tiles}${weekHead}${week}${m.week.length > WEEK_ROWS ? `<a class="more" href="/memory?changes=week">${APP_COPY.allChanges}</a>` : ""}`;
  return appPage(APP_COPY.memory, "memory", `${header(fill(APP_COPY.holds, { pages: m.pages, people: m.people }), APP_COPY.memory, m.name.slice(0, 1))}
${search}${below}`);
}

// Who knows (/who): one block per assistant, its reads today and what it asked, how much it gets
// (See as), what its own memory has wrong with Fix everywhere; then Settings.
export interface WhoExtras { flash?: string; memory?: { pages: number; people: number; learned: number; backup?: string }; trial?: string[]; shorts?: Record<string, string> }
export function whoPage(v: HomeView, csrf: string, o: WhoExtras = {}): string {
  const readLine = (r: HomeView["reads"][number]) => r.today === 0 ? APP_COPY.readNot : r.today === 1 ? APP_COPY.readOnce : fill(APP_COPY.readTimes, { n: r.today });
  const wrongLine = (r: HomeView["reads"][number], l: WrongLine) => `<li class="line wrong"><div class="t"><a href="${href(l.page)}">${esc(l.what)}</a><small>${esc(l.said !== undefined ? fill(HOME_COPY.remembers, { name: r.name, said: l.said, now: l.now ?? "" }) : fill(HOME_COPY.remembersQuiet, { name: r.name }))}</small></div>${l.fixing ? `<span class="state">${HOME_COPY.onItsWay}</span>` : `<form method="post" action="/action/fix-everywhere">${hidden(csrf, { key: l.key })}<button aria-label="${esc(`${HOME_COPY.fix}: ${l.what}`)}">${HOME_COPY.fix}</button></form>`}</li>`;
  const trial = new Set(o.trial ?? []);
  // One card per assistant: its letter, today's reads, how much it sees (See as), what it has wrong
  // with Fix, and what it asked today folded under one line.
  const card = (r: HomeView["reads"][number]) => {
    const sees = r.sees !== undefined ? fill(r.sees === r.of ? APP_COPY.seesAll : APP_COPY.seesSome, { sees: r.sees, of: r.of ?? r.sees }) : "";
    const asked = r.asked?.length ? `<details><summary>${esc(fill(APP_COPY.asked, { n: r.asked.length + (r.askedMore ?? 0) }))}</summary><ul>${r.asked.map((a) => `<li class="line ask"><div class="t">${esc(a.what)}<small>${esc(fill(HOME_COPY.askGot, { at: a.at, told: a.told }))}</small></div></li>`).join("")}${r.askedMore ? `<li class="line ask"><small>${esc(fill(HOME_COPY.askMore, { n: r.askedMore }))}</small></li>` : ""}</ul></details>` : "";
    const wrong = r.wrong?.length ? `<ul class="wrongs">${r.wrong.map((l) => wrongLine(r, l)).join("")}${r.more ? `<li class="line"><small>${esc(fill(HOME_COPY.wrongMore, { n: r.more }))}</small></li>` : ""}</ul>` : "";
    return `<li class="agent"><div class="who-head"><span class="av" aria-hidden="true">${esc(o.shorts?.[r.agent] ?? r.name.slice(0, 1))}</span><div class="t"><b>${esc(r.name)}</b>${trial.has(r.agent) ? `<span class="badge">${APP_COPY.trial}</span>` : ""}<small>${esc(readLine(r))}</small></div>${r.seeHref ? `<a class="see" href="${esc(r.seeHref)}">${APP_COPY.seeAs}</a>` : ""}</div>${sees || trial.has(r.agent) ? `<p class="sees">${esc([sees, trial.has(r.agent) ? APP_COPY.trialWhy : ""].filter(Boolean).join(" · "))}</p>` : ""}${wrong}${asked}</li><!--agent-->`;
  };
  const m = o.memory;
  const numbers = m ? `<section class="numbers" aria-labelledby="mem"><h2 id="mem">${APP_COPY.yourMemory}</h2><div class="nums"><p><b>${m.pages}</b><span>pages</span></p><p><b>${m.people}</b><span>people</span></p><p><b>${m.learned}</b><span>learned this week</span></p></div><p class="backup">${esc(m.backup ?? APP_COPY.backupNone)}</p></section>` : "";
  const flash = o.flash ? `<p class="bubble" role="status">${esc(o.flash)}</p>` : "";
  return appPage(APP_COPY.who, "who", `<header class="top"><div><p class="day">${esc(v.date)}</p><h1>${APP_COPY.who}</h1></div><a class="top-link" href="/overview">${APP_COPY.settings}</a></header>
${flash}${numbers}${v.reads.length ? `<h2>${APP_COPY.assistants}</h2><ul class="agents">${v.reads.map(card).join("")}</ul>` : ""}
<a class="settings" href="/overview">${APP_COPY.settings}<small>${APP_COPY.settingsWhy}</small></a>`);
}

// The sheet a dashed mark opens (/let): "Let Gemini know this?" with what only the owner may do.
// The whole area is a change on Settings (behind a fresh sign-in, like every page past the tabs);
// Keep it from them puts the page on that assistant's own exclude list (note-hide, edit.ts). Nothing
// here widens a view by itself.
export interface LetView { agent: string; name: string; short: string; id: string; key: string; what: string; area?: string; areaPages?: number; offered?: boolean; once?: boolean }
export function letPage(v: LetView, csrf: string): string {
  const area = v.area;
  const why = area && v.areaPages !== undefined ? fill(APP_COPY.letWhyArea, { name: v.name, area }) : fill(APP_COPY.letWhy, { name: v.name });
  const wide = area && v.areaPages !== undefined ? `<a class="choice" href="/agent/${encodeURIComponent(v.agent)}"><b>${esc(fill(APP_COPY.letArea, { area }))}</b><small>${esc(fill(APP_COPY.letAreaWhy, { name: v.name, area, n: v.areaPages }))}</small></a>` : "";
  // Just this one: the owner's tap is the approval of one read (offerOnce in src/asks.ts); once
  // offered, the sheet says so instead of offering it twice.
  const once = v.once === false ? "" : v.offered ? `<p class="choice done" role="status">${esc(fill(APP_COPY.onItsWay, { name: v.name }))}</p>`
    : `<form method="post" action="/action/let-once">${hidden(csrf, { key: v.key, agent: v.agent })}<button class="choice"><b>${esc(APP_COPY.justOne)}</b><small>${esc(fill(APP_COPY.justOneWhy, { name: v.name }))}</small></button></form>`;
  const keep = `<form method="post" action="/action/note-hide">${hidden(csrf, { id: v.id, agent: v.agent, from: "let" })}<button class="choice"><b>${esc(fill(APP_COPY.keepFrom, { name: v.name }))}</b><small>${esc(fill(APP_COPY.keepFromWhy, { name: v.name, area: area ?? "more" }))}</small></button></form>`;
  return appPage(fill(APP_COPY.letTitle, { name: v.name }), "mind", `<section class="sheet" aria-labelledby="let-title">
<div class="head"><span class="big" aria-hidden="true">${esc(v.short)}</span><div><h1 id="let-title">${esc(fill(APP_COPY.letTitle, { name: v.name }))}</h1><p class="sub">${esc(why)}</p></div></div>
<p class="said">${esc(v.what)}</p>
${once}${wide}${keep}<a class="plain" href="/home">${APP_COPY.notNow}</a>
<p class="foot-note">${APP_COPY.letFoot}</p>
</section>`);
}
