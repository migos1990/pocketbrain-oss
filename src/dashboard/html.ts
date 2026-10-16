// SPDX-License-Identifier: AGPL-3.0-only
// Server-rendered pages for the owner dashboard. Plain HTML forms, no framework, no build
// step; a few lines of script only for the chart tooltip.
import { budgetUse, servesHere } from "../budget";
import type { Correction } from "../memsync";
import { renderPreview } from "../carve";
import { refString } from "../sources";
import type { State, AgentRow, DisputeRow, Row, Proposal } from "./data";
import type { ExamRow } from "../exam";
import type { Ask } from "../asks";
import { waitingActions, latchedAgents, listActions, type Action } from "../act";
import { activityByDay } from "./data";
import { usageItem } from "../usage";
import { peopleNeedsYou } from "./people";
import { term, plain, noteName, factName, withNames, agentName, agentLabel } from "./labels";
import { sourceWords } from "./browse";
import { verifyChain } from "../readlog";
import { loadRules, type Rules } from "../rules";
import { join } from "node:path";
import { lookedFor } from "./html-lookedfor";
import { consentCard } from "./html-consent";
import { FAVICON } from "../favicon";
import { bar } from "../measure";
import { escapeRe } from "../util";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const val = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
const ago = (iso: string | undefined, now: Date) => {
  if (!iso) return "never";
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return esc(iso);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const time = (iso: string) => esc(String(iso).replace("T", " ").slice(0, 16));

// Categorical slots (validated reference palette, light and dark steps). Agents keep their
// slot by their order in policy.yaml, so a filter never repaints them.
const SERIES = [["#2a78d6", "#3987e5"], ["#eb6834", "#d95926"], ["#1baf7a", "#199e70"], ["#eda100", "#c98500"], ["#e87ba4", "#d55181"], ["#008300", "#008300"], ["#4a3aa7", "#9085e9"]];

// Logo direction B (Redacted) from pocketbrain-design/logos/b-redacted, one colour (currentColor).
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false" viewBox="0 -4 144 28"><g transform="translate(0,-4) scale(.4375)"><circle cx="22" cy="24" r="13" fill="#ff4f8b"/><circle cx="36" cy="20" r="13" fill="#ff4f8b"/><circle cx="46" cy="30" r="11" fill="#ff4f8b"/><circle cx="18" cy="38" r="12" fill="#ff4f8b"/><circle cx="32" cy="40" r="13" fill="#ff4f8b"/><circle cx="46" cy="42" r="10" fill="#ff4f8b"/><rect x="6" y="25" width="52" height="12" rx="6" fill="currentColor"/></g><g transform="translate(34,0)"><path d="M0.75,4.75V17.25 M0.75,9a4.25,4.25 0 1 1 8.50,0a4.25,4.25 0 1 1 -8.50,0 M12.05,9a4.25,4.25 0 1 0 8.50,0a4.25,4.25 0 1 0 -8.50,0 M30.66,6.16A4.25,4.25 0 1 0 30.66,11.84 M34.05,0.75V13.25 M40.25,4.75L34.05,10.20 M36.41,8.13L40.45,13.25 M43.45,9H51.95A4.25,4.25 0 1 0 50.96,11.73 M56.65,1.75V11.80a2.2,2.2 0 0 0 2.2,2.2h1.00 M54.85,4.75H60.05 M63.00,0.75V13.25 M63.00,9a4.25,4.25 0 1 1 8.50,0a4.25,4.25 0 1 1 -8.50,0 M74.60,4.75V13.25 M74.60,9.50a4.25,4.25 0 0 1 4.25,-4.75h1 M82.25,9a4.25,4.25 0 1 0 8.50,0a4.25,4.25 0 1 0 -8.50,0 M90.75,4.75V13.25 M94.55,4.75V13.25 M98.35,4.75V13.25 M98.35,13.25V9a4.25,4.25 0 0 1 8.50,0V13.25" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="94.55" cy="1.35" r="1.2" fill="currentColor"/></g></svg>`;

// Tokens from pocketbrain-design/tokens.css (design-system.md). Direction "Message": one narrow
// column, type does the hierarchy, no boxes, buttons are text in the accent, good/warn/bad mean
// state only. The dashboard stays one file.
const LIGHT = "--bg:#ffffff;--side:#f7f7f5;--well:#f7f7f5;--hover:#efefed;--line:#e9e9e7;--line-strong:#d3d3d0;--text:#1f1f1e;--text-2:#5f5e5b;--muted:#6f6e6a;--ink:#1f1f1e;--on-ink:#ffffff;--accent:#2a62d4;--accent-text:#2a62d4;--accent-soft:#edf2fc;--good:#236b3d;--good-soft:#eaf4ed;--warn:#9a5b00;--warn-soft:#fbf1e1;--bad:#c2332d;--bad-soft:#fbeceb;--tag:#ebeae7;--tag-text:#45433f;";
const DARK = "--bg:#191919;--side:#202020;--well:#202020;--hover:#2a2a2a;--line:#2e2e2e;--line-strong:#444443;--text:#ededec;--text-2:#a6a5a1;--muted:#9b9a96;--ink:#ededec;--on-ink:#191919;--accent:#6f9cf0;--accent-text:#6f9cf0;--accent-soft:#1d2a40;--good:#5db37c;--good-soft:#1b2c21;--warn:#d9a246;--warn-soft:#33281a;--bad:#f07f78;--bad-soft:#3a1f1e;--tag:#373737;--tag-text:#d4d4d2;";
const MONO = 'ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace';

const CSS = `
:root{color-scheme:light;${LIGHT}${SERIES.map((s, i) => `--s${i + 1}:${s[0]};`).join("")}--surface:var(--bg);--chip:var(--hover);--text2:var(--text-2)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${DARK}${SERIES.map((s, i) => `--s${i + 1}:${s[1]};`).join("")}}}
:root[data-theme="dark"]{color-scheme:dark;${DARK}${SERIES.map((s, i) => `--s${i + 1}:${s[1]};`).join("")}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:17px/28px ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI","Helvetica Neue",Helvetica,sans-serif;-webkit-font-smoothing:antialiased;letter-spacing:-0.004em;font-feature-settings:"kern","liga"}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
b,strong{font-weight:600}
.app{min-height:100vh}
.top{max-width:680px;margin:0 auto;padding:28px 20px 0;display:flex;align-items:baseline;flex-wrap:wrap;gap:12px 20px;font-size:15px;line-height:24px}
.top .logo{display:inline-flex;align-items:center;color:var(--text);align-self:center;margin-right:4px}.top .logo svg{height:20px;width:auto;display:block}
.top .ws{color:var(--muted);margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.top nav{display:flex;flex-wrap:wrap;gap:0 18px;color:var(--text-2);flex-basis:100%}
.top nav a{color:var(--text-2);font-weight:400;display:inline-block;padding:10px 0;min-height:44px}.top nav a:hover{color:var(--text);text-decoration:none}.top nav a.on{color:var(--text);font-weight:600}
.page{min-width:0}
main{width:100%;max-width:680px;margin:0 auto;padding:56px 20px 128px}
h1{font-size:36px;line-height:44px;font-weight:500;letter-spacing:-0.018em;margin:0 0 32px;text-wrap:balance}
h2{font-size:22px;line-height:32px;font-weight:500;letter-spacing:-0.01em;margin:72px 0 16px}
h3,h2.h-day{font-size:17px;line-height:28px;font-weight:600;margin:40px 0 8px;color:var(--text);letter-spacing:0}
h2+h3{margin-top:8px}
p{margin:0 0 16px}
.kpis{display:flex;flex-wrap:wrap;gap:8px 40px;margin:8px 0 24px}
.kpi{padding:0}
.kpi .n{font-size:36px;line-height:44px;font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-0.018em}.kpi .l{color:var(--text-2);font-size:15px;line-height:24px}.kpi.hot .n{color:var(--bad)}.kpi.zero .n{color:var(--muted);font-weight:400}
.card{padding:0;margin:0}
.card.empty{padding:0}
.item{padding:0 0 40px}.item:last-child{padding-bottom:0}
.item .what{min-width:0}.item .acts{display:flex;gap:0 28px;flex-wrap:wrap;margin-top:0}.acts{display:flex;gap:0 28px;flex-wrap:wrap;align-items:baseline}
.kind{display:inline;font-size:inherit;line-height:inherit;font-weight:400;padding:0;background:none;color:var(--text-2);white-space:normal;text-decoration:none}
.item>.what>.kind:first-child{display:block;font-size:15px;line-height:24px;color:var(--text-2);margin-bottom:2px}
.k-refused,.k-refuse,.k-dropped,.k-contradicts,.k-alert{color:var(--bad)}.k-inbox,.k-held,.k-queued,.k-disputed{color:var(--warn)}.k-committed,.k-released,.k-confirms{color:var(--good)}
.item>.what>.k-alert:first-child{font-weight:600}
a.kind{color:var(--accent)}a.kind:hover{text-decoration:underline}a.kind.on{color:var(--text);font-weight:600}
.sub{color:var(--text-2);font-size:15px;line-height:24px}.mono{font-family:${MONO};font-size:15px;overflow-wrap:anywhere}
.quote{white-space:pre-wrap;padding:0 0 0 20px;margin:8px 0;color:var(--text);border-left:2px solid var(--line-strong);max-height:200px;overflow:auto}
button,.btn{font:inherit;font-size:15px;line-height:24px;font-weight:500;padding:10px 0;min-height:44px;border:0;border-radius:0;background:none;color:var(--accent);cursor:pointer;white-space:nowrap;display:inline-block;text-decoration:none;transition:color .12s}
button:hover,.btn:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
button.go{font-weight:600}
button.danger{color:var(--bad)}
button:disabled{opacity:.4;cursor:default;text-decoration:none}
td button,td .btn,.item button{font-size:15px}td>.acts{flex-wrap:nowrap;justify-content:flex-end}table.agents td{white-space:nowrap}table.agents td:first-child{white-space:normal}
form.inline{display:inline}
table{width:100%;border-collapse:collapse;font-size:15px;line-height:24px;margin:0}
th{text-align:left;font-weight:400;color:var(--muted);font-size:15px;line-height:24px;padding:4px 16px 8px 0;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:bottom}
td{font-variant-numeric:tabular-nums;padding:8px 16px 8px 0;border-bottom:1px solid var(--line);vertical-align:top}
tbody tr:last-child td{border-bottom:0}
th:last-child,td:last-child{padding-right:0}
td a{font-weight:500}
td.num,th.num{text-align:right}td:first-child,td[title]{white-space:nowrap}
.wrap{overflow-x:auto}
.status{display:inline-flex;align-items:center;gap:8px;font-weight:400;font-size:15px;line-height:24px;padding:0;background:none}.status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.st-active{color:var(--good)}.st-paused{color:var(--bad)}.st-read-only{color:var(--warn)}
.h1-sub{color:var(--bad);font-weight:400}
h1 .status{vertical-align:middle;margin-left:12px;font-size:17px;letter-spacing:0}
.flash{padding:0 0 16px;margin:0 0 40px;border-bottom:1px solid var(--line)}.flash.err{color:var(--bad)}
.empty{color:var(--muted)}td.empty{padding:8px 0}
.legend{display:flex;gap:4px 20px;flex-wrap:wrap;font-size:15px;line-height:24px;color:var(--text-2);margin:4px 0 12px}.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:1px}
.card.chart{padding:0}.chart svg{display:block;width:100%;height:auto}.chart svg{overflow:visible}.chart text{fill:var(--muted);font-size:18px}
.who .item{padding-bottom:28px}.who .acts{gap:4px 24px}.who .acts button{color:var(--accent);font-weight:400}.who .acts button.danger{color:var(--bad)}.who .acts button.go{font-weight:600}
.who .item b{font-weight:600}.who .item.paused b{color:var(--bad)}
details.more{margin-top:72px}details.more>summary{font-size:17px}
summary{cursor:pointer;color:var(--text-2);font-size:15px;line-height:24px;margin:8px 0;list-style:none;display:inline-block}summary::-webkit-details-marker{display:none}summary::before{content:"";display:inline-block;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);margin:0 10px 2px 2px;transition:transform .12s}details[open]>summary::before{transform:rotate(45deg)}summary:hover{color:var(--text)}
#tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--on-ink);padding:4px 8px;border-radius:4px;font-size:13px;line-height:18px;display:none;z-index:9;white-space:pre}
pre.pv{white-space:pre-wrap;padding:0;font-size:14px;line-height:22px;font-family:${MONO}}
.grid2{display:grid;grid-template-columns:1fr;gap:0}
.lede{font-size:22px;line-height:32px;letter-spacing:-0.01em;margin:-8px 0 24px}.lede b{font-weight:600}.lede a.hot{white-space:nowrap;color:var(--bad);margin-left:4px}.props .hot{color:var(--bad);font-weight:600}
.props{display:grid;grid-template-columns:140px minmax(0,1fr);gap:0 16px;margin:0 0 24px;font-size:17px;line-height:28px}.props dt{color:var(--text-2);padding:2px 0}.props dd{margin:0;padding:2px 0}
.md h1{font-size:22px;line-height:32px;margin:0 0 16px}.md h2{font-size:17px;font-weight:600;margin:40px 0 8px}.md ul{padding-left:20px}.md li{margin:4px 0}.md code{font-size:15px}
.card.md{border:0;padding:0}
code{font-family:${MONO};font-size:15px;color:var(--text)}
select,input[type=text],input[type=number],input[type=search],input:not([type]),textarea{font:inherit;font-size:17px;line-height:28px;padding:2px 0;border:0;border-bottom:1px solid var(--line-strong);border-radius:0;background:none;color:var(--text);max-width:100%}
select{padding-right:4px}
select:focus,input:focus,textarea:focus,input[type=date]:focus-within{outline:none;border-bottom-color:var(--accent);box-shadow:0 1px 0 var(--accent)}
textarea{width:100%;line-height:28px}
.flash{display:flex;gap:16px;align-items:baseline;justify-content:space-between;flex-wrap:wrap}.flash-acts button{padding:10px 0}
mark{background:none;color:var(--text);font-weight:600;text-decoration:underline;text-decoration-color:var(--warn);text-decoration-thickness:2px;text-underline-offset:3px}
.b-search{display:flex;gap:24px;align-items:baseline;margin:0 0 16px}.b-search input{flex:1;min-width:0;font-size:26px;line-height:36px;letter-spacing:-0.012em;font-weight:400;padding:4px 0 8px;border-bottom:1px solid var(--line-strong)}.b-search input::placeholder{color:var(--muted)}
.b-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap;margin:72px 0 16px}.b-head h2{margin:0}
.b-head+.b-kinds{margin-top:0}
.b-kinds{display:flex;flex-wrap:wrap;gap:4px 28px;margin:8px 0}
.b-kind{display:inline-flex;gap:8px;align-items:baseline;padding:0;color:var(--accent);background:none;border:0;font-weight:500}.b-kind b{font-weight:400;color:var(--text-2);font-variant-numeric:tabular-nums}
.card.b-list{padding:0}
.b-row{display:flex;gap:24px;align-items:flex-start;padding:12px 0;border-top:1px solid var(--line);color:var(--text);width:100%;text-align:left;font:inherit;background:none;border-left:0;border-right:0;border-bottom:0;border-radius:0;white-space:normal;cursor:default;text-decoration:none}
.b-list>.b-row:first-child,.b-list>.empty+.b-row{border-top:0}a.b-row,button.b-row{cursor:pointer}a.b-row:hover,button.b-row:hover{text-decoration:none}a.b-row:hover .b-title,button.b-row:hover .b-title{text-decoration:underline;text-underline-offset:3px}
.b-askrow{min-height:32px;align-items:center;color:var(--accent-text)}.b-askrow .b-main span{color:var(--accent-text);font-weight:500}
.b-main{flex:1;min-width:0;display:grid;gap:0}.b-title{font-weight:600;color:var(--text)}.b-snip{color:var(--text);overflow-wrap:anywhere}.b-meta{font-size:15px;line-height:24px;color:var(--text-2)}.b-when{font-size:15px;line-height:28px;color:var(--muted);white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums;min-width:72px}
.b-answer{padding:24px 0 0;margin-top:0}.b-answer-text{white-space:pre-wrap;margin-top:8px;font-size:19px;line-height:30px}
.b-crumbs{font-size:15px;line-height:24px;color:var(--muted);margin:0 0 8px}.b-crumbs a{color:var(--text-2)}
.b-notehead{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}.b-notehead h1{margin:0 0 4px}.b-notehead>div:first-child{min-width:0}
.b-seen{display:flex;gap:4px 8px;align-items:baseline;flex-wrap:wrap;margin-top:32px;padding:0;background:none;font-size:17px}.b-seen .kind{background:none}.b-seen a.kind{color:var(--accent);font-weight:500}.b-why{flex-basis:100%;color:var(--text-2);font-size:15px;line-height:24px}
.b-tell{display:flex;gap:24px;align-items:baseline;margin-top:24px}.b-tell input{flex:1;min-width:0}
.b-facts{margin-top:40px;border-top:1px solid var(--line)}
.b-fact,.b-addfact{display:grid;grid-template-columns:150px minmax(0,1fr) auto;gap:4px 16px;padding:12px 0;border-bottom:1px solid var(--line)}
.b-addfact{display:block}
.b-fact.editing,.b-addfact.editing{background:none;box-shadow:none;padding:12px 0;margin:0}
.b-k{color:var(--text-2);overflow-wrap:anywhere}.b-why{display:block;font-size:12px;text-decoration:none}.b-v{display:grid;gap:0;min-width:0}
.b-show{overflow-wrap:anywhere}.b-show .kind{margin:0 0 0 8px;font-size:15px}
a.b-val{color:var(--text);cursor:text}a.b-val:hover{text-decoration:underline dotted var(--muted);text-underline-offset:4px}
.b-hint-edit{font-size:15px;line-height:28px;color:var(--muted);opacity:0;transition:opacity .12s;white-space:nowrap}.b-fact:hover .b-hint-edit{opacity:1}.b-fact.editing .b-hint-edit{display:none}
.b-item+.b-item{margin-top:8px}
.b-add{display:inline-block;color:var(--accent);font-size:15px;line-height:24px;padding:4px 0}.b-addfact>.b-add{display:block;padding:0}.b-addfact.editing>.b-add{display:none}
.b-edit input[name=value]{width:100%}
.b-pair{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px}
.b-foot{display:flex;gap:8px 24px;align-items:baseline;flex-wrap:wrap;margin-top:12px;font-size:15px;line-height:24px;color:var(--text-2)}.b-gap{flex:1}.b-asof{width:140px;font-size:15px}
.b-text{white-space:pre-wrap;padding:0;margin:0;cursor:text;max-width:100%}.b-text:hover{background:none;text-decoration:underline dotted var(--muted);text-underline-offset:4px}
.b-textform textarea{width:100%;min-height:112px}
.b-raw{width:100%;font:14px/22px ${MONO};padding:8px 0}
.b-hist{margin-top:24px}
.b-list>.empty{padding:0}.b-fact.editing>.b-v>.b-meta{display:none}
.b-change{display:grid;grid-template-columns:150px minmax(0,1fr);gap:4px 16px;padding:12px 0;border-top:1px solid var(--line);align-items:baseline}.b-list>.b-change:first-child{border-top:0}
s{color:var(--muted)}
[hidden]{display:none!important}
.flash,.b-fact,.b-facts{scroll-margin-top:24px}
.h-tl{list-style:none;margin:0;padding:0 0 0 20px;border-left:1px solid var(--line-strong);display:grid;gap:12px}.h-tl li{position:relative}.h-tl li::before{content:"";position:absolute;left:-25px;top:10px;width:9px;height:9px;border-radius:50%;background:var(--bg);border:1px solid var(--line-strong)}.h-tl li.now::before{background:var(--ink);border-color:var(--ink)}
.h-tl li:not(.now) .h-val{color:var(--text-2)}.h-fact{grid-template-columns:150px minmax(0,1fr);padding:12px 0}.h-fact:hover{background:none}.h-val .kind{margin:0 0 0 8px}
.h-save .h-date{text-align:left;min-width:96px;line-height:24px;padding-top:2px}.h-change{display:block;overflow-wrap:anywhere}.h-save .acts{align-items:flex-start}.h-asof{justify-content:space-between}.h-text{cursor:default}.h-text:hover{background:none;text-decoration:none}
.h-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}.h-pick{display:flex;gap:12px;align-items:baseline}.h-asof .h-pick label{color:var(--text-2)}
.b-plain{border-top:1px solid var(--line)}.b-plain>.b-row{padding:12px 0;border-top:0;border-bottom:1px solid var(--line)}.b-plain>.b-row:last-child{border-bottom:0}
table.alerts td{white-space:normal}table.alerts td:first-child{white-space:nowrap;color:var(--muted)}
table.agents,table.agents tbody,table.alerts,table.alerts tbody{display:block}table.agents thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.agents tr,table.alerts tr{display:flex;flex-wrap:wrap;gap:0 12px;padding:12px 0;border-bottom:1px solid var(--line)}table.agents tbody tr:last-child,table.alerts tbody tr:last-child{border-bottom:0}
table.agents td,table.alerts td{display:inline;border:0;padding:0;white-space:normal}table.agents td:first-child{flex-basis:100%;white-space:normal}table.agents td .sub{display:inline;font-size:inherit;line-height:inherit}table.agents td:first-child .sub::before,table.agents td.num .sub::before{content:" · "}
table.agents td:not(:first-child):not(:last-child)+td:not(:last-child)::before{content:"· ";color:var(--muted)}table.agents tbody tr td:not(:first-child):not(:last-child):nth-child(6)::before{content:"· last seen "}table.agents tbody tr td:not(:first-child):not(:last-child):nth-child(7)::before{content:"· access "}table.agents tbody tr td:not(:first-child):not(:last-child):nth-child(8)::before{content:"· memory exam "}table.agents tbody tr td:not(:first-child):not(:last-child):nth-child(n+6)::before{color:var(--muted)}table.agents td:last-child{flex-basis:100%}table.agents td>.acts{justify-content:flex-start;flex-wrap:wrap;margin-top:4px}
table.alerts td:first-child{flex-basis:100%;color:var(--muted);font-size:15px;line-height:24px}table.alerts td+td+td+td{flex-basis:100%}table.alerts td.sub{font-size:inherit;line-height:inherit;color:var(--text-2)}
td .kind{white-space:nowrap}
table.log,table.log tbody{display:block}table.log thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.log tr{display:flex;flex-wrap:wrap;gap:0 6px;padding:12px 0;border-bottom:1px solid var(--line)}table.log tbody tr:last-child{border-bottom:0}
table.log td{display:inline;border:0;padding:0;white-space:normal;overflow-wrap:anywhere}table.log td:empty{display:none}table.log td+td+td::before{content:"· ";color:var(--muted)}
table.log td.when{order:9;flex-basis:100%;color:var(--muted);font-size:15px;line-height:24px}table.log td.when+td::before{content:none}table.log td .sub{display:inline;font-size:inherit;line-height:inherit}
.u-run{display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap}
.lvl{display:inline-flex;flex-wrap:wrap;gap:0 16px;align-items:baseline;max-width:100%;vertical-align:baseline}.lvl select{min-height:44px;padding:8px 4px 8px 0;max-width:100%}
table.beliefs,table.beliefs tbody{display:block}table.beliefs thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
table.beliefs tr{display:flex;flex-wrap:wrap;gap:0 8px;padding:12px 0;border-bottom:1px solid var(--line)}table.beliefs tbody tr:last-child{border-bottom:0}
table.beliefs td{display:inline;border:0;padding:0;white-space:normal;overflow-wrap:anywhere;font-size:17px;line-height:28px}table.beliefs td:first-child,table.beliefs td:nth-child(2),table.beliefs td:last-child{flex-basis:100%}
table.beliefs td:first-child .sub{display:inline;font-size:inherit;line-height:inherit}table.beliefs td:first-child .sub::before{content:" · "}table.beliefs td:first-child code{font-size:15px}
table.beliefs td:nth-child(2)::before{content:"Your brain says ";color:var(--muted)}
table.beliefs td[data-agent]::before{content:attr(data-agent) ": ";color:var(--muted)}table.beliefs td[data-agent]::after{content:" ·";color:var(--muted)}table.beliefs td[data-agent]:nth-last-child(2)::after{content:none}
table.beliefs td[title="not in its view"]{display:none}table.beliefs td .kind{white-space:normal}table.beliefs td[data-agent] .sub{display:inline;font-size:inherit;line-height:inherit;color:var(--text-2)}table.beliefs td[data-agent] .sub::before{content:" "}
table.beliefs td:last-child:empty{display:none}table.beliefs td:last-child form{display:block}
.who+h2+.card .item{padding-bottom:4px}.who+h2+.card .item .kind{margin-right:8px}h2 .status{vertical-align:middle;margin-left:12px;font-weight:400}.who+h2 .status{color:var(--good)}
@media (max-width:720px){.top{padding-top:12px;gap:0 16px}.top .ws{display:none}.top nav{flex-basis:100%;gap:0 16px;font-size:15px}.top nav a{padding:10px 0}
main{padding:40px 16px 96px}h1{font-size:30px;line-height:38px;margin-bottom:24px}h2{font-size:20px;line-height:28px;margin-top:56px}.lede{font-size:19px;line-height:28px}
.item .acts{justify-content:flex-start;flex-basis:100%}td:first-child{white-space:normal}.props{grid-template-columns:110px minmax(0,1fr)}
.b-fact{grid-template-columns:minmax(0,1fr)}.b-hint-edit{display:none}.b-pair,.b-change{grid-template-columns:minmax(0,1fr)}.b-tell{flex-wrap:wrap;gap:8px}.b-tell input,.b-tell button{flex-basis:100%}.b-search{flex-wrap:wrap;gap:8px}.b-search input{font-size:22px;line-height:32px}.b-row .acts{flex-basis:100%}.b-row{gap:16px}.b-when{min-width:0}.props{grid-template-columns:minmax(0,1fr);gap:0}.props dt{padding-top:12px}.props dd{padding-top:0}.a-filter{flex-wrap:wrap}.a-filter select{max-width:100%}.wrap{overflow-x:auto}.chart text{font-size:36px}}
`;

export interface Page { title: string; tab: string; body: string; flash?: { msg: string; err?: boolean; extra?: string } }

// "Robin's brain" in the top row; the folder stays on hover, off screen.
function brainName(rules: Rules | undefined): string {
  const name = rules?.policy.owner?.name;
  return name ? `${name}'s brain` : "Your brain";
}

export function layout(s: { root: string }, p: Page): string {
  let rules: Rules | undefined;
  try { rules = loadRules(s.root); } catch { /* rules mid-edit */ }
  const tabs = [["/", "overview", "Overview"], ["/deck", "deck", "Decide"], ["/brain", "brain", "Brain"], ["/map", "map", "Who sees what"], ["/agents", "agents", "Assistants"], ["/people", "people", "Who matters"], ["/activity", "activity", "Activity"], ["/upkeep", "upkeep", "Upkeep"], ["/digest", "digest", "Digest"], ["/usage", "usage", "Spend"]];
  const name = brainName(rules);
  // One row: the logo, whose brain this is, and the pages as text links. The assistants are on the
  // overview and the Assistants page, so they need no second list here.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} · pocketBrain</title><meta name="referrer" content="same-origin"><link rel="icon" href="${FAVICON}"><style>${CSS}</style></head><body><div class="app">
<header class="top"><span class="logo" role="img" aria-label="pocketBrain">${LOGO}</span><span class="ws" title="${esc(s.root)}">${esc(name)}</span>
<nav aria-label="Pages">${tabs.map(([h, k, l]) => `<a href="${h}" class="${p.tab === k ? "on" : ""}"${p.tab === k ? ' aria-current="page"' : ""}>${l}</a>`).join("")}</nav></header>
<div class="page"><main>${p.flash ? `<div class="flash${p.flash.err ? " err" : ""}" role="status"><span class="flash-msg">${esc(p.flash.msg)}</span>${p.flash.extra ? `<span class="flash-acts">${p.flash.extra}</span>` : ""}</div>` : ""}${p.body}</main></div></div>
<div id="tip"></div><script>
const tip=document.getElementById("tip");
document.addEventListener("mousemove",e=>{const t=e.target.closest&&e.target.closest("[data-tip]");if(!t){tip.style.display="none";return}
tip.textContent=t.dataset.tip;tip.style.display="block";const x=Math.min(e.clientX+14,innerWidth-tip.offsetWidth-8);tip.style.left=x+"px";tip.style.top=(e.clientY+14)+"px"});
document.addEventListener("submit",e=>{const m=e.target.dataset.confirm;if(m&&!confirm(m))e.preventDefault()});
</script></body></html>`;
}

// Every form carries the session's CSRF token.
export function button(csrf: string, action: string, fields: Record<string, string>, label: string, cls = "", confirmMsg?: string) {
  return `<form class="inline" method="post" action="/action/${action}"${confirmMsg ? ` data-confirm="${esc(confirmMsg)}"` : ""}><input type="hidden" name="csrf" value="${esc(csrf)}">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button class="${cls}">${esc(label)}</button></form>`;
}

// The memory exam's grade (src/exam.ts); details on the agent's own page.
function examPill(r?: ExamRow) {
  return !r || r.grade === "no data" ? '<span class="sub">no data</span>' : `<span class="status ${r.grade === "pass" ? "st-active" : r.grade === "fail" ? "st-paused" : "st-read-only"}" title="${esc(r.why.join("; "))}">${esc(r.grade)}</span>`;
}

function examSection(s: State, name: string) {
  const r = s.exams.get(name);
  if (!r) return "";
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
  return `<h2 id="exam">Memory exam</h2><p class="sub">Its own memory against your brain, last 7 days, from the logs. <code>pocketbrain exam</code> runs it weekly; fix drift with <code>pocketbrain memsync list</code>.</p>
<div class="card"><dl class="props"><dt>Grade</dt><dd>${examPill(r)}</dd><dt>Memory in sync</dt><dd>${r.memory.inSync} of ${r.memory.answered} answer${r.memory.answered === 1 ? "" : "s"}${r.memory.unanswered ? `, ${r.memory.unanswered} unanswered` : ""}</dd><dt>Read before writing</dt><dd>${pct(r.brainFirst.writes - r.brainFirst.unread, r.brainFirst.writes)} of ${r.brainFirst.writes} write${r.brainFirst.writes === 1 ? "" : "s"}</dd><dt>Refused for the source</dt><dd>${r.citations.refused}</dd><dt>Outside its view</dt><dd>${r.slice.probes} ask${r.slice.probes === 1 ? "" : "s"}, ${r.slice.alerts} leak alert${r.slice.alerts === 1 ? "" : "s"}</dd></dl>
${r.memory.stale.length ? `<div>Stale in its memory: ${r.memory.stale.map((k) => `<code>${esc(k)}</code>`).join(", ")}</div>` : ""}${r.why.length ? `<ul>${r.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}</div>`;
}

function statusPill(st: string) {
  return `<span class="status st-${esc(st)}">${esc(st)}</span>`;
}

export function killSwitches(csrf: string, a: AgentRow) {
  const b: string[] = [];
  if (a.status !== "active") b.push(button(csrf, "agent-status", { agent: a.name, status: "active" }, "Resume", "go"));
  if (a.status !== "read-only") b.push(button(csrf, "agent-status", { agent: a.name, status: "read-only" }, "Read-only"));
  if (a.status !== "paused") b.push(button(csrf, "agent-status", { agent: a.name, status: "paused" }, "Pause", "", `Pause ${a.label}? It gets nothing from the brain until you resume it.`));
  // An assistant that signs in through Auth0 has no pasted key, but Revoke still cuts its connection.
  if (a.tokens || a.signins) b.push(button(csrf, "agent-revoke", { agent: a.name }, "Revoke access", "danger", `Revoke every way ${a.label} connects? It will have to be connected again.`));
  return `<div class="acts">${b.join("")}</div>`;
}

// One row per assistant: what it holds and did today in two columns, so the kill switches stay in view.
function agentsTable(s: State, csrf: string) {
  return `<div class="card wrap"><table class="agents"><thead><tr><th>Assistant</th><th>Status</th><th>Trust</th><th>Holds</th><th>Last 24 h</th><th>Last seen</th><th title="tokens">Access keys</th><th title="its own memory against the brain, last 7 days">Memory exam</th><th></th></tr></thead><tbody>
${s.agents.map((a) => `<tr><td><a href="/agent/${encodeURIComponent(a.name)}"${a.label !== a.name ? ` title="${esc(a.name)}"` : ""}><b>${esc(a.label)}</b></a><div class="sub">${term(a.transport)}${a.resolver ? ` · ${term("resolver")}` : ""}</div></td>
<td>${statusPill(a.status)}</td><td>${term(a.tier)}</td><td class="num">${a.notes} note${a.notes === 1 ? "" : "s"}<div class="sub">${a.facts} fact${a.facts === 1 ? "" : "s"}</div></td><td class="num">${a.reads24} read${a.reads24 === 1 ? "" : "s"}<div class="sub">${a.writes24} write${a.writes24 === 1 ? "" : "s"}</div></td>
<td>${ago(a.lastSeen, s.now)}</td><td>${a.tokens || a.signins ? [a.tokens ? `<span title="issued ${esc(a.issued)}">${a.tokens} key${a.tokens > 1 ? "s" : ""}</span>` : "", a.signins ? `${a.signins} sign-in${a.signins > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ") : '<span class="sub">none</span>'}</td><td>${examPill(s.exams.get(a.name))}</td><td>${killSwitches(csrf, a)}</td></tr>`).join("")}
</tbody></table></div>`;
}

function disputeItem(s: State, d: DisputeRow, csrf: string) {
  const cands = d.candidates.map((c, i) => `<div class="sub">(${i + 1}) <b>${esc(val(c.value))}</b> · ${term(c.verification)} · as of ${esc(c.as_of)} · by ${esc(c.by)} · ${esc((c.sources ?? []).map(refString).join(", "))}</div>`).join("");
  let acts = "";
  if (d.status === "answer-held") {
    const a = d.answer ?? {};
    acts = button(csrf, "dispute-confirm", { id: d.id }, "Confirm", "go") + button(csrf, "dispute-reject", { id: d.id }, "Reject", "danger");
    return `<div class="item"><div class="what"><span class="kind">relayed answer</span>${factName(s.notes, d.fact_key)}
<div class="sub">${esc(a.relayed_by)} says you chose <b>${esc(val(a.value))}</b> (${esc(a.message_id)}). It is ${esc(d.sensitivity)}, so it waits for you.</div>${cands}</div><div class="acts">${acts}</div></div>`;
  }
  acts = d.candidates.map((c, i) => button(csrf, "dispute-decide", { id: d.id, choice: String(i + 1) }, `Keep (${i + 1})`, i === 0 ? "" : "")).join("");
  const esc8 = d.escalated ? `<div class="sub">Escalated by ${esc(d.escalated.by)}${d.escalated.suggested ? `, suggests (${esc(d.escalated.suggested)})` : ""}${d.escalated.note ? `: ${esc(d.escalated.note)}` : ""}</div>` : "";
  return `<div class="item"><div class="what"><span class="kind" title="${esc(d.id)}">conflict</span>${factName(s.notes, d.fact_key)} <span class="sub">${esc(plain(d.status))} since ${esc(d.created)}</span>${esc8}${cands}</div><div class="acts">${acts}</div></div>`;
}

// Ask to see (src/asks.ts): an agent wants one read of a note outside its slice. The top match is
// what a phone approval releases; the others are there in case the words found the wrong note.
function askItem(s: State, a: Ask, csrf: string) {
  const [top, ...rest] = a.candidates;
  const phone = a.ref ? `Sent to your phone with code <b>${esc(a.code)}</b>; approving there releases this note.` : a.push_error ? `<span style="color:var(--bad)">Couldn't reach your phone: ${esc(a.push_error)}</span>` : "";
  const others = rest.map((c) => button(csrf, "ask-approve", { id: a.id, note: c.id }, `Allow ${c.title} instead`, "", `Let ${agentLabel(s.rules, a.agent)} read ${c.title} once?`)).join("");
  return `<div class="item"><div class="what"><span class="kind k-held">asks to see</span><b>${agentName(s.rules, a.agent)}</b> wants to read ${noteName(s.notes, top.id)} once <span class="sub">${term(top.sensitivity)} · ${ago(a.at, s.now)}, ${Math.max(1, Math.round((Date.parse(a.expires) - s.now.getTime()) / 60_000))} min left to decide</span>
<div class="quote">${esc(a.why)}</div><div class="sub">It asked for "${esc(a.what)}". It doesn't see this note, and won't after the one read.${phone ? ` ${phone}` : ""}</div></div>
<div class="acts">${button(csrf, "ask-approve", { id: a.id, note: top.id }, "Allow once", "go", `Let ${agentLabel(s.rules, a.agent)} read ${top.title} once?`)}${others}${button(csrf, "ask-decline", { id: a.id }, "Decline", "danger")}</div></div>`;
}

// Memory sync (docs/memory-sync.md): an assistant's own memory disagrees with the brain. Approve
// signs the fix (an opaque agent gets it at its next memory_check; a memory file is edited by the
// hub with a backup); the agent is then asked again. Stuck fixes show with why.
function memsyncItem(s: State, c: Correction, csrf: string) {
  const who = agentName(s.rules, c.agent);
  const where = c.from.file ? `<span class="sub" title="${esc(c.from.file)}">line ${c.from.line ?? "?"} of its memory file</span>` : "";
  const what = c.kind === "pointer" ? `keeps its own copy, "${esc(c.wrong)}", of ${esc(c.about)} ${where}. Approve swaps it for a pointer to your brain.`
    : c.kind === "forget" ? `still remembers "${esc(c.wrong)}" for ${esc(c.about)} ${where}, which your brain no longer holds. Approve tells it to delete it.`
    : `remembers "${esc(c.wrong)}" for ${esc(c.about)} ${where}; your brain says <b>${esc(c.right ?? "")}</b>. Approve sends it the fix.`;
  if (c.state !== "proposed") return `<div class="item"><div class="what"><span class="kind k-alert">memory fix stuck</span><b>${who}</b> ${what}<div class="sub">${c.state === "still-wrong" ? "It said it applied the fix, but asked again it still gives the old value." : `It couldn't apply it${c.note ? `: ${esc(c.note)}` : ""}.`} Fix it by hand in that assistant.</div></div><div class="acts"><a class="btn" href="/agent/${encodeURIComponent(c.agent)}">Open</a></div></div>`;
  return `<div class="item"><div class="what"><span class="kind">memory fix</span><b>${who}</b> ${what} <span class="sub" title="${esc(c.at)}">${ago(c.at, s.now)}</span></div>
<div class="acts">${button(csrf, "memsync-approve", { id: c.id }, "Approve", "go")}${button(csrf, "memsync-decline", { id: c.id }, "Decline", "danger")}</div></div>`;
}

// The hub's evidence for one proposal, beside Approve (docs/gardener.md): the value it replaces, any
// check of the cited source (the gardener's verify_source on this exact value, or the hub's own),
// and the other notes it touches. Empty when the hub has nothing to show.
const the = (ref: string) => (sourceWords([ref]) || "the source").replace(/^(an?|your) /, "the ");
function evidenceLine(s: State, p: Proposal): string {
  const e = p.evidence, out: string[] = [];
  if (e?.now) out.push(`Replaces <b>${esc(val(e.now.value))}</b>${e.now.sources.length ? ` (from ${esc(sourceWords(e.now.sources))}${e.now.as_of ? `, ${esc(shortDate(e.now.as_of))}` : ""})` : ""}`);
  const said = (r: string) => r === "match" ? "matches" : "doesn't match";
  for (const v of e?.verified ?? []) out.push(`<span title="${esc(v.ref)}">${esc(agentLabel(s.rules, v.by))} checked against ${esc(the(v.ref))}: ${said(v.result)}${v.withheld ? `, but ${esc(the(v.ref))} reads as instructions` : ""}</span>`);
  if (p.source_check && p.source_check.result !== "unreachable") out.push(`<span title="${esc(p.source_check.ref)}">the hub checked against ${esc(the(p.source_check.ref))}: ${said(p.source_check.result)}${p.source_check.quote ? ` "${esc(p.source_check.quote)}"` : ""}</span>`);
  const others = (e?.notes ?? []).filter((id) => id !== p.request.id);
  if (others.length) out.push(`also: ${others.map((id) => `<a href="/note/${id.split("/").map(encodeURIComponent).join("/")}">${noteName(s.notes, id)}</a>`).join(", ")}`);
  return out.length ? `<div class="sub evidence">${out.join(" · ")}</div>` : "";
}

// The act door (src/act.ts): an agent wants to send a mail. The hub's own facts come first (who,
// which list entry, the checked address, today's counts, what it carries); the agent's words come
// after, escaped and quoted, with the outward screen's matches marked (red team H2, M10). The
// approve form carries the hash of what this page shows; the server sends only that.
function actionItem(s: State, a: Action, csrf: string) {
  const day = new Date(s.now.getTime() - 86_400_000).toISOString();
  const all = listActions(s.root);
  const sent = (agent?: string) => all.filter((x) => (x.state === "sent" || x.state === "sending") && (!agent || x.agent === agent) && (x.ended?.at ?? x.at) >= day).length;
  const words = [...new Set(a.hits.flatMap((h) => h.match.split(/[^\p{L}\p{N}]+/u)).filter((w) => w.length >= 3))].sort((x, y) => y.length - x.length);
  const marked = (t: string) => words.length ? esc(t).replace(new RegExp(`(?<![\\p{L}\\p{N}])(${words.map((w) => escapeRe(esc(w))).join("|")})(?![\\p{L}\\p{N}])`, "giu"), "<mark>$1</mark>") : esc(t);
  const label = agentLabel(s.rules, a.agent);
  const carries = a.carries.length ? `<div class="sub" style="color:var(--bad)">It carries values from notes above ${esc(a.ceiling)}: ${a.carries.map((id) => noteName(s.notes, id)).join(", ")}. The matches are marked below.</div>` : "";
  const flags = a.flags.length ? `<div class="sub" style="color:var(--bad)">${a.flags.map(esc).join("<br>")}</div>` : "";
  return `<div class="item"><div class="what"><span class="kind k-held">mail to send</span><b>${agentName(s.rules, a.agent)}</b> wants to send a mail to <b>${esc(a.entry_label)}</b> <span class="sub">${ago(a.at, s.now)}, code ${esc(a.code)}</span>
<div class="sub">To <code>${esc(a.to)}</code> (${a.entry_kind === "exact" ? "the exact address on its list" : `an address at ${esc(a.entry)} on its list`}). Sent in 24 hours: ${sent(a.agent)} by ${esc(label)}, ${sent()} in all. Nothing is sent until you approve, and only what this page shows.</div>${carries}${flags}
<div class="sub">${esc(label)}'s words, as it wrote them:</div><div class="quote"><b>Subject:</b> ${marked(a.subject)}</div><div class="quote" style="white-space:pre-wrap">${marked(a.body)}</div><div class="sub">Why, it says: ${esc(a.why)}</div></div>
<div class="acts">${button(csrf, "act-approve", { id: a.id, hash: a.hash }, "Send this mail", "go", `Send this mail to ${a.to} as shown?`)}${button(csrf, "act-decline", { id: a.id }, "Decline", "danger")}</div></div>`;
}

function needsYou(s: State, csrf: string) {
  const items: string[] = [];
  const u = usageItem(s.root);
  if (u) items.push(`<div class="item"><div class="what"><span class="kind">model spend</span>${esc(u.title)}</div><div class="acts"><a class="btn" href="/usage">Open</a></div></div>`);
  const people = peopleNeedsYou(s.root, s.notes);
  if (people) items.push(people);
  for (const a of s.asks.filter((x) => x.state === "waiting" && x.candidates.length)) items.push(askItem(s, a, csrf));
  for (const a of waitingActions(s.root)) items.push(actionItem(s, a, csrf));
  for (const agent of latchedAgents(s.root))
    items.push(`<div class="item"><div class="what"><span class="kind k-alert">mail requests stopped</span><b>${agentName(s.rules, agent)}</b> asked to send a mail carrying a value it can't see. Its requests are refused until you let it ask again; look at the alert first.</div><div class="acts">${button(csrf, "act-unlatch", { agent }, "Let it ask again", "", `Let ${agentLabel(s.rules, agent)} ask to send mail again?`)}</div></div>`);
  for (const p of s.proposals) {
    const r = p.request;
    // An agent citing the owner's word that the owner never gave (a forged "owner approved"): said plainly.
    const claimed = /owner_message_registered/.test(p.reason) || p.unregistered.length > 0;
    items.push(`<div class="item"><div class="what">${claimed ? `<span class="kind k-alert">${term("owner_message_registered")}</span>` : `<span class="kind">change to approve</span>`}${agentName(s.rules, p.by)} ${r.retract ? `says ${r.id ? factName(s.notes, `${r.id}${r.attribute ? `#${r.attribute}` : ""}`) : `"${esc(r.title)}"`} is no longer true` : r.id ? `wants to change ${factName(s.notes, `${r.id}${r.attribute ? `#${r.attribute}` : ""}`)} to <b>${esc(val(r.value ?? r.text))}</b>` : `wants to add a note, "${esc(r.title)}": <b>${esc(val(r.value ?? r.text))}</b>`}
<div class="sub">${claimed ? `${esc(agentLabel(s.rules, p.by))} says you approved this. You never did, so it waits for you.` : reasonWords(s, p.reason)}${r.sources ? ` · <span title="${esc((r.sources as unknown[]).map((x) => refString(x as string)).join(", "))}">${claimed ? "claims to be " : ""}from ${esc(sourceWords(r.sources as string[]) || "a source")}${r.as_of ? `, ${esc(shortDate(String(r.as_of)))}` : ""}</span>` : ""}${p.also?.length ? ` · <span title="${esc(p.also.flatMap((a) => a.sources).join(", "))}">also said by ${p.also.map((a) => `${agentName(s.rules, a.by)}${a.level ? ` (${esc(a.level)})` : ""}${a.mismatch ? " (its source doesn't match)" : ""}`).join(", ")} from ${esc(sourceWords(p.also.flatMap((a) => a.sources)) || "a source")}; answering answers them all</span>` : ""}</div>
${evidenceLine(s, p)}</div>
<div class="acts">${button(csrf, "proposal-accept", { file: p.file, ...(p.also?.length ? { twins: p.also.map((a) => a.file).join(",") } : {}) }, "Approve", "go")}${button(csrf, "proposal-reject", { file: p.file, ...(p.also?.length ? { twins: p.also.map((a) => a.file).join(",") } : {}) }, "Reject", "danger")}</div></div>`);
  }
  for (const m of s.held) {
    items.push(`<div class="item"><div class="what"><span class="kind">held message</span><b>${agentName(s.rules, m.from)}</b> to <b>${agentName(s.rules, m.to)}</b>: "${esc(m.subject)}" <span class="sub" title="${esc(m.at)}">${ago(m.at, s.now)}</span>
<div class="sub">${m.reasons.map((x) => heldWords(s, x)).join("<br>")}</div><div class="quote">${esc(m.text)}</div></div>
<div class="acts">${button(csrf, "mail-release", { id: m.id }, "Release", "", `Release this message to ${agentLabel(s.rules, m.to)} as it is?`)}${button(csrf, "mail-drop", { id: m.id }, "Drop", "danger")}</div></div>`);
  }
  // Captures held because they read like instructions: the owner reads the words here, nowhere else.
  for (const c of s.captures) {
    const from = c.via === "agent" ? agentName(s.rules, c.by ?? "?") : esc({ mail: "the capture mailbox", drop: "your drop folder", cli: "the command line", import: "a memory import" }[c.via ?? ""] ?? "a capture channel");
    items.push(`<div class="item"><div class="what"><span class="kind">held capture</span>from ${from}${c.stored ? ` <span class="sub">${esc(shortDate(c.stored))}</span>` : ""}
<div class="sub">Held because it ${esc(c.held.join("; ") || "reads like instructions")}. Nothing in it reaches a model until you release it.</div><div class="quote">${esc(c.text.slice(0, 2000))}</div></div>
<div class="acts">${button(csrf, "capture-release", { file: c.file }, "Release", "", "Release this capture? Its facts are suggested to you at the next pass, as changes to approve.")}${button(csrf, "capture-discard", { file: c.file }, "Discard", "danger")}</div></div>`);
  }
  for (const c of s.memsync) items.push(memsyncItem(s, c, csrf));
  for (const d of s.disputes.filter((x) => ["open", "escalated", "answer-held"].includes(x.status))) items.push(disputeItem(s, d, csrf));
  const latest = s.upkeep[0];
  // Checks after agent writes (src/aftercheck.ts): possible clashes and privacy suggestions, last 7 days.
  const week = new Date(s.now.getTime() - 7 * 86_400_000).toISOString();
  for (const a of s.alerts.filter((x) => (x.check === "write_conflict" || x.check === "classify_review") && String(x.at) >= week)) {
    const id = String(a.from ?? "").split("#")[0];
    items.push(`<div class="item"><div class="what"><span class="kind">${term(a.check)}</span>${withNames(s.notes, String(a.detail ?? a.from ?? ""))} <span class="sub" title="${esc(a.at)}">${ago(String(a.at), s.now)}, after a write by ${agentName(s.rules, a.agent ?? "?")}</span></div><div class="acts"><a class="btn" href="/note/${id.split("/").map(encodeURIComponent).join("/")}">Open</a></div></div>`);
  }
  // The gardener (src/gardener.ts): its token used outside its hours, or the ant CLI not working.
  for (const a of s.alerts.filter((x) => (x.check === "gardener_hours" || x.check === "gardener_ant") && String(x.at) >= week))
    items.push(`<div class="item"><div class="what"><span class="kind">${term(a.check)}</span>${a.check === "gardener_hours" ? hoursWords(s, a) : esc(String(a.detail ?? a.from ?? "")).replace(/`([^`]+)`/g, "<code>$1</code>")} <span class="sub" title="${esc(a.at)}">${ago(String(a.at), s.now)}</span></div><div class="acts"><a class="btn" href="/agent/${encodeURIComponent(String(a.agent ?? "gardener"))}">Open</a></div></div>`);
  for (const e of (latest?.escalate ?? []).filter((x) => !x.startsWith("[open-dispute]")))
    items.push(`<div class="item"><div class="what"><span class="kind">upkeep</span>${finding(e)}</div><div class="acts"><a class="btn" href="/upkeep">Open</a></div></div>`);
  return items;
}

function alertsSince(s: State) {
  const since = new Date(s.now.getTime() - 86_400_000).toISOString();
  return s.alerts.filter((a) => String(a.at) >= since);
}

function alertLine(s: State, a: Row) {
  const who = a.agent ? agentName(s.rules, a.agent) : `${agentName(s.rules, a.from ?? "?")} to ${agentName(s.rules, a.to ?? "?")}`;
  const reasons = a.reasons as string[] | undefined;
  const shown = a.check === "gardener_hours" ? hoursWords(s, a) : reasons ? reasons.map((x) => heldWords(s, x, String(a.to ?? ""))).join("; ") : withNames(s.notes, String(a.detail ?? a.value ?? a.from ?? ""));
  return `<tr><td>${time(String(a.at))}</td><td><span class="kind k-alert">${term(a.check)}</span></td><td>${who}</td><td class="sub">${shown}</td></tr>`;
}

// One line per assistant in the owner's words: what it did today, what it sees, its off switches.
function assistantItem(s: State, csrf: string, a: AgentRow) {
  const did = a.reads24 || a.writes24 ? `read ${a.reads24} time${a.reads24 === 1 ? "" : "s"}, wrote ${a.writes24} today` : "nothing today";
  return `<div class="item${a.status === "paused" ? " paused" : ""}"><div class="what"><a href="/agent/${encodeURIComponent(a.name)}"${a.label !== a.name ? ` title="${esc(a.name)}"` : ""}><b>${esc(a.label)}</b></a>${a.status !== "active" ? ` ${statusPill(a.status)}` : ""}
<div class="sub">${did} · sees ${a.notes} of ${s.notes.length} note${s.notes.length === 1 ? "" : "s"} · last seen ${ago(a.lastSeen, s.now)}</div></div>${killSwitches(csrf, a)}</div>`;
}

// The owner checks in; the assistants and the Gardener do the work. So: what needs you, then what
// each assistant did and can see with its off switches, the day's alerts, and the rest folded away.
// The real-use bar (src/measure.ts bar): days of use in a row, days since the last hand fix, and
// the restore drill, the three things the owner's "is it real yet" question turns on.
function barTile(s: State): string {
  const b = bar(s.root, s.now.toISOString().slice(0, 10));
  const drill = b.restore ? `<span class="kind ${b.restore.ok ? "k-committed" : "k-alert"}">${b.restore.ok ? "passed" : "failed"}</span>Restore drill ${b.restore.ok ? "passed" : "FAILED"} ${esc(b.restore.date)}` : `<span class="kind k-inbox">to do</span>Restore drill: not run yet<div class="sub">pocketbrain drill</div>`;
  return `<h2>Real-use bar${b.met ? ' <span class="status">met</span>' : ""}</h2><div class="card">
<div class="item"><div class="what"><b>Day ${Math.min(b.days, b.target)}</b> of ${b.target} with daily use and no hand fix${b.lastBreak && b.lastBreak.date !== b.sinceFix?.date ? `<div class="sub">last break ${esc(b.lastBreak.date)}: ${esc(b.lastBreak.why.slice(0, 120))}</div>` : ""}</div></div>
<div class="item"><div class="what">${b.sinceFix ? `<b>${b.sinceFix.days} day${b.sinceFix.days === 1 ? "" : "s"}</b> since the last hand fix<div class="sub">${esc(b.sinceFix.date)}: ${esc(b.sinceFix.what.slice(0, 120))}</div>` : "<b>No hand fix</b> logged yet"}</div></div>
<div class="item"><div class="what">${drill}</div></div>${b.open.length ? `<div class="item"><div class="what"><span class="kind k-alert">open</span>${b.open.map(esc).join(", ")}</div></div>` : ""}</div>`;
}

export function overview(s: State, csrf: string): Page {
  const needs = needsYou(s, csrf);
  // Alerts that already sit in Needs you aren't listed twice.
  const shown = new Set(["write_conflict", "classify_review", "gardener_hours", "gardener_ant"]);
  const heldFiles = s.captures.map((c) => c.file);
  const alerts = alertsSince(s).filter((a) => !shown.has(String(a.check)) && !(a.check === "capture_held" && heldFiles.some((f) => String(a.from ?? "").startsWith(f + " "))));
  const paused = s.agents.filter((a) => a.status === "paused").map((a) => esc(a.label));
  const body = `<h1 title="Overview">${needs.length ? `${needs.length} thing${needs.length > 1 ? "s" : ""} need${needs.length > 1 ? "" : "s"} you` : "Nothing needs you"}${paused.length ? `<span class="h1-sub"> · ${paused.join(", ")} paused</span>` : ""}</h1>
<div class="card">${needs.join("") || '<div class="empty">The assistants are behaving.</div>'}</div>
<h2>Your assistants</h2><div class="card who">${s.agents.map((a) => assistantItem(s, csrf, a)).join("")}</div>
${barTile(s)}
${alerts.length ? `<h2>Alerts, last 24 h</h2><div class="card wrap"><table class="alerts"><tbody>${alerts.slice(-20).reverse().map((a) => alertLine(s, a)).join("")}</tbody></table></div>` : ""}
<details class="more"><summary>Activity and your weekly numbers</summary>
<h2>Activity, last 7 days</h2>${activityChart(s)}
<h2>Latest reads</h2>${readsTable(s, s.reads.slice(-15).reverse())}<p><a href="/activity">All activity</a></p>
<h2>Had to explain something again?</h2><div class="card"><form class="inline" method="post" action="/action/reexplain"><input type="hidden" name="csrf" value="${esc(csrf)}"><select name="agent" aria-label="Which assistant">${s.agents.map((a) => `<option value="${esc(a.name)}">${esc(a.label)}</option>`).join("")}</select> <input name="what" required maxlength="300" placeholder="what you told it again" aria-label="What you told it again" style="width:50%"> <button class="go">Log it</button></form> <form class="inline" method="post" action="/action/minutes"><input type="hidden" name="csrf" value="${esc(csrf)}"><input name="minutes" type="number" min="0" max="600" placeholder="min today" aria-label="Minutes you spent on the brain today" style="width:7em"> <button>Log my time</button></form><p class="sub">These two feed your weekly scorecard.</p></div></details>`;
  return { title: "Overview", tab: "overview", body };
}

export function agentsPage(s: State, csrf: string, extra = ""): Page {
  const body = `<h1>Assistants</h1><p class="sub">Pause cuts an assistant off completely (server and relay). Read-only lets it read its slice but refuses every write. Revoke access deletes its keys, so it has to be connected again. Every change is recorded in your brain's history.</p>${agentsTable(s, csrf)}${extra}`;
  return { title: "Assistants", tab: "agents", body };
}

export function agentPage(s: State, csrf: string, name: string): Page | undefined {
  const a = s.agents.find((x) => x.name === name);
  const res = s.carves.get(name);
  if (!a || !res) return undefined;
  const byFolder = new Map<string, string[]>();
  for (const v of res.visible.values()) {
    const fm = v.note.fm;
    const attrs = Object.keys(fm.facts ?? {});
    const shown = v.attributes === "all" ? attrs : attrs.filter((x) => (v.attributes as Set<string>).has(x));
    const f = fm.id.split("/")[0];
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f)!.push(`<tr><td title="${esc(fm.id)}">${esc(fm.title)}</td><td>${esc(fm.sensitivity)}</td><td class="num">${shown.length}/${attrs.length}</td><td>${v.body ? "yes" : "no"}</td></tr>`);
  }
  const excluded = new Map<string, number>();
  for (const e of res.excluded) { const k = e.reason.startsWith("no slice") ? "outside granted slices" : e.reason; excluded.set(k, (excluded.get(k) ?? 0) + 1); }
  const reads = s.reads.filter((r) => r.agent === name);
  const writes = s.writes.filter((r) => r.agent === name);
  const top = new Map<string, number>();
  for (const r of reads) for (const id of (r.ids as string[]) ?? []) if (id !== "*") top.set(id, (top.get(id) ?? 0) + 1);
  const body = `<h1${a.label !== name ? ` title="${esc(name)}"` : ""}>${esc(a.label)} ${statusPill(a.status)}</h1>
<p class="lede">Sees <b>${a.notes} of ${s.notes.length}</b> notes and ${a.facts} fact${a.facts === 1 ? "" : "s"}${res.hiddenFacts.length ? `, with <b>${res.hiddenFacts.length} fact${res.hiddenFacts.length === 1 ? "" : "s"} held back</b>` : ""}. ${reads.length || writes.length ? `${reads.length} read${reads.length === 1 ? "" : "s"} and ${writes.length} write${writes.length === 1 ? "" : "s"} so far.` : "Hasn't connected yet."}${a.flags ? ` <a href="#check" class="hot">${a.flags} thing${a.flags === 1 ? "" : "s"} to check</a>` : ""}</p>
<dl class="props"><dt>Trust</dt><dd>${term(a.tier)}</dd><dt>Connects as</dt><dd>${term(a.transport)}</dd><dt><span title="slices">Sees</span></dt><dd>${esc(a.slices.map(plain).join(", ") || "nothing")} <span class="sub" title="ceiling">· up to ${esc(res.grant.ceiling)} notes</span></dd>${res.grant.exclude_types.length ? `<dt>Not shared</dt><dd>${esc(res.grant.exclude_types.map(plain).join(", "))}</dd>` : ""}<dt>Last seen</dt><dd>${ago(a.lastSeen, s.now)}</dd><dt>Budget</dt><dd>${budgetLine(s, name)}</dd></dl>
${killSwitches(csrf, a)}<div style="height:28px"></div>
${s.rules.policy.agents[name]?.inside_wall || s.rules.policy.agents[name]?.role === "gardener" ? "" : consentCard(csrf, name, a.label)}

<h2>What ${esc(a.label)} sees</h2><details><summary class="sub">Show the summary as the code writes it</summary><pre class="pv">${esc(renderPreview(s.notes, res))}</pre></details>
<p><a href="/agent/${encodeURIComponent(name)}/view" target="_blank" rel="noopener">Open the exact view ${esc(a.label)} gets</a> (exactly the text it is given). See <a href="#looked-for">what it looked for</a>.</p>
<div class="grid2"><div><h3>Left out</h3><div class="card">${[...excluded.entries()].map(([r, n]) => `<div>${esc(r)} <span class="sub">(${n})</span></div>`).join("") || '<div class="empty">Nothing.</div>'}</div></div>
<div><h3>Facts held back</h3><div class="card wrap" style="max-height:260px;overflow:auto">${res.hiddenFacts.length ? `<table><tbody>${res.hiddenFacts.map((h) => `<tr><td>${factName(s.notes, h.key)}</td><td class="sub">${withNames(s.notes, h.reason)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">None.</div>'}</div></div></div>
${res.flags.length ? `<h3 id="check">Check these</h3><div class="card">${res.flags.map((f) => `<div><span class="kind">${term(f.kind)}</span>${noteName(s.notes, f.id)} <span class="sub">${withNames(s.notes, f.detail)}</span></div>`).join("")}</div>` : ""}
${lookedFor(s, name, res)}
${examSection(s, name)}
<h2>Notes in the slice</h2>${[...byFolder.entries()].sort().map(([f, rows]) => `<h3>${esc(f)} (${rows.length})</h3><div class="card wrap"><table><thead><tr><th>Note</th><th>Sensitivity</th><th class="num">Facts shown</th><th>Text</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`).join("")}
<h2>Most read</h2><div class="card">${[...top.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([id, n]) => `<div>${noteName(s.notes, id)} <span class="sub">${n}×</span></div>`).join("") || '<div class="empty">No reads yet.</div>'}</div>
<h2>Recent reads</h2>${readsTable(s, reads.slice(-40).reverse())}
<h2>Recent writes</h2>${writesTable(s, writes.slice(-40).reverse())}`;
  return { title: a.label, tab: "agents", body };
}

// Its live request budget (backlog 267, src/budget.ts): close to a cap shows before the 429 does.
// The counts are the hub's, in its memory: a dashboard run on its own can't see them.
function budgetLine(s: State, name: string) {
  if (!servesHere(s.root)) return `<span class="sub">counted by the hub (pocketbrain start), not by this dashboard on its own</span>`;
  const near = (n: number, cap: number) => cap === 0 ? n > 0 : n >= cap * 0.8;
  const part = (n: number, cap: number, what: string) => `<span${near(n, cap) ? ' class="hot"' : ""}>${n} of ${cap} ${what}</span>`;
  return budgetUse(s.root, name).map((u) => `${u.role ? `${esc(u.role)} key: ` : ""}${part(u.requests, u.requests_per_minute, "requests in the last minute")}, ${part(u.writes, u.writes_per_hour, "writes in the last hour")}`).join("<br>");
}

export function readsTable(s: State, rows: Row[]) {
  if (!rows.length) return '<div class="card empty">No reads yet.</div>';
  return `<div class="card wrap"><table class="log"><thead><tr><th>When</th><th>Assistant</th><th>What</th><th>Notes</th></tr></thead><tbody>${rows.map((r) => {
    const ids = (r.ids as string[]) ?? [];
    return `<tr><td class="when" title="${esc(r.at)}">${ago(String(r.at), s.now)}</td><td>${agentName(s.rules, r.agent)}</td><td>${term(r.op)}${r.q ? ` <span class="sub">"${esc(r.q)}"</span>` : ""}${r.grant ? ` <span class="sub">· approved by ${esc(s.rules.policy.owner?.name ?? "you")} ${r.approved_via === "guardian" ? "on the phone" : "in the dashboard"}, once</span>` : ""}</td><td>${r.asked ? `asked for ${noteName(s.notes, String(r.asked))}, <span class="sub">not given</span>` : ids[0] === "*" ? "all its notes" : ids.slice(0, 6).map((id) => noteName(s.notes, id)).join(", ")}${ids.length > 6 ? ` <span class="sub">+${ids.length - 6}</span>` : ""}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

export function writesTable(s: State, rows: Row[]) {
  if (!rows.length) return '<div class="card empty">No writes yet.</div>';
  return `<div class="card wrap"><table class="log"><thead><tr><th>When</th><th>Assistant</th><th>Fact</th><th>Result</th><th>Checks it failed</th></tr></thead><tbody>${rows.map((r) =>
    `<tr><td class="when" title="${esc(r.at)}">${ago(String(r.at), s.now)}</td><td>${agentName(s.rules, r.agent)}</td><td>${factName(s.notes, String(r.key ?? ""))}</td><td><span class="kind k-${esc(r.outcome)}"${r.step ? ` title="step ${esc(r.step)}"` : ""}>${term(r.outcome)}</span></td><td class="sub">${((r.checks as string[]) ?? []).map(term).join(", ")}</td></tr>`).join("")}</tbody></table></div>`;
}

export function activityChart(s: State) {
  const data = activityByDay(s, 7);
  const names = s.agents.map((a) => a.name);
  const shown = new Map(s.agents.map((a) => [a.name, a.label]));
  const color = (i: number) => (i < SERIES.length ? `var(--s${i + 1})` : "var(--muted)");
  const max = Math.max(1, ...data.map((d) => Object.values(d.counts).reduce((a, b) => a + b, 0)));
  const W = 1100, H = 220, padL = 34, padB = 22, plotH = H - padB - 8, bw = (W - padL) / data.length;
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); const m = max / p; return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; })();
  const y = (v: number) => 8 + plotH - (v / nice) * plotH;
  let svg = "";
  for (const t of [0, nice / 2, nice]) svg += `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-width="1"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  data.forEach((d, i) => {
    const x = padL + i * bw + bw * 0.22, w = bw * 0.56;
    let acc = 0;
    const total = Object.values(d.counts).reduce((a, b) => a + b, 0);
    const segs = names.map((n, j) => ({ n, j, v: d.counts[n] })).filter((g) => g.v > 0);
    segs.forEach((g, k) => {
      const top = y(acc + g.v), bottom = y(acc);
      const h = Math.max(0, bottom - top - (k > 0 ? 2 : 0));
      const isTop = k === segs.length - 1;
      const r = isTop ? Math.min(4, h / 2, w / 2) : 0;
      svg += isTop
        ? `<path d="M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${top + h} Z" fill="${color(g.j)}" data-tip="${esc(`${d.day}\n${shown.get(g.n)}: ${g.v}`)}"/>`
        : `<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="${color(g.j)}" data-tip="${esc(`${d.day}\n${shown.get(g.n)}: ${g.v}`)}"/>`;
      acc += g.v;
    });
    svg += `<rect x="${padL + i * bw}" y="8" width="${bw}" height="${plotH}" fill="transparent" data-tip="${esc(`${d.day}\n${names.map((n) => `${shown.get(n)}: ${d.counts[n]}`).join("\n")}\ntotal: ${total}`)}" style="pointer-events:${total ? "none" : "all"}"/>`;
    svg += `<text x="${padL + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${d.day.slice(5)}</text>`;
  });
  const legend = `<div class="legend">${names.map((n, j) => `<span><i style="background:${color(j)}"></i>${esc(shown.get(n))}</span>`).join("")}</div>`;
  const table = `<details><summary class="sub">Table</summary><div class="wrap"><table><thead><tr><th>Day</th>${names.map((n) => `<th class="num">${esc(shown.get(n))}</th>`).join("")}</tr></thead><tbody>${data.map((d) => `<tr><td>${d.day}</td>${names.map((n) => `<td class="num">${d.counts[n]}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;
  return `<div class="card chart"><div class="sub">Reads and writes per assistant per day</div>${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Reads and writes per assistant per day">${svg}</svg>${table}</div>`;
}

export function activityPage(s: State, agent?: string, op?: string): Page {
  const pick = (r: Row) => (!agent || r.agent === agent);
  const reads = s.reads.filter((r) => pick(r) && (!op || r.op === op));
  const opts = (list: string[], cur: string | undefined, name: string, all: string, label = (x: string) => x) => `<select name="${name}" onchange="this.form.submit()"><option value="">${all}</option>${list.map((x) => `<option value="${esc(x)}"${x === cur ? " selected" : ""}>${esc(label(x))}</option>`).join("")}</select>`;
  const ops = [...new Set(s.reads.map((r) => String(r.op)))].sort();
  const body = `<h1>Activity</h1>${activityChart(s)}
<form method="get" class="a-filter" style="display:flex;gap:8px 24px;margin:24px 0 8px">${opts(s.agents.map((a) => a.name), agent, "agent", "All agents", (x) => agentLabel(s.rules, x))}${opts(ops, op, "op", "All reads", plain)}</form>
<h2>Reads (${reads.length})</h2>${chainLine(s)}${readsTable(s, reads.slice(-200).reverse())}
<h2>Writes</h2>${writesTable(s, s.writes.filter(pick).slice(-100).reverse())}
<h2>Mail between assistants, through the relay</h2>${s.mail.length ? `<div class="card wrap"><table class="log"><thead><tr><th>When</th><th>From</th><th>To</th><th>Subject</th><th>Verdict</th></tr></thead><tbody>${s.mail.filter((m) => !agent || m.from === agent || m.to === agent).slice(-100).reverse().map((m) => `<tr><td class="when">${time(m.at)}</td><td>${agentName(s.rules, m.from)}</td><td>${agentName(s.rules, m.to)}</td><td>${esc(m.subject)}</td><td><span class="kind k-${esc(m.verdict)}">${term(m.verdict)}</span></td></tr>`).join("")}</tbody></table></div>` : '<div class="card empty">No relayed mail yet.</div>'}`;
  return { title: "Activity", tab: "activity", body };
}

// "steward is a trial agent: propose-only; …" from write() in the owner's words.
function reasonWords(s: State, reason: string): string {
  const m = reason.match(/^(\S+) is a trial agent: propose-only(?:; )?(.*)$/);
  if (!m) return withNames(s.notes, reason);
  return `${esc(agentLabel(s.rules, m[1]))} only proposes. Approve to apply.${m[2] ? ` ${withNames(s.notes, m[2])}` : ""}`;
}

// A relay reason (src/relay.ts) without the value itself: the note it comes from, and who can't see it.
function heldWords(s: State, reason: string, to?: string): string {
  const m = reason.match(/^contains ".*", which (\S+) can't see \(([^)]+)\)$/s);
  if (!m) return withNames(s.notes, reason);
  return `mentions ${factName(s.notes, m[2])}, which ${agentName(s.rules, m[1] || to)} can't see`;
}

const DAY_WORDS: Record<string, string> = { daily: "", mon: "Mondays", tue: "Tuesdays", wed: "Wednesdays", thu: "Thursdays", fri: "Fridays", sat: "Saturdays", sun: "Sundays", "mon-fri": "weekdays", "sat-sun": "weekends" };
const clock = (h: number, m: number) => `${h % 12 || 12}:${String(m).padStart(2, "0")}`;
const half = (h: number) => (h < 12 ? "am" : "pm");

// "daily 03:25-05:00" -> "3:25 to 5:00 am"; "sun 09:55-12:00" -> "Sundays 9:55 am to 12:00 pm".
function windowWords(w: string): string {
  const m = w.trim().match(/^(\S+)\s+(\d\d?):(\d\d)-(\d\d?):(\d\d)$/);
  if (!m) return w;
  const [h1, m1, h2, m2] = [m[2], m[3], m[4], m[5]].map(Number);
  const range = half(h1) === half(h2 % 24) ? `${clock(h1, m1)} to ${clock(h2, m2)} ${half(h1)}` : `${clock(h1, m1)} ${half(h1)} to ${clock(h2, m2)} ${half(h2 % 24)}`;
  const days = DAY_WORDS[m[1].toLowerCase()] ?? m[1];
  return days ? `${days} ${range}` : range;
}

// The gardener's tripwire alert (src/gardener.ts) in plain words, without the CLI command.
function hoursWords(s: State, a: Row): string {
  const agent = String(a.agent ?? "gardener");
  const t = String(a.from ?? "").match(/ (\d\d):(\d\d)/);
  const at = t ? `${clock(Number(t[1]), Number(t[2]))} ${half(Number(t[1]))}` : esc(String(a.from ?? "an odd hour"));
  const windows = s.rules.policy.agents[agent]?.windows ?? [];
  const hours = windows.length ? ` (${esc(windows.map(windowWords).join(", or "))})` : "";
  return `The ${agentName(s.rules, agent)}'s key was used at ${at}, outside its hours${hours}. It's paused. Resume it if that was you; otherwise revoke it.`;
}

// "Oct 9" for an as-of date.
function shortDate(d: string): string {
  const t = Date.parse(`${d.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(t) ? d : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// One line saying the read log is intact, when it is (the agent page says when it isn't).
function chainLine(s: State): string {
  const c = verifyChain(join(s.root, "log", "reads.jsonl"));
  if (!c.entries || c.broken !== undefined || c.unchained) return "";
  return `<p class="sub" title="${c.entries} lines, each chained to the one before">Log checks out: no line was changed since it was written.</p>`;
}

// "[rule] `key`: detail" from the run's findings file.
function finding(line: string) {
  const m = line.match(/^\[([^\]]+)\] `([^`]+)`: (.*)$/);
  return m ? `<div style="margin:3px 0"><span class="kind">${term(m[1])}</span> <span title="${esc(m[2])}">${esc(plain(m[2].split("/").pop()!.replace("#", ": ")))}</span> <span class="sub">${esc(m[3])}</span></div>` : `<div class="sub">${esc(line)}</div>`;
}

export function upkeepPage(s: State, csrf: string): Page {
  const runs = s.upkeep;
  const list = (title: string, xs: string[]) => xs.length ? `<h3>${title} (${xs.length})</h3>${xs.slice(0, 30).map(finding).join("")}${xs.length > 30 ? `<div class="sub">…and ${xs.length - 30} more</div>` : ""}` : "";
  const body = `<h1>Upkeep</h1><p class="sub">The nightly upkeep fixes links and dates on its own, one commit per fix. Undo reverts every fix of a run and stops it from coming back.</p>
${runs.length ? runs.slice(0, 15).map((r) => `<div class="card"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap"><b title="${esc(r.run)}">Run of ${esc(r.run.replace(/^reflect-/, "").replace(/T(\d\d)-?(\d\d).*/, " $1:$2"))}</b>
<div class="acts">${r.undone ? '<span class="kind">undone</span>' : r.autoFix.length ? button(csrf, "upkeep-undo", { run: r.run }, `Undo ${r.autoFix.length} fix${r.autoFix.length > 1 ? "es" : ""}`, "danger", `Revert the ${r.autoFix.length} automatic fixes of this run?`) : '<span class="sub">no automatic fixes</span>'}</div></div>
${list("Escalated to you", r.escalate)}${list("Fixed automatically", r.autoFix)}${list("To review", r.review)}</div>`).join("") : '<div class="card empty">No upkeep runs yet. It runs every night once pocketBrain is started.</div>'}`;
  return { title: "Upkeep", tab: "upkeep", body };
}

// Just enough Markdown for the digest: headings, bullets, bold, code.
export function miniMarkdown(md: string): string {
  const inline = (t: string) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const out: string[] = [];
  let inList = false;
  for (const line of md.split("\n")) {
    const h = line.match(/^(#{1,3}) (.*)$/);
    const li = line.match(/^- (.*)$/);
    if (!li && inList) { out.push("</ul>"); inList = false; }
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (li) { if (!inList) { out.push("<ul>"); inList = true; } out.push(`<li>${inline(li[1])}</li>`); }
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

export function digestPage(s: State, csrf: string, d: { file?: string; text?: string }): Page {
  const body = `<div style="display:flex;justify-content:space-between;align-items:center"><h1>Digest</h1>${button(csrf, "digest", {}, "Write today's digest", "go")}</div>
${d.text ? `<p class="sub">${esc(d.file)}</p><div class="card md">${miniMarkdown(d.text)}</div>` : '<div class="card empty">No digest yet.</div>'}`;
  return { title: "Digest", tab: "digest", body };
}
