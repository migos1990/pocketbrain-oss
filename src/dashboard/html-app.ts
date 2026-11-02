// SPDX-License-Identifier: AGPL-3.0-only
// The owner app (brief 2026-10-30, docs/owner-home.md): four tabs and nothing else. On your mind
// (/home) is the box and the memories, each with its marks (marks.ts); Memory (/memory) is the
// wiki's kinds, search and this week's pages; Ask (/ask) is the box on its own; Who knows (/who) is
// the assistants' rows and Settings. Each is a page over functions that already exist; no script, no
// model decides anything here. Fixed words are in APP_COPY, held to the owner's words by
// test/owner-copy.test.ts.
import type { HomeView, HomeLine, Waiting, ChangedPage } from "./home";
import { faceLines, faceRoom, waitingTotal, SETTINGS_HREF } from "./home";
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
  moreAll: "Everything else on your mind",
  waitOne: "thing waits for you",
  waitMany: "things wait for you",
  quiet: "Nothing new on your mind since yesterday.",
  onlyYou: "Only you know this",
  stranger: "From an address your pages don't hold",
  showIt: "Show it",
  settleHead: "To settle",
  settleHint: "Two sources disagree. Pick the one that's right.",
  heldHead: "Private, held from your assistants",
  heldHint: "An assistant saved these. Only you can see them until you tap Show it; then your assistants get it too.",
  gardenerHead: "The Gardener looks tonight",
  settingsHead: "Needs a look in Settings",
  settingsHint: "These wait for you on Settings, where each has its own question.",
  openSettings: "Open Settings",
  latelyHead: "Lately",
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

// The look (Two inks, the owner's pick 2026-10-31): newsprint paper, black text, and two spot inks
// printed over it the way a risograph does (multiply on paper; the dark look prints its own pair flat). The
// headline ink is only ever large text, the fill behind white footnote numbers and Send; the
// marker ink is never text: the count block, the highlighter under values that disagree, the
// current tab. Items are split by 2px rules, never boxed; buttons are bold words underlined in the
// headline ink. The pair is two tokens (INKS), so another pair is a one-line change. The typeface
// is the hub's own copy of Schibsted Grotesk (SIL OFL, src/dashboard/fonts/), served at FONT_PATH;
// the page policy allows fonts from the hub only (font-src 'self').
export const INKS = { headline: "#0078BF", marker: "#FF48B0" } as const;
// The dark look (the owner's pick, variant E): a yellow headline ink on near-black, no blending,
// and dark text on both inks.
export const DARK_INKS = { headline: "#FFE800", marker: "#FF48B0" } as const;
export const TWO_INKS_LIGHT = { paper: "#EEEDE8", raised: "#FAF9F6", text: "#141414", muted: "#4E4E4E", onHeadline: "#FFFFFF", onMarker: "#141414", onOverprint: "#FFFFFF" } as const;
export const TWO_INKS_DARK = { paper: "#121212", raised: "#1F1F1D", text: "#F2F0EA", muted: "#B5B2AA", onHeadline: "#121212", onMarker: "#121212", onOverprint: "#121212" } as const;
const tokens = (t: typeof TWO_INKS_LIGHT | typeof TWO_INKS_DARK, inks: { headline: string; marker: string }, blend: string) => `--headline-ink:${inks.headline};--marker-ink:${inks.marker};--paper:${t.paper};--raised:${t.raised};--text:${t.text};--muted:${t.muted};--on-headline:${t.onHeadline};--on-marker:${t.onMarker};--on-overprint:${t.onOverprint};--blend:${blend};`;
const LIGHT = tokens(TWO_INKS_LIGHT, INKS, "multiply"), DARK = tokens(TWO_INKS_DARK, DARK_INKS, "normal");
const FONT = '"Schibsted Grotesk",ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,sans-serif';
export const FONT_PATH = "/font/schibsted-grotesk.woff2";
// The same paper, inks and typeface for every page behind Settings (layout() in html.ts, G621).
export const APP_TOKENS = { light: LIGHT, dark: DARK, font: FONT } as const;
// The composer grows with its text up to this height (five lines), then scrolls inside.
export const COMPOSER_MAX = 132;
// Six assistants, six prints of the two inks: each ink alone, both overprinted, black, an outline
// and a grey, each with its own text colour.
const OVERPRINT = "background-color:transparent;background-image:linear-gradient(var(--headline-ink),var(--headline-ink)),linear-gradient(var(--marker-ink),var(--marker-ink));background-blend-mode:multiply";
const MARK_COLOURS = `.c0{background:var(--headline-ink);color:var(--on-headline)}.c1{background:var(--marker-ink);color:var(--on-marker)}.c2{${OVERPRINT};color:var(--on-overprint)}.c3{background:var(--text);color:var(--paper)}.c4{background:transparent;color:var(--text);box-shadow:inset 0 0 0 2px var(--text)}.c5{background:var(--muted);color:var(--paper)}`;
export const APP_CSS = `
@font-face{font-family:"Schibsted Grotesk";font-style:normal;font-weight:400 900;font-display:swap;src:url(${FONT_PATH}) format("woff2")}
:root{color-scheme:light;${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${DARK}}}
:root[data-theme="dark"]{color-scheme:dark;${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--text);font:400 17px/24px ${FONT};-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:var(--text);text-decoration:none}
:focus-visible{outline:3px solid var(--text);outline-offset:3px}
.ink{color:var(--headline-ink);mix-blend-mode:var(--blend)}
.wrap{max-width:640px;margin:0 auto;padding:calc(18px + env(safe-area-inset-top)) max(18px,env(safe-area-inset-right)) calc(112px + env(safe-area-inset-bottom)) max(18px,env(safe-area-inset-left))}
.top{margin:0 0 14px}
.top .day{margin:0;display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px;line-height:20px;font-weight:500}
.top .day a{font-weight:700;min-height:44px;display:inline-flex;align-items:center}
h1{margin:10px 0 0;font-size:60px;line-height:.88;font-weight:900;letter-spacing:-.04em;color:var(--headline-ink);mix-blend-mode:var(--blend);overflow-wrap:anywhere;max-width:6.2em}
h2{font-size:22px;line-height:26px;font-weight:900;letter-spacing:-.02em;margin:26px 0 6px}
.count{display:flex;align-items:center;gap:12px;margin:16px 0 4px}
.count b{font-size:54px;line-height:1;font-weight:900;background:var(--marker-ink);color:var(--on-marker);padding:0 10px;mix-blend-mode:var(--blend)}
.count span{font-size:16px;line-height:19px;font-weight:500;max-width:6.5em}
mark{background:linear-gradient(transparent 45%,color-mix(in srgb,var(--marker-ink) 55%,transparent) 45%);color:inherit;padding:0 2px}
.go,.pill,.chips button,.chips .open,.line button,.see,.top-link,.more,.answer .cites a,.agent summary{font:inherit;font-size:15px;line-height:20px;font-weight:800;color:var(--text);background:none;border:0;border-radius:0;padding:0;min-height:44px;display:inline-flex;align-items:center;cursor:pointer;text-decoration:underline;text-decoration-color:var(--headline-ink);text-decoration-thickness:3px;text-underline-offset:6px}
form.box{display:flex;align-items:center;gap:8px;min-height:52px;padding:0 4px 0 12px;background:var(--paper);border:2px solid var(--text);margin:14px 0 18px}
form.box input[type=text]{flex:1;min-width:0;border:0;background:transparent;font:inherit;font-size:17px;font-weight:500;color:var(--text);padding:12px 0}
form.box input[type=text]::placeholder{color:var(--muted)}
form.box button{font:inherit;font-size:16px;font-weight:800;border:0;border-radius:0;padding:0 14px;min-height:44px;background:var(--headline-ink);color:var(--on-headline);cursor:pointer}
.bubble{border-top:2px solid var(--text);padding:10px 0 12px;margin:0;font-size:17px;line-height:24px}
.you{border-top:0;margin:14px 0 0;padding:0 0 6px;font-weight:800;font-size:19px;line-height:25px}
.you::before{content:"— "}
.chips{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 14px}
.talk{list-style:none;margin:0;padding:0}.answer p{margin:0}.answer .cites{display:flex;flex-wrap:wrap;gap:4px 16px;margin:8px 0 0}.chips form{margin:0}
ul{list-style:none;margin:0;padding:0}
.mind{display:flex;flex-direction:column}
h2.group{font-size:15px;line-height:20px;font-weight:900;letter-spacing:0;text-transform:uppercase;margin:22px 0 2px}h2.group b{background:var(--marker-ink);color:var(--on-marker);padding:0 5px;margin-left:4px;mix-blend-mode:var(--blend)}
.hint{margin:0 0 8px;font-size:14px;line-height:19px;color:var(--muted)}
.done{display:flex;gap:8px;align-items:flex-start;margin:12px 0 4px;padding:8px 10px;font-size:14px;line-height:19px;color:var(--muted);background:var(--raised);border-radius:8px}
.done svg{flex:none;margin-top:2px;color:var(--text)}
.card{border-top:2px solid var(--text);padding:10px 0 12px;display:flex;flex-direction:column;gap:6px}
.card:last-child{border-bottom:2px solid var(--text)}
.card .what{font-size:19px;line-height:25px;font-weight:500;color:var(--text);overflow-wrap:anywhere}
.foot{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.foot small,.card .said,.card .meta{font-size:13px;line-height:18px;color:var(--muted);font-weight:500}
.foot small{flex:1;min-width:0}
.foot .acts{display:flex;align-items:center;gap:14px;margin-left:auto}
.foot form{margin:0}
.foot>.pill,.foot>form{margin-left:auto}
.note{font-size:13px;line-height:18px;font-weight:700;color:var(--text);display:inline-flex;align-items:center;gap:6px}
.marks{display:inline-flex;align-items:center;gap:3px}
.mark{min-width:24px;height:24px;padding:0 4px;background:var(--text);color:var(--paper);font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;mix-blend-mode:var(--blend)}
${MARK_COLOURS.replace(/\.c(\d)/g, ".mark.c$1,.av.c$1")}
.mark.not{background:transparent;box-shadow:inset 0 0 0 1.5px var(--muted);color:var(--muted);mix-blend-mode:normal}
a.mark.not{position:relative;box-shadow:inset 0 0 0 2px var(--text);color:var(--text)}
a.mark.not::after{content:"";position:absolute;inset:-10px}
.card.told .what{font-weight:800}
.card.told{animation:register .6s ease-out 1}
@keyframes register{0%{text-shadow:2px 1px 0 var(--marker-ink),-2px -1px 0 var(--headline-ink)}100%{text-shadow:none}}
.sheet{display:flex;flex-direction:column;gap:0}
.sheet .head{display:flex;gap:14px;align-items:flex-end;margin:0 0 14px}
.sheet .big{flex:none;min-width:56px;height:56px;padding:0 8px;background:var(--marker-ink);color:var(--on-marker);font-size:26px;font-weight:900;display:flex;align-items:center;justify-content:center;mix-blend-mode:var(--blend)}
.sheet h1{font-size:34px;line-height:.95;margin:0;max-width:none}
.sheet .sub{margin:6px 0 0;font-size:15px;line-height:20px;color:var(--muted)}
.sheet .said{border-top:2px solid var(--text);border-bottom:2px solid var(--text);padding:10px 0;margin:0 0 6px;font-size:19px;line-height:25px;font-weight:500}
.choice{display:flex;flex-direction:column;gap:2px;background:none;border:0;border-bottom:2px solid var(--text);padding:12px 0;min-height:56px;color:var(--text);font:inherit;text-align:left;width:100%;cursor:pointer}
.choice b{font-weight:800;font-size:19px;line-height:25px;text-decoration:underline;text-decoration-color:var(--headline-ink);text-decoration-thickness:3px;text-underline-offset:6px;align-self:flex-start}
.choice.done{cursor:default;margin:0}.choice small{font-size:13px;line-height:18px;color:var(--muted)}
.sheet form{margin:0}
.plain{display:flex;justify-content:center;align-items:center;min-height:48px;color:var(--text);font-weight:700}
.foot-note{font-size:12px;line-height:16px;color:var(--muted);text-align:center;margin:0}
.state{font-size:13px;color:var(--muted)}
.more{margin:14px 0 0}
.quiet{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px;margin:0 0 4px}
.tile{border-top:2px solid var(--text);padding:8px 0 14px;min-height:96px;display:flex;flex-direction:column;justify-content:space-between;gap:8px;color:var(--text)}
.tile b{display:block;font-size:54px;line-height:1;font-weight:900;letter-spacing:-.04em}.tile span{font-size:15px;line-height:20px;font-weight:700}
.tile.t-work b{color:var(--headline-ink);mix-blend-mode:var(--blend)}.tile.t-teaching b{align-self:flex-start;background:var(--marker-ink);color:var(--on-marker);padding:0 8px;mix-blend-mode:var(--blend)}
.tile.rest{justify-content:flex-start;gap:0;padding:2px 0 6px}.tile.rest a{display:flex;justify-content:space-between;align-items:center;min-height:44px;color:var(--text);font-weight:700}.tile.rest a b{font-size:19px;line-height:24px;letter-spacing:0}
.week-head{display:flex;justify-content:space-between;align-items:baseline}.week-head span{font-size:13px;font-weight:500;color:var(--muted)}
.rows li.changed a{gap:12px;font-weight:400}.rows .dot{flex:none;width:12px;height:12px;border-radius:50%;background:transparent;box-shadow:inset 0 0 0 2px var(--text);mix-blend-mode:var(--blend)}
.dot.a-work{background:var(--headline-ink);box-shadow:none}.dot.a-teaching{background:var(--marker-ink);box-shadow:none}.dot.a-personal{background:var(--text);box-shadow:none}
.rows .page{flex:1;min-width:0;display:flex;flex-direction:column}.rows .page b{font-weight:700}.rows .page small{font-size:13px;line-height:18px;color:var(--muted)}.rows .when{flex:none;font-size:13px;font-weight:500;color:var(--muted)}
.rows a{display:flex;align-items:center;min-height:44px;padding:10px 0;border-top:2px solid var(--text);color:var(--text);font-weight:600}
.rows li:last-child a{border-bottom:2px solid var(--text)}
.line{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 0;border-top:2px solid var(--text);min-height:44px}
.line .t{min-width:0;flex:1;overflow-wrap:anywhere}
.line small{display:block;color:var(--muted);font-size:13px;line-height:18px}
.line.ask,.line.wrong{border-top-width:1px}.line.ask{min-height:0;padding-top:6px;padding-bottom:6px}.line.who b{font-weight:700}
.reads{color:var(--muted);font-size:13px;margin:0}
.numbers{border-top:2px solid var(--text);border-bottom:2px solid var(--text);padding:10px 0 12px;margin:0 0 6px}
.numbers h2{margin:0 0 6px;font-size:15px;line-height:20px;font-weight:700;letter-spacing:0}.numbers .nums{display:flex;gap:22px}.numbers .nums p{margin:0;display:flex;flex-direction:column}
.numbers b{font-size:44px;line-height:1;font-weight:900;letter-spacing:-.03em}.numbers .nums p:first-child b{color:var(--headline-ink);mix-blend-mode:var(--blend)}.numbers span{font-size:13px;line-height:18px;color:var(--muted)}.numbers .backup{margin:10px 0 0;font-size:13px;font-weight:500;color:var(--muted)}
.agents{display:flex;flex-direction:column}.agent{border-top:2px solid var(--text);padding:12px 0}
.agent:last-child{border-bottom:2px solid var(--text)}
.who-head{display:flex;align-items:center;gap:12px}.who-head .t{flex:1;min-width:0}.who-head b{font-weight:900;font-size:22px;line-height:26px;letter-spacing:-.02em}.who-head small{display:block;font-size:13px;line-height:18px;color:var(--muted)}
.av{flex:none;width:36px;height:36px;background:var(--text);color:var(--paper);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;mix-blend-mode:var(--blend)}
.badge{margin-left:8px;font-size:12px;font-weight:800;color:var(--on-marker);background:var(--marker-ink);padding:1px 6px;vertical-align:3px;mix-blend-mode:var(--blend)}
.sees{margin:6px 0 0;font-size:13px;line-height:18px;color:var(--muted)}
.wrongs{margin:8px 0 0}
.agent details{margin:4px 0 0}.agent summary{font-size:14px}
.settings{display:flex;flex-direction:column;justify-content:center;min-height:56px;border-top:2px solid var(--text);border-bottom:2px solid var(--text);padding:10px 0;margin:22px 0 0;color:var(--text);font-weight:900;font-size:22px;letter-spacing:-.02em}
.settings small{font-weight:500;color:var(--muted);font-size:13px;letter-spacing:0}
.pinned{position:fixed;left:0;right:0;bottom:calc(64px + env(safe-area-inset-bottom));background:linear-gradient(to bottom,transparent,var(--paper) 18px);padding:18px max(14px,env(safe-area-inset-left)) 10px}
form.composer{display:flex;align-items:flex-end;gap:8px;min-height:56px;padding:6px 6px 6px 18px;background:var(--raised);border:0;border-radius:28px;box-shadow:0 1px 2px rgba(20,20,20,.08),0 8px 24px rgba(20,20,20,.12);margin:0;transition:box-shadow .15s}
form.composer:focus-within{outline:2px solid var(--headline-ink);outline-offset:0;box-shadow:0 8px 24px rgba(20,20,20,.12)}
form.composer textarea{flex:1;min-width:0;align-self:center;border:0;outline:0;background:transparent;font:inherit;font-size:17px;line-height:24px;font-weight:500;color:var(--text);padding:10px 0;margin:0;resize:none;height:44px;max-height:${COMPOSER_MAX}px;overflow-y:auto;overflow-wrap:anywhere}
form.composer textarea::placeholder{color:var(--muted)}
form.composer button.send{flex:none;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:var(--headline-ink);color:var(--on-headline);display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:.4;transition:opacity .15s,transform .15s}
form.composer.ready button.send{opacity:1}
form.composer.sending button.send{transform:scale(.88)}
.bubble.echo{opacity:.6}
.pinned>*{max-width:604px;margin-left:auto;margin-right:auto}.pinned form.box{margin:0 auto}
.wrap.chat{padding-bottom:calc(160px + env(safe-area-inset-bottom))}
nav.tabbar{position:fixed;left:0;right:0;bottom:0;height:calc(64px + env(safe-area-inset-bottom));background:var(--paper);border-top:2px solid var(--text);display:flex;justify-content:space-between;align-items:center;gap:4px;padding:0 max(14px,env(safe-area-inset-left)) env(safe-area-inset-bottom)}
nav.tabbar a{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 4px;color:var(--text);font-size:14px;line-height:18px;font-weight:700;white-space:nowrap}
nav.tabbar a[aria-current]{background:linear-gradient(transparent 24%,var(--marker-ink) 24% 76%,transparent 76%);color:var(--on-marker);mix-blend-mode:var(--blend)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const LOCK = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>';
export type Tab = "mind" | "memory" | "ask" | "who";
const TABS: [Tab, string, string][] = [
  ["mind", "/home", APP_COPY.tabMind],
  ["memory", "/memory", APP_COPY.tabMemory],
  ["ask", "/ask", APP_COPY.tabAsk],
  ["who", "/who", APP_COPY.tabWho],
];
// The tabs are words, no icons; the current one is printed in the marker ink.
export const tabBar = (on: Tab) => `<nav class="tabbar" aria-label="${APP_COPY.tabs}">${TABS.map(([t, path, name]) => `<a href="${path}"${t === on ? ' aria-current="page"' : ""}>${esc(name)}</a>`).join("")}</nav>`;

export function appPage(title: string, on: Tab, body: string, o: { css?: string; wrap?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>${APP_CSS}${o.css ?? ""}</style></head><body><main class="wrap${o.wrap ? ` ${o.wrap}` : ""}">
${body}
</main>${tabBar(on)}${body.includes('class="box composer"') ? COMPOSER_JS : ""}</body></html>`;
}

// One mark per assistant: filled when it gets the line, dashed when it doesn't. The group says it
// in words for a screen reader; a filled letter is only drawn, a dashed one opens its sheet (/let),
// which asks before anything widens. The link carries the fact's key and the assistant, never a value.
export const letHref = (key: string, agent: string) => `/let?key=${encodeURIComponent(key)}&agent=${encodeURIComponent(agent)}`;
export function marksHtml(marks: Mark[], key?: string): string {
  const yes = marks.filter((m) => m.holds).map((m) => m.name), no = marks.filter((m) => !m.holds).map((m) => m.name);
  const said = [yes.length ? fill(APP_COPY.knownBy, { names: and(yes) }) : APP_COPY.nobody, ...(yes.length && no.length ? [fill(no.length === 1 ? APP_COPY.notBy : APP_COPY.notByMany, { names: and(no) })] : [])].join("; ");
  return `<span class="marks"><span class="sr">${esc(said)}</span>${marks.map((m) => m.holds || !key
    ? `<span class="mark${m.holds ? (m.colour ? ` ${m.colour}` : "") : " not"}" aria-hidden="true">${esc(m.short)}</span>`
    : `<a class="mark not" href="${esc(letHref(key, m.agent))}" aria-label="${esc(fill(APP_COPY.letMark, { name: m.name }))}">${esc(m.short)}</a>`).join("")}</span>`;
}

const lock = (stranger?: boolean) => `<span class="note">${LOCK}${esc(stranger ? `${APP_COPY.stranger} · ${APP_COPY.onlyYou}` : APP_COPY.onlyYou)}</span>`;

// A memory: the line in the owner's words, where it came from, Undo, and who knows it.
// On the face (the six cards) a memory is its sentence, where it came from and who knows it: its
// Undo and what it was are on the full list and on its page, but what the owner just said keeps
// its Undo there too.
export function memoryCard(l: HomeLine, csrf: string, face = false): string {
  const where = l.said ?? l.from;
  const from = face ? `<small>${esc(where)}${l.maybe ? ` · ${HOME_COPY.maybe}` : ""}</small>` : `<small>${esc(where)}${l.maybe ? ` · ${HOME_COPY.maybe}` : ""}${l.was !== undefined ? ` · ${HOME_COPY.was} ${esc(l.was)}` : ""}</small>`;
  const undo = face && !l.just ? "" : l.undo === "undo" ? `<form method="post" action="/action/diary-undo">${hidden(csrf, { token: l.token })}<button class="pill" aria-label="${esc(`${HOME_COPY.undo}: ${l.what}`)}">${HOME_COPY.undo}</button></form>`
    : l.undo === "changed" ? `<a class="state" href="${href(l.page)}">${HOME_COPY.changed}</a>`
    : l.undo === "undone" ? `<span class="state">${HOME_COPY.undone}</span>` : "";
  // A held value's memory is locked; its one Read it is its card above (G550: never twice).
  const who = l.held ? lock() : l.marks?.length ? marksHtml(l.marks, l.key) : "";
  const fromLine = l.just ? `<small>${APP_COPY.justSaid}${l.was !== undefined && !face ? ` · ${HOME_COPY.was} ${esc(l.was)}` : ""}</small>` : from;
  return `<li class="card${l.held ? " warn" : l.just ? " told" : ""}"><a class="what" href="${href(l.page)}">${esc(l.what)}</a><div class="foot">${fromLine}<span class="acts">${undo}${who}</span></div></li>`;
}

// The values that disagree, under the marker ink's highlighter: each part found after the last.
export function marked(what: string, parts: string[] = []): string {
  let out = "", at = 0;
  for (const p of parts) {
    const i = p ? what.indexOf(p, at) : -1;
    if (i < 0) continue;
    out += `${esc(what.slice(at, i))}<mark>${esc(p)}</mark>`;
    at = i + p.length;
  }
  return out + esc(what.slice(at));
}

// What waits on the owner, as the first things on their mind.
function waitingCard(w: Waiting, csrf: string, gardener = false): string {
  if (w.seen) return `<li class="card warn"><span class="what">${esc(w.what)}</span><div class="foot">${lock(w.stranger)}<form method="post" action="/action/diary-seen">${hidden(csrf, { key: w.seen })}<button class="pill solid" aria-label="${esc(`${APP_COPY.showIt}: ${w.what}`)}">${APP_COPY.showIt}</button></form></div></li>`;
  if (w.href === "/home?all=1") return `<li class="card warn"><span class="what">${esc(w.what)}</span><div class="foot">${lock()}<a class="pill solid" href="${esc(w.href)}">${APP_COPY.seeThem}</a></div></li>`;
  if (onSettings(w)) return `<li class="card"><span class="what">${esc(w.what)}</span><div class="foot"><span></span><a class="pill" href="${esc(w.href)}">${APP_COPY.openSettings}</a></div></li>`;
  if (gardener) return `<li class="card"><a class="what" href="${esc(w.href)}">${esc(w.what)}</a><div class="foot"><small>${w.meta ? `${esc(w.meta)} · ` : ""}${APP_COPY.gardener}</small></div></li>`;
  const verb = w.href.startsWith("/settle/m-") ? APP_COPY.decide : APP_COPY.settle;
  // One link per block: the question opens from its Settle (or Decide), never twice.
  return `<li class="card"><span class="what">${marked(w.what, w.parts)}</span><div class="foot">${w.meta ? `<span class="meta">${esc(w.meta)}</span>` : ""}<a class="pill" href="${esc(w.href)}" aria-label="${esc(`${verb}: ${w.what}`)}">${verb}</a></div></li>`;
}

// The link to the rest of On your mind: a count while it is small, words once it isn't (Mac,
// 2026-10-31: "214 more on your mind" is a number nobody reads).
export const MORE_COUNTED = 20;
export const moreWords = (n: number) => n <= MORE_COUNTED ? fill(APP_COPY.more, { n }) : APP_COPY.moreAll;

// The day and the owner's name over a headline in the headline ink.
const header = (day: string, title: string, name: string) => `<header class="top"><p class="day"><span>${esc(day)}</span><a class="me" href="/who">${esc(name)}</a></p><h1>${esc(title)}</h1></header>`;
// How many things wait, big, in the marker ink.
const count = (n: number) => n ? `<p class="count"><b>${n}</b><span>${n === 1 ? APP_COPY.waitOne : APP_COPY.waitMany}</span></p>` : "";
// The composer (owner, 2026-10-31: a modern app's box): a text area that grows with its text, a
// round send arrow, Enter sends and Shift+Enter breaks the line. Without its script it is a plain
// form that still posts.
const ARROW = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>';
export function composer(csrf: string, f: Record<string, string>, placeholder: string, o: { label?: string; action?: string; name?: string; send?: string } = {}): string {
  return `<form class="box composer" data-focus-ring method="post" action="${esc(o.action ?? "/say")}">${hidden(csrf, f)}<label class="sr" for="q">${esc(o.label ?? APP_COPY.boxLabel)}</label><textarea id="q" name="${esc(o.name ?? "q")}" rows="1" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="send" maxlength="500"></textarea><button class="send" aria-label="${esc(o.send ?? HOME_COPY.send)}">${ARROW}</button></form>`;
}
// Grows the text area as it wraps, lights the arrow, sends on Enter, and on Ask shows what was said
// at once while the page loads.
const COMPOSER_JS = "<script>for(const f of document.querySelectorAll('form.composer')){const t=f.querySelector('textarea');const fit=()=>{t.style.height='auto';t.style.height=Math.min(t.scrollHeight," + COMPOSER_MAX + ")+'px';f.classList.toggle('ready',t.value.trim()!=='')};t.addEventListener('input',fit);t.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(t.value.trim())f.requestSubmit()}});f.addEventListener('submit',e=>{if(!t.value.trim()){e.preventDefault();return}f.classList.add('sending');const pin=f.closest('.pinned');if(pin&&f.closest('.chat')){const p=document.createElement('p');p.className='bubble you echo';p.textContent=t.value.replace(/\\s+/g,' ').trim();pin.before(p);scrollTo(0,document.body.scrollHeight)}});fit()}</script>";
const box = (csrf: string, f: Record<string, string>, placeholder: string) => `<div class="pinned">${composer(csrf, f, placeholder)}</div>`;

// On your mind (/home): the box, then what waits on the owner, then the memories, least certain and
// newest first (homeView's order), the day inside each line, never a heading.
// What waits, each kind under a heading that says what to do (G625): conflicts and held messages to
// settle, held values to show; the Gardener's are apart and not counted. What was just done is a
// quiet done line, never a card.
const held = (w: Waiting) => !!w.seen || w.href === "/home?all=1";
const onSettings = (w: Waiting) => w.href === SETTINGS_HREF;
const group = (head: string, hint: string, cards: string[], n = cards.length) => cards.length ? `<h2 class="group">${esc(head)} <b>${n}</b></h2><p class="hint">${esc(hint)}</p><ul class="mind">${cards.join("")}</ul>` : "";
const DONE = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"></path></svg>';
export function homePage(v: HomeView, csrf: string, o: { said?: string; reply?: SayReply; flash?: string; done?: boolean } = {}): string {
  const all = [...v.since, ...v.earlier.flatMap((d) => d.lines)];
  // The face: what waits, then the memories worth acting on, six cards in all (MIND_CAP); the full
  // list (?all=1) is every line with its Undo.
  const lines = v.all ? all : faceLines(all, faceRoom(v.waiting.length + v.gardener.length));
  const more = v.all ? 0 : all.length - lines.length + v.folded + v.earlierFolded;
  // Each heading carries its own count, and the two add up to the big number.
  const settle = v.waiting.filter((w) => !held(w) && !onSettings(w)), hold = v.waiting.filter(held), elsewhere = v.waiting.filter(onSettings);
  const asks = group(APP_COPY.settleHead, APP_COPY.settleHint, settle.map((w) => waitingCard(w, csrf)), waitingTotal(settle))
    + group(APP_COPY.heldHead, APP_COPY.heldHint, hold.map((w) => waitingCard(w, csrf)), waitingTotal(hold))
    + group(APP_COPY.settingsHead, APP_COPY.settingsHint, elsewhere.map((w) => waitingCard(w, csrf)), waitingTotal(elsewhere))
    + (v.gardener.length ? `<h2 class="group">${esc(APP_COPY.gardenerHead)}</h2><ul class="mind">${v.gardener.map((w) => waitingCard(w, csrf, true)).join("")}</ul>` : "");
  const mems = lines.map((l) => memoryCard(l, csrf, !v.all));
  const reply = o.done && o.flash && !o.reply ? `<p class="done" role="status">${DONE}<span>${esc(o.flash)}</span></p>` : replyHtml(csrf, o);
  return appPage(APP_COPY.mind, "mind", `${header(v.date, APP_COPY.mind, v.name)}${count(waitingTotal(v.waiting))}
${reply}
${asks}${mems.length ? `${asks ? `<h2 class="group">${APP_COPY.latelyHead}</h2>` : ""}<ul class="mind">${mems.join("")}</ul>` : asks ? "" : `<p class="quiet">${APP_COPY.quiet}</p>`}${more ? `<a class="more" href="/home?all=1">${esc(moreWords(more))}</a>` : ""}
${box(csrf, {}, APP_COPY.box)}`, { wrap: "chat" });
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
  // The box sits at the bottom, above the tabs, as in any chat (Louis, 2026-10-31), and the page
  // opens on the newest answer.
  return appPage(APP_COPY.ask, "ask", `${header(v.date, APP_COPY.ask, v.name)}
${older}${talk}${o.flash ? `<p class="bubble" role="status">${esc(o.flash)}</p>` : ""}
${box(csrf, { from: "ask" }, APP_COPY.askBox)}${turns.length ? "<script>scrollTo(0,document.body.scrollHeight)</script>" : ""}`, { wrap: "chat" });
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
  return appPage(APP_COPY.memory, "memory", `${header(fill(APP_COPY.holds, { pages: m.pages, people: m.people }), APP_COPY.memory, m.name)}
${search}${below}`);
}

// Who knows (/who): one block per assistant, its reads today and what it asked, how much it gets
// (See as), what its own memory has wrong with Fix everywhere; then Settings.
export interface WhoExtras { flash?: string; memory?: { pages: number; people: number; learned: number; backup?: string }; trial?: string[]; shorts?: Record<string, string>; colours?: Record<string, string> }
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
    return `<li class="agent"><div class="who-head"><span class="av${o.colours?.[r.agent] ? ` ${o.colours[r.agent]}` : ""}" aria-hidden="true">${esc(o.shorts?.[r.agent] ?? r.name.slice(0, 1))}</span><div class="t"><b>${esc(r.name)}</b>${trial.has(r.agent) ? `<span class="badge">${APP_COPY.trial}</span>` : ""}<small>${esc(readLine(r))}</small></div>${r.seeHref ? `<a class="see" href="${esc(r.seeHref)}">${APP_COPY.seeAs}</a>` : ""}</div>${sees || trial.has(r.agent) ? `<p class="sees">${esc([sees, trial.has(r.agent) ? APP_COPY.trialWhy : ""].filter(Boolean).join(" · "))}</p>` : ""}${wrong}${asked}</li><!--agent-->`;
  };
  const m = o.memory;
  const numbers = m ? `<section class="numbers" aria-labelledby="mem"><h2 id="mem">${APP_COPY.yourMemory}</h2><div class="nums"><p><b>${m.pages}</b><span>pages</span></p><p><b>${m.people}</b><span>people</span></p><p><b>${m.learned}</b><span>learned this week</span></p></div><p class="backup">${esc(m.backup ?? APP_COPY.backupNone)}</p></section>` : "";
  const flash = o.flash ? `<p class="bubble" role="status">${esc(o.flash)}</p>` : "";
  return appPage(APP_COPY.who, "who", `<header class="top"><p class="day"><span>${esc(v.date)}</span><a class="top-link" href="/overview">${APP_COPY.settings}</a></p><h1>${APP_COPY.who}</h1></header>
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
