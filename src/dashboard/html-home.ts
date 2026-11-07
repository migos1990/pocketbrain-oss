// SPDX-License-Identifier: AGPL-3.0-only
// What the owner's screens share (phone UI spec §2): the box's answer as a bubble, a diary line with
// its Undo (/action/diary-undo), the page and settle screens' look. The home itself and the other
// three tabs are html-app.ts. Fixed words are in HOME_COPY, held to the owner's words by
// test/owner-copy.test.ts.
import type { HomeLine } from "./home";
import type { SayReply } from "../owner-say";

export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const HOME_COPY = {
  send: "Send",
  undo: "Undo",
  changed: "Changed since · see page",
  undone: "Undone",
  was: "was:",
  maybe: "a guess",
  signin: "Sign in again",
  remembers: "{name} remembers “{said}” · your brain says {now}",
  remembersQuiet: "{name} has this wrong",
  onItsWay: "Fix on its way",
  fix: "Fix everywhere",
  wrongMore: "and {n} more it has wrong",
  askGot: "{at} · it got {told}",
  askMore: "and {n} more today",
  teachUnnamed: "You may teach a class at a school in your pages. Right?",
} as const;

const LIGHT = "--bg:#ffffff;--well:#f7f7f5;--line:#e9e9e7;--text:#1f1f1e;--text-2:#5f5e5b;--muted:#71706c;--accent:#2a62d4;--accent-text:#1a6dc0;--bubble:#f0efec;--warn:#9a5b00;--on-accent:#ffffff;";
const DARK = "--bg:#191919;--well:#202020;--line:#2e2e2e;--text:#ededec;--text-2:#a6a5a1;--muted:#9b9a96;--accent:#6f9cf0;--accent-text:#6f9cf0;--bubble:#262626;--warn:#d9a246;--on-accent:#111111;";
const FONT = 'ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,sans-serif';
export const CSS = `
:root{color-scheme:light;${LIGHT}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;${DARK}}}
:root[data-theme="dark"]{color-scheme:dark;${DARK}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:17px/26px ${FONT};-webkit-font-smoothing:antialiased;overflow-x:clip}
a{color:var(--accent-text);text-decoration:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:2px}
.wrap{max-width:640px;margin:0 auto;padding:calc(12px + env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) calc(48px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left))}
.hi{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:8px 0 16px}
.hi h1{font-size:24px;line-height:32px;font-weight:600;margin:0}
.hi a{color:var(--text-2);font-size:15px;min-height:44px;display:inline-flex;align-items:center}
form.box{display:flex;gap:8px;margin:0 0 12px}
form.box input[type=text]{flex:1;min-width:0;font:inherit;color:var(--text);background:var(--bg);border:1.5px solid var(--accent);border-radius:999px;padding:10px 16px;min-height:48px}
form.box button{font:inherit;font-weight:500;border:0;border-radius:999px;padding:0 18px;min-height:48px;background:var(--accent);color:var(--on-accent);cursor:pointer}
.bubble{background:var(--bubble);border-radius:16px 16px 16px 4px;padding:10px 14px;margin:0 0 8px;max-width:92%}
.you{background:var(--accent);color:var(--on-accent);border-radius:16px 16px 4px 16px;margin-left:auto}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.chips button,.line button{font:inherit;font-size:15px;color:var(--accent-text);background:none;border:1px solid var(--line);border-radius:10px;padding:0 14px;min-height:44px;cursor:pointer}
h2{font-size:13px;line-height:20px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:24px 0 4px}
h3{font-size:15px;color:var(--text-2);font-weight:500;margin:16px 0 0}
ul{list-style:none;margin:0;padding:0}
.line{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--line);min-height:44px}
.line:last-child{border-bottom:0}
.line .t{min-width:0;flex:1;overflow-wrap:anywhere}
.line .t a{color:var(--text)}
.line small{display:block;color:var(--text-2);font-size:15px;line-height:22px}
.line .state{color:var(--muted);font-size:15px;flex:none}
.wait .t a{color:var(--text)}.wait b{color:var(--warn);font-weight:500}
.fold{display:inline-flex;align-items:center;min-height:44px;color:var(--accent-text)}
.quiet{color:var(--muted)}
.reads{color:var(--text-2);font-size:15px;line-height:22px;margin:0}.line.who .t b{font-weight:500}.line.wrong,.line.ask{padding-left:12px}.line.ask{font-size:15px;line-height:22px;min-height:0;padding-top:6px;padding-bottom:6px}.reads b{font-weight:500;color:var(--text)}.reads span{white-space:nowrap}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

export const hidden = (csrf: string, f: Record<string, string>) => `<input type="hidden" name="csrf" value="${esc(csrf)}">${Object.entries(f).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}`;
export const href = (id: string) => `/p/${id.split("/").map(encodeURIComponent).join("/")}`;

export function line(l: HomeLine, csrf: string, onPage?: string): string {
  const head = `<a href="${href(l.page)}">${esc(l.what)}</a>`;
  const small = `<small>${esc(l.from)}${l.maybe ? ` · ${HOME_COPY.maybe}` : ""}${l.was !== undefined ? ` · ${HOME_COPY.was} ${esc(l.was)}` : ""}</small>`;
  const right = l.undo === "undo"
    ? `<form method="post" action="/action/diary-undo">${hidden(csrf, { token: l.token, ...(onPage ? { page: onPage } : {}) })}<button aria-label="${esc(`${HOME_COPY.undo}: ${l.what}`)}">${HOME_COPY.undo}</button></form>`
    : l.undo === "changed" ? `<a class="state" href="${href(l.page)}">${HOME_COPY.changed}</a>`
    : l.undo === "undone" ? `<span class="state">${HOME_COPY.undone}</span>` : "";
  return `<li class="line"><div class="t">${head}${small}</div>${right}</li>`;
}

// One button that ends this sign-in, so the next screen asks for a fresh one (spec §8's re-prompt).
export const signInAgain = (csrf: string) => `<div class="chips"><form method="post" action="/action/sign-in-again">${hidden(csrf, {})}<button>${HOME_COPY.signin}</button></form></div>`;
export function replyHtml(csrf: string, o: { said?: string; reply?: SayReply; flash?: string; page?: string }): string {
  return o.reply ? `${o.said ? `<p class="bubble you">${esc(o.said)}</p>` : ""}<p class="bubble" role="status">${esc(o.reply.text)}</p>${o.reply.undo_token || o.reply.chips?.length ? `<div class="chips">${o.reply.undo_token ? `<form method="post" action="/action/diary-undo">${hidden(csrf, { token: o.reply.undo_token, ...(o.page ? { page: o.page } : {}) })}<button>${HOME_COPY.undo}</button></form>` : ""}${(o.reply.chips ?? []).map((c) => `<form method="post" action="/say">${hidden(csrf, { q: c.say, chip: "1", ...(o.reply?.page ? { page: o.reply.page } : {}) })}<button>${esc(c.label)}</button></form>`).join("")}</div>` : ""}${o.reply.signin ? signInAgain(csrf) : ""}` : o.flash ? `<p class="bubble" role="status">${esc(o.flash)}</p>` : "";
}
