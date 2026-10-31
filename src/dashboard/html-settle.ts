// SPDX-License-Identifier: AGPL-3.0-only
// The settle screen (phone UI spec §2.3): the only place that asks. One plain question, one row per
// side with where it came from and its date, the Gardener's lean first when it has one, then "Not
// sure, keep both" with the same weight, then the box for a value of the owner's own. A tap answers
// through ownerDecide (core.ts), and so does a value typed in the box, as the owner's own word.
// Fixed words in SETTLE_COPY, held to the owner's words by test/owner-copy.test.ts.
import type { SettleCase, SettleSide } from "../core";
import type { Rules } from "../rules";
import type { Note } from "../brain";
import type { HeldMessage } from "./data";
import { agentLabel, cap, factName, withNames } from "./labels";
import { fromWords, plain } from "./home";
import { displayName } from "../diary";
import { esc, hidden, signInAgain } from "./html-home";
import { appPage } from "./html-app";

export const SETTLE_COPY = {
  back: "On your mind",
  title: "Which is right?",
  sub: "Two sources say different things. Pick one, or tell me what's right.",
  subMany: "Your sources say different things. Pick one, or tell me what's right.",
  of: "{n} of {of}",
  orTell: "Or tell me",
  two: "Is {name}'s {attr} {a} or {b}?",
  many: "Which is {name}'s {attr}?",
  lean: "The Gardener leans this way: {why}",
  both: "Not sure, keep both",
  all: "Not sure, keep them all",
  count: "{n} sources",
  bothSmall: "I stop asking",
  box: "Actually, it's…",
  send: "Send",
  gone: "Nothing to settle here any more.",
  held: "The Gardener hasn't looked at this yet; it will tonight. You can answer now if you know.",
  shut: "These are private. Sign in again to see them.",
  mail: "Should {from}'s message to {to} go through?",
  mailWhy: "I held it because it {why}.",
  mailShut: "It may hold something private. Sign in again to read it.",
  letThrough: "Let it through",
  sendSmall: "{to} gets it as it is.",
  drop: "Don't send it",
  dropSmall: "{to} never sees it.",
} as const;

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso?: string) => iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${Number(iso.slice(8, 10))} ${MONTH[Number(iso.slice(5, 7)) - 1]}` : "";

const SETTLE_CSS = `
.bar{display:flex;justify-content:space-between;align-items:center}
.bar a{color:var(--muted);font-weight:700;display:inline-flex;align-items:center;min-height:44px}
.bar span{font-size:13px;font-weight:600;color:var(--muted)}
.where{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:13px;line-height:18px;font-weight:700;color:var(--accent-text)}
.where .dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--dash)}
.where .dot.a-work{background:var(--accent)}.where .dot.a-teaching{background:var(--t-teaching-text)}.where .dot.a-personal{background:var(--t-personal-text)}
.ask h1{font-size:28px;line-height:34px;margin:10px 0 8px;overflow-wrap:anywhere}
.ask .sub{margin:0 0 22px;color:var(--muted);font-size:14px;line-height:20px}
form.pick{margin:0 0 12px}
form.pick button{width:100%;text-align:left;font:inherit;color:var(--text);background:var(--soft);border:2px solid var(--soft);border-radius:20px;padding:16px 18px;min-height:56px;cursor:pointer;display:flex;flex-direction:column;gap:6px}
form.pick button b{font-size:22px;line-height:28px;font-weight:800;overflow-wrap:anywhere}
form.pick button small{font-size:14px;line-height:20px;color:var(--muted)}
form.pick button .lean{color:var(--accent-text);font-weight:600}
form.pick.first button{background:var(--t-work);border-color:var(--accent)}form.pick.first button b{color:var(--t-work-text)}
form.pick.both button{background:var(--bg);border:1.5px solid var(--line);flex-direction:row;justify-content:space-between;align-items:center;border-radius:16px;padding:14px 18px}
form.pick.both button b{font-size:15px;line-height:22px;font-weight:700;color:var(--muted)}form.pick.both button small{font-size:13px}
.tell{margin:8px 0 6px;font-size:13px;line-height:18px;font-weight:700;color:var(--muted)}
`;

export const question = (c: SettleCase) => {
  const [name, attr] = [displayName(c.page, c.title), c.attr.replace(/_/g, " ")];
  return c.sides.length === 2 ? fill(SETTLE_COPY.two, { name, attr, a: plain(c.sides[0]!.value), b: plain(c.sides[1]!.value) }) : fill(SETTLE_COPY.many, { name, attr });
};

// The Gardener's side first, then the rest in their own order.
export const ordered = (c: SettleCase): SettleSide[] => [...c.sides.filter((s) => s.lean), ...c.sides.filter((s) => !s.lean)];

function row(c: SettleCase, s: SettleSide, csrf: string, rules: Rules, first = false): string {
  const from = [fromWords(s, rules), day(s.as_of)].filter(Boolean).join(", ") + (s.sources > 1 ? ` · ${fill(SETTLE_COPY.count, { n: s.sources })}` : "");
  const lean = s.lean ? `<small class="lean">${esc(fill(SETTLE_COPY.lean, { why: s.lean }))}</small>` : "";
  return `<form class="pick${first ? " first" : ""}" method="post" action="/action/settle-pick">${hidden(csrf, { id: c.id, n: String(s.n) })}<button><b>${esc(plain(s.value))}</b><small>${esc(from)}</small>${lean}</button></form>`;
}

export interface SettleWhere { area?: string; pos?: number; of?: number }
const AREAS = new Set(["work", "teaching", "personal"]);
const top = (o: SettleWhere) => `<div class="bar"><a href="/home">‹ ${SETTLE_COPY.back}</a>${o.pos && o.of && o.of > 1 ? `<span>${esc(fill(SETTLE_COPY.of, { n: o.pos, of: o.of }))}</span>` : ""}</div>`;
const where = (c: SettleCase, area?: string) => `<p class="where"><span class="dot a-${area && AREAS.has(area) ? area : "none"}" aria-hidden="true"></span>${esc(displayName(c.page, c.title))}${area ? ` · ${esc(cap(area))}` : ""}</p>`;

export function settlePage(c: SettleCase | undefined, csrf: string, rules: Rules, flash?: string, o: { fresh?: boolean } & SettleWhere = {}): string {
  // A private value shows only right after a sign-in (spec §8); before that, the question without it.
  const body = !c ? `<p class="quiet">${SETTLE_COPY.gone}</p>` : c.private && !o.fresh ? `${where(c, o.area)}<h1>${esc(fill(SETTLE_COPY.many, { name: displayName(c.page, c.title), attr: c.attr.replace(/_/g, " ") }))}</h1><p class="quiet">${SETTLE_COPY.shut}</p>${signInAgain(csrf)}` : `${where(c, o.area)}<h1>${esc(question(c))}</h1><p class="sub">${esc(c.held ? SETTLE_COPY.held : c.sides.length > 2 ? SETTLE_COPY.subMany : SETTLE_COPY.sub)}</p>
${ordered(c).map((s, i) => row(c, s, csrf, rules, i === 0 && !!s.lean)).join("")}
<form class="pick both" method="post" action="/action/settle-both">${hidden(csrf, { id: c.id })}<button><b>${c.sides.length > 2 ? SETTLE_COPY.all : SETTLE_COPY.both}</b><small>${SETTLE_COPY.bothSmall}</small></button></form>
<p class="tell">${SETTLE_COPY.orTell}</p><form class="box" method="post" action="/action/settle-pick">${hidden(csrf, { id: c.id })}<label class="sr" for="q">${SETTLE_COPY.box}</label><input type="text" id="q" name="value" placeholder="${SETTLE_COPY.box}" autocomplete="off" enterkeyhint="send" maxlength="500"><button>${SETTLE_COPY.send}</button></form>`;
  return appPage(SETTLE_COPY.title, "mind", `${top(o)}
${flash ? `<p class="bubble" role="status">${esc(flash)}</p>` : ""}<div class="ask">${body}</div>`, { css: SETTLE_CSS });
}

// Why the relay held it, without the value it matched (that shows only in the message itself).
function heldWhy(notes: Note[], rules: Rules, reason: string, to: string): string {
  const m = reason.match(/^contains ".*", which (\S+) can't see \(([^)]+)\)$/s);
  return m ? `mentions ${factName(notes, m[2]!)}, which ${agentLabel(rules, m[1] || to)} can't see` : withNames(notes, reason);
}

// A message the relay held between two assistants (Louis's third read, 2026-10-29: it was the one
// thing Settings still decided). Send or don't, from here only; the text shows after a fresh sign-in.
export function heldMailPage(m: HeldMessage | undefined, csrf: string, rules: Rules, notes: Note[], flash?: string, o: { fresh?: boolean } = {}): string {
  const to = m ? agentLabel(rules, m.to) : "";
  const why = m?.reasons.length ? `<p class="quiet">${esc(fill(SETTLE_COPY.mailWhy, { why: m.reasons.map((r) => heldWhy(notes, rules, r, m.to)).join("; ") }))}</p>` : "";
  const text = !m ? "" : o.fresh ? `<p class="bubble">${esc(m.subject ? `${m.subject}: ` : "")}${esc(m.text.slice(0, 2000))}</p>` : `<p class="quiet">${SETTLE_COPY.mailShut}</p>${signInAgain(csrf)}`;
  const pick = (n: string, b: string, small: string) => `<form class="pick both" method="post" action="/action/settle-mail">${hidden(csrf, { id: `m-${m!.id}`, n })}<button><b>${b}</b><small>${esc(fill(small, { to }))}</small></button></form>`;
  const body = !m ? `<p class="quiet">${SETTLE_COPY.gone}</p>` : `<h1>${esc(fill(SETTLE_COPY.mail, { from: cap(agentLabel(rules, m.from)), to }))}</h1>${why}${text}
${o.fresh ? pick("send", SETTLE_COPY.letThrough, SETTLE_COPY.sendSmall) : ""}${pick("drop", SETTLE_COPY.drop, SETTLE_COPY.dropSmall)}`;
  return appPage(SETTLE_COPY.title, "mind", `${top({})}
${flash ? `<p class="bubble" role="status">${esc(flash)}</p>` : ""}<div class="ask">${body}</div>`, { css: SETTLE_CSS });
}
