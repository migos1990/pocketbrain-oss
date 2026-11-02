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
import { agentLabel, cap, factName, withNames, refusalWords } from "./labels";
import { fromWords, plain, differ } from "./home";
import { displayName } from "../diary";
import { esc, hidden, signInAgain } from "./html-home";
import { appPage, composer } from "./html-app";

export const SETTLE_COPY = {
  back: "On your mind",
  title: "Which is right?",
  sub: "Two sources say different things. Pick one, or tell me what's right.",
  subMany: "Your sources say different things. Pick one, or tell me what's right.",
  of: "{n} of {of}",
  orTell: "Or tell me",
  next: "What's next for {name}?",
  what: "What is {name}'s {attr}?",
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

// Two inks on Settle: the question as a headline, each side between rules, the part that differs
// under the marker ink's highlighter; the Gardener's side carries a headline-ink bar.
const SETTLE_CSS = `
.bar{display:flex;justify-content:space-between;align-items:center;font-size:14px;line-height:20px}
.bar a{font-weight:700;display:inline-flex;align-items:center;min-height:44px}
.bar span{font-size:14px;font-weight:500;color:var(--muted)}
.where{display:flex;align-items:center;gap:8px;margin:10px 0 0;font-size:14px;line-height:20px;font-weight:700}
.where .dot{flex:none;width:12px;height:12px;border-radius:50%;box-shadow:inset 0 0 0 2px var(--text);mix-blend-mode:var(--blend)}
.where .dot.a-work{background:var(--headline-ink);box-shadow:none}.where .dot.a-teaching{background:var(--marker-ink);box-shadow:none}.where .dot.a-personal{background:var(--text);box-shadow:none}
.ask h1{font-size:44px;line-height:.92;margin:10px 0 10px;max-width:none}
.ask .sub{margin:0 0 18px;color:var(--muted);font-size:15px;line-height:20px}
form.pick{margin:0}
form.pick button{width:100%;text-align:left;font:inherit;color:var(--text);background:none;border:0;border-top:2px solid var(--text);border-radius:0;padding:12px 0 14px;min-height:56px;cursor:pointer;display:flex;flex-direction:column;gap:6px}
form.pick button b{align-self:flex-start;font-size:30px;line-height:34px;font-weight:900;letter-spacing:-.03em;overflow-wrap:anywhere;background:linear-gradient(transparent 45%,color-mix(in srgb,var(--marker-ink) 55%,transparent) 45%);padding:0 2px}
form.pick button small{font-size:13px;line-height:18px;color:var(--muted)}
form.pick button .whole{font-size:15px;line-height:21px;color:var(--text);overflow-wrap:anywhere}
form.pick button q.said{font-size:14px;line-height:20px;color:var(--text);font-style:italic;overflow-wrap:anywhere}
form.pick button .lean{color:var(--text);font-weight:700}
form.pick.first button{box-shadow:inset 6px 0 0 var(--headline-ink);padding-left:16px}
form.pick.both button{border-bottom:2px solid var(--text);flex-direction:row;justify-content:space-between;align-items:center;gap:12px}
form.pick.both button b{font-size:16px;line-height:22px;font-weight:800;letter-spacing:0;background:none;text-decoration:underline;text-decoration-color:var(--headline-ink);text-decoration-thickness:3px;text-underline-offset:6px}form.pick.both button small{font-size:13px;text-align:right}
.tell{margin:14px 0 6px;font-size:13px;line-height:18px;font-weight:700;color:var(--muted)}
`;

// One short question (canvas Settle board: "When does the beta freeze?"); the sides say the values.
export const question = (c: SettleCase) => {
  const [name, attr] = [displayName(c.page, c.title), c.attr.replace(/_/g, " ")];
  const fixed = fill(c.attr === "next_step" ? SETTLE_COPY.next : SETTLE_COPY.what, { name, attr });
  return /s's /.test(fixed) ? fixed.replace(/s's /, "s' ") : fixed;
};

// The Gardener's side first, then the rest in their own order.
export const ordered = (c: SettleCase): SettleSide[] => [...c.sides.filter((s) => s.lean), ...c.sides.filter((s) => !s.lean)];

// A side shows big only the part that differs from the others ("15 October"), its whole value under
// it when that is more, then where it came from.
function row(c: SettleCase, s: SettleSide, csrf: string, rules: Rules, first = false, said?: string): string {
  const from = cap([fromWords(s, rules), day(s.as_of)].filter(Boolean).join(", ") + (s.sources > 1 ? ` · ${fill(SETTLE_COPY.count, { n: s.sources })}` : ""));
  const lean = s.lean ? `<small class="lean">${esc(fill(SETTLE_COPY.lean, { why: s.lean }))}</small>` : "";
  const d = differ(c.sides.map((x) => plain(x.value)));
  const whole = plain(s.value), big = d.rest[c.sides.indexOf(s)] ?? whole;
  return `<form class="pick${first ? " first" : ""}" method="post" action="/action/settle-pick">${hidden(csrf, { id: c.id, n: String(s.n) })}<button><b>${esc(big)}</b>${said ? `<q class="said">${esc(said)}</q>` : big !== whole ? `<span class="whole">${esc(whole)}</span>` : ""}<small>${esc(from)}</small>${lean}</button></form>`;
}

export interface SettleWhere { area?: string; pos?: number; of?: number }
const AREAS = new Set(["work", "teaching", "personal"]);
const top = (o: SettleWhere) => `<div class="bar"><a href="/home">‹ ${SETTLE_COPY.back}</a>${o.pos && o.of && o.of > 1 ? `<span>${esc(fill(SETTLE_COPY.of, { n: o.pos, of: o.of }))}</span>` : ""}</div>`;
const where = (c: SettleCase, area?: string) => `<p class="where"><span class="dot a-${area && AREAS.has(area) ? area : "none"}" aria-hidden="true"></span>${esc(displayName(c.page, c.title))}${area ? ` · ${esc(cap(area))}` : ""}</p>`;

// What went wrong with a tap is said in the owner's words, under the sides he tapped (owner's phone,
// 2026-11-02, G628: a check's own words printed at the top of the screen).
export function settlePage(c: SettleCase | undefined, csrf: string, rules: Rules, flash?: string, o: { fresh?: boolean; words?: Record<number, string> } & SettleWhere = {}): string {
  const said = flash ? `<p class="bubble" role="status">${esc(refusalWords(flash).replace(" It still waits for you; dismiss it if it's wrong.", " It still waits here: pick another side, or tell me what's right."))}</p>` : "";
  const near = !!c && !(c.private && !o.fresh);
  // A private value shows only right after a sign-in (spec §8); before that, the question without it.
  const body = !c ? `<p class="quiet">${SETTLE_COPY.gone}</p>` : c.private && !o.fresh ? `${where(c, o.area)}<h1>${esc(fill(SETTLE_COPY.many, { name: displayName(c.page, c.title), attr: c.attr.replace(/_/g, " ") }))}</h1><p class="quiet">${SETTLE_COPY.shut}</p>${signInAgain(csrf)}` : `${where(c, o.area)}<h1>${esc(question(c))}</h1><p class="sub">${esc(c.held ? SETTLE_COPY.held : c.sides.length > 2 ? SETTLE_COPY.subMany : SETTLE_COPY.sub)}</p>
${ordered(c).map((s, i) => row(c, s, csrf, rules, i === 0 && !!s.lean, o.words?.[s.n])).join("")}${said}
<form class="pick both" method="post" action="/action/settle-both">${hidden(csrf, { id: c.id })}<button><b>${c.sides.length > 2 ? SETTLE_COPY.all : SETTLE_COPY.both}</b><small>${SETTLE_COPY.bothSmall}</small></button></form>
<p class="tell">${SETTLE_COPY.orTell}</p>${composer(csrf, { id: c.id }, SETTLE_COPY.box, { label: SETTLE_COPY.box, action: "/action/settle-pick", name: "value", send: SETTLE_COPY.send })}`;
  return appPage(SETTLE_COPY.title, "mind", `${top(o)}
${near ? "" : said}<div class="ask">${body}</div>`, { css: SETTLE_CSS });
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
