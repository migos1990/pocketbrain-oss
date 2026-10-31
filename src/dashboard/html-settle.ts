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
import { CSS, esc, hidden, signInAgain } from "./html-home";

export const SETTLE_COPY = {
  back: "Home",
  title: "Which is right?",
  two: "Is {name}'s {attr} {a} or {b}?",
  many: "Which is {name}'s {attr}?",
  lean: "The Gardener leans this way: {why}",
  both: "Not sure, keep both",
  all: "Not sure, keep them all",
  count: "{n} sources",
  bothSmall: "Nothing changes and I stop asking.",
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
.top{display:flex;align-items:center;min-height:44px}
.top a{color:var(--text-2);font-size:15px;display:inline-flex;align-items:center;min-height:44px}
h1{font-size:22px;line-height:30px;font-weight:600;margin:8px 0 16px}
form.pick{margin:0 0 10px}
form.pick button{width:100%;text-align:left;font:inherit;color:var(--text);background:var(--well);border:1px solid var(--line);border-radius:12px;padding:12px 16px;min-height:56px;cursor:pointer}
form.pick button b{display:block;font-weight:600}
form.pick button small{display:block;color:var(--text-2);font-size:15px;line-height:22px}
form.pick button .lean{color:var(--accent-text)}
`;

export const question = (c: SettleCase) => {
  const [name, attr] = [displayName(c.page, c.title), c.attr.replace(/_/g, " ")];
  return c.sides.length === 2 ? fill(SETTLE_COPY.two, { name, attr, a: plain(c.sides[0]!.value), b: plain(c.sides[1]!.value) }) : fill(SETTLE_COPY.many, { name, attr });
};

// The Gardener's side first, then the rest in their own order.
export const ordered = (c: SettleCase): SettleSide[] => [...c.sides.filter((s) => s.lean), ...c.sides.filter((s) => !s.lean)];

function row(c: SettleCase, s: SettleSide, csrf: string, rules: Rules): string {
  const from = [fromWords(s, rules), day(s.as_of)].filter(Boolean).join(", ") + (s.sources > 1 ? ` · ${fill(SETTLE_COPY.count, { n: s.sources })}` : "");
  const lean = s.lean ? `<small class="lean">${esc(fill(SETTLE_COPY.lean, { why: s.lean }))}</small>` : "";
  return `<form class="pick" method="post" action="/action/settle-pick">${hidden(csrf, { id: c.id, n: String(s.n) })}<button><b>${esc(plain(s.value))}</b><small>${esc(from)}</small>${lean}</button></form>`;
}

export function settlePage(c: SettleCase | undefined, csrf: string, rules: Rules, flash?: string, o: { fresh?: boolean } = {}): string {
  // A private value shows only right after a sign-in (spec §8); before that, the question without it.
  const body = !c ? `<p class="quiet">${SETTLE_COPY.gone}</p>` : c.private && !o.fresh ? `<h1>${esc(fill(SETTLE_COPY.many, { name: displayName(c.page, c.title), attr: c.attr.replace(/_/g, " ") }))}</h1><p class="quiet">${SETTLE_COPY.shut}</p>${signInAgain(csrf)}` : `<h1>${esc(question(c))}</h1>${c.held ? `<p class="quiet">${SETTLE_COPY.held}</p>` : ""}
${ordered(c).map((s) => row(c, s, csrf, rules)).join("")}
<form class="pick" method="post" action="/action/settle-both">${hidden(csrf, { id: c.id })}<button><b>${c.sides.length > 2 ? SETTLE_COPY.all : SETTLE_COPY.both}</b><small>${SETTLE_COPY.bothSmall}</small></button></form>
<form class="box" method="post" action="/action/settle-pick">${hidden(csrf, { id: c.id })}<label class="sr" for="q">${SETTLE_COPY.box}</label><input type="text" id="q" name="value" placeholder="${SETTLE_COPY.box}" autocomplete="off" enterkeyhint="send" maxlength="500"><button>${SETTLE_COPY.send}</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${SETTLE_COPY.title}</title><style>${CSS}${SETTLE_CSS}</style></head><body><main class="wrap">
<div class="top"><a href="/home">‹ ${SETTLE_COPY.back}</a></div>
${flash ? `<p class="bubble" role="status">${esc(flash)}</p>` : ""}${body}
</main></body></html>`;
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
  const pick = (n: string, b: string, small: string) => `<form class="pick" method="post" action="/action/settle-mail">${hidden(csrf, { id: `m-${m!.id}`, n })}<button><b>${b}</b><small>${esc(fill(small, { to }))}</small></button></form>`;
  const body = !m ? `<p class="quiet">${SETTLE_COPY.gone}</p>` : `<h1>${esc(fill(SETTLE_COPY.mail, { from: cap(agentLabel(rules, m.from)), to }))}</h1>${why}${text}
${o.fresh ? pick("send", SETTLE_COPY.letThrough, SETTLE_COPY.sendSmall) : ""}${pick("drop", SETTLE_COPY.drop, SETTLE_COPY.dropSmall)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><title>${SETTLE_COPY.title}</title><style>${CSS}${SETTLE_CSS}</style></head><body><main class="wrap">
<div class="top"><a href="/home">‹ ${SETTLE_COPY.back}</a></div>
${flash ? `<p class="bubble" role="status">${esc(flash)}</p>` : ""}${body}
</main></body></html>`;
}
