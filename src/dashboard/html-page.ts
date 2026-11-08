// SPDX-License-Identifier: AGPL-3.0-only
// A page as the owner reads it (phone UI spec §2.2): the title, what kind of page and how many
// sources, the prose with its numbered references, Mentioned on, Changed (this page's diary lines,
// with Undo), then Details (the facts) and Who sees this, each one row. The box sits at the bottom
// with the page as its subject. Standalone like the home (html-home.ts); fixed words in PAGE_COPY.
import { findOverlaps, assistantOf } from "../overlap";
import type { Note, FactRecord } from "../brain";
import { isList, isDisputed } from "../brain";
import type { State } from "./data";
import type { HomeLine } from "./home";
import type { SayReply } from "../owner-say";
import { wikiBody, wikiLinks } from "./html-brain";
import { displayName, sayDay, sayDays } from "../diary";
import { connections, audience, kindLabel, folderOf, sourceWords } from "./browse";
import { agentTitle, whose, byWhose, cap } from "./labels";
import { refString } from "../sources";
import { keptQuotes, itemRef } from "../quotes";
import { sensitiveShape } from "../shape";
import { esc, hidden, href, line, replyHtml, signInAgain } from "./html-home";
import { appPage, composer } from "./html-app";
import { editedOn, dayWords, yourNotes, NOTE_MAX } from "../page-notes";
import { plain, shutBody, attrWords } from "./home";
import { ownerConflicts } from "../core";
import { inboxConflicts } from "../settle-inbox";
import { MADE } from "../wiki";
import { sensitivityRank } from "../brain";
import { scrubExact } from "../carve";
import { describeCardState, isOrg, whatItIs } from "../describe";
import { siteHost } from "./home";
import { ownerOf, ownerTitle } from "../capture";
import { ownerBook } from "./owner-book";
import { WEEK_CAPS, type Week, type WeekLine } from "../week";
import { sourceWord } from "../wiki";
import { escapeRe, nameAt, initialsOf } from "../util";
import { loadCalendar, meetingsWith, type Meetings } from "../upcoming";

export const PAGE_COPY = {
  back: "Memory",
  next: "Next:",
  disagree: "Two sources disagree · settle",
  sources: "{n} sources",
  oneSource: "1 source",
  mentioned: "Mentioned on",
  sameJob: "May do the same job",
  routine: "routine",
  changed: "What changed",
  details: "Details",
  who: "Who sees this",
  whoName: "Who sees {name}",
  change: "Change who sees it",
  nobody: "Only you.",
  hide: "Hide from {agent}",
  showAgain: "Show to {agent} again",
  sees: "sees it",
  hiddenByYou: "hidden by you",
  cant: "doesn't see it",
  level: "How private",
  levelNote: "A less private level can let more assistants see it. Facts you marked private stay private.",
  save: "Save",
  box: "What changed about {name}?",
  send: "Send",
  empty: "Nothing written here yet. Tell me something about {name}.",
  shut: "private · sign in again to see it",
  inProse: "(private)",
  shutPage: "This page is private. Sign in again to read it.",
  openPrivate: "Only you see this page. It stays open 10 minutes after you sign in.",
  edit: "Edit this page",
  bookNew: "What's new",
  bookNow: "Right now",
  bookMatters: "Who matters",
  bookWaiting: "Waiting on you",
  bookWaits: "{n} things wait for you",
  bookWaitsOne: "1 thing waits for you",
  bookNothing: "Nothing waits for you.",
  weekPast: "Past due",
  weekToday: "Today",
  weekTomorrow: "Tomorrow",
  weekLater: "Coming up",
  weekNext: "What's next",
  weekGoing: "Also going",
  weekQuiet: "Nothing dated in the next 7 days.",
  isDue: "{page} is due",
  wasDue: "{page} was due {day}",
  birthday: "{page}'s birthday",
  calendar: "Calendar",
  editShort: "Edit",
  keepNote: "Keep it as a note",
  editedBy: "Edited by you on {day}.",
  notesHead: "Your notes",
  notesHint: "Only you write here. Your assistants that see this page read it too.",
  notesSave: "Save",
  notesCancel: "Cancel",
  notesSignIn: "Sign in again to edit this page.",
  roleAt: "{role} at {org}",
  lastMet: "Last met {day}",
  nextMeet: "Next: {what}, {day}",
  nextDay: "Next: {day}",
  quarterMeets: "{n} meetings so far this quarter",
  quarterMeet: "1 meeting so far this quarter",
  isThisIt: "Is this it?",
  yesItIs: "Yes, that's it",
  notIt: "Not it",
  fromWeb: "The Gardener found this on the web. Nothing is saved until you say yes.",
  declined: "You said the web's guess wasn't it.",
  askAgain: "Ask again",
  undo: "Undo",
} as const;

// The line the Notion import wrote on an org it made from a free-text field: how the page came to
// be, not what the org is, so the page doesn't show it.
const IMPORT_LINE = /^Created by the Notion import from the free-text Org field\.\s*$/m;

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
// Two inks on a page: the name big, the surname in the headline ink; the role line between two
// rules; footnote numbers as small headline-ink blocks; what links here as one sentence.
export const PAGE_CSS = `
form.notes{display:flex;flex-direction:column;gap:8px;margin:0 0 18px}form.notes label{display:flex;flex-direction:column;gap:2px}form.notes label b{font-weight:900;font-size:15px;text-transform:uppercase}form.notes label small{font-size:14px;line-height:19px;color:var(--muted)}
form.notes textarea{font:inherit;font-size:17px;line-height:24px;color:var(--text);background:var(--paper);border:2px solid var(--text);border-radius:0;padding:10px 12px;min-height:160px;width:100%;resize:vertical}
form.notes .acts{display:flex;gap:18px;align-items:center}
/* The box's answer, pinned with it (G727). */
.pinned .said{max-height:38vh;overflow:auto;background:var(--paper);margin-bottom:6px}.pinned .said .you{display:none}.pinned .said .chips{margin:0 0 6px}
p.edited{font-size:13px;line-height:18px;color:var(--muted);margin:0 0 10px}
.band{display:flex;flex-direction:column;gap:0;margin:0 0 14px}
.band .bar{display:flex;justify-content:space-between;align-items:center;font-size:14px;line-height:20px;font-weight:500}
.band .bar a{font-weight:700;display:inline-flex;align-items:center;min-height:44px}
.band h1{font-size:56px;line-height:.9;margin:12px 0 10px;color:var(--text);mix-blend-mode:normal;max-width:none}
.band h1 span{display:block;color:var(--headline-ink);mix-blend-mode:var(--blend)}
.band .kind{margin:0;font-size:15px;line-height:20px;font-weight:500;border-top:2px solid var(--text);border-bottom:2px solid var(--text);padding:7px 0}
.band .chips{margin:0}.band .chip{font-size:14px;line-height:20px;font-weight:500;color:var(--muted)}
.band .head{display:block}
.prose{font-size:17px;line-height:25px}
.prose a{background:linear-gradient(transparent 60%,color-mix(in srgb,var(--headline-ink) 35%,transparent) 60%)}
.prose h2,.prose h3{font-size:22px;line-height:26px;font-weight:900;letter-spacing:-.02em;margin:22px 0 4px}
.prose sup{line-height:0}
.prose sup a{font-size:10px;line-height:14px;font-weight:800;display:inline-block;min-width:14px;padding:0 3px;margin-left:2px;text-align:center;background:var(--headline-ink);color:var(--on-headline);vertical-align:2px}
.prose ol{padding-left:30px;color:var(--muted);font-size:13px;line-height:18px;list-style:decimal}
.prose ol li{margin:0 0 6px}
.prose details.quote{border:0;margin:0 0 4px}.prose details.quote summary{display:flex;align-items:center;gap:8px;min-height:44px;font-weight:600;color:var(--text);cursor:pointer;list-style:none}.prose details.quote summary::-webkit-details-marker{display:none}.prose details.quote summary::before{content:"+";display:inline-grid;place-items:center;width:18px;height:18px;border:1.5px solid currentColor;font-weight:800;line-height:1}.prose details.quote[open] summary::before{content:"−"}
.prose blockquote{margin:0 0 8px;padding-left:12px;border-left:3px solid var(--marker-ink);color:var(--text)}
a.project{margin:18px 0 0;border-top:2px solid var(--text);border-bottom:2px solid var(--text);padding:10px 0 12px;display:flex;flex-direction:column;gap:6px;color:var(--text)}
.project .nm{font-weight:900;font-size:22px;letter-spacing:-.02em}.project .flag{align-self:flex-start;font-size:13px;line-height:18px;font-weight:800;background:var(--marker-ink);color:var(--on-marker);padding:1px 6px;mix-blend-mode:var(--blend)}
.band .what{margin:0;padding:7px 0;border-bottom:2px solid var(--text);font-size:15px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.band .what a,.describe .said a{text-decoration:underline;text-underline-offset:2px}
.describe{margin:0 0 18px;border-top:2px solid var(--text);border-bottom:2px solid var(--text);padding:10px 0 12px;display:flex;flex-direction:column;gap:8px}
.describe .q{margin:0;font-weight:900;font-size:22px;line-height:26px;letter-spacing:-.02em}
.describe .said{margin:0;font-size:17px;line-height:24px;font-weight:600;overflow-wrap:anywhere}
.describe blockquote{margin:0;padding-left:12px;border-left:3px solid var(--marker-ink);font-size:15px;line-height:22px;color:var(--text);overflow-wrap:anywhere}
.describe .acts{display:flex;gap:10px;flex-wrap:wrap}.describe form{margin:0}
.describe .acts{align-items:center;gap:18px}
.describe button.yes{font:inherit;font-size:16px;font-weight:800;border:0;border-radius:0;padding:0 16px;min-height:44px;background:var(--headline-ink);color:var(--on-headline);cursor:pointer}
.describe .kind{margin:0;font-size:13px;line-height:18px;color:var(--muted)}
.describe.quiet-card{flex-direction:row;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
h2.sec{font-size:22px;line-height:26px;font-weight:900;letter-spacing:-.02em;margin:24px 0 6px}
p.links{margin:0;font-size:16px;line-height:24px}
p.links a{background:linear-gradient(transparent 60%,color-mix(in srgb,var(--headline-ink) 35%,transparent) 60%)}
ul.book{margin:0;padding:0;list-style:none}
h3.day{font-size:13px;line-height:18px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:16px 0 0}
ul.book li{display:flex;gap:12px;align-items:baseline;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:16px;line-height:22px}
ul.book li>span:first-child{min-width:0;flex:1;overflow-wrap:anywhere}
ul.book a{background:linear-gradient(transparent 60%,color-mix(in srgb,var(--headline-ink) 35%,transparent) 60%)}
ul.book .kind{flex:none;max-width:40%;text-align:right;font-size:13px;line-height:18px;color:var(--muted)}
details{border-top:2px solid var(--text);margin:18px 0 0}
details summary{min-height:44px;display:flex;align-items:center;cursor:pointer;font-weight:800}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0 0 16px;font-size:15px;line-height:22px}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
.seen{display:flex;gap:6px 14px;align-items:center;flex-wrap:wrap;margin:16px 0 0;padding:10px 0 0;border-top:2px solid var(--text);font-size:13px;line-height:18px;color:var(--muted)}
.seen b{font-weight:800;color:var(--text)}.seen span{font-weight:500;color:var(--text)}
.wrap.page{padding-bottom:calc(170px + env(safe-area-inset-bottom))}
`;

// A value as text with its [[links]] kept, for wikiLinks to turn into links to their pages.
const linkText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map(linkText).join(", ") : typeof v === "object" ? Object.values(v as object).map(linkText).join(", ") : String(v));

// A private value, or one still held for the owner's Show, shows only after a fresh sign-in.
const shut = (n: Note, r: FactRecord) => !!r.unseen || sensitivityRank(r.sensitivity ?? n.fm.sensitivity) >= sensitivityRank("private");

// The items a shut value cites, or one shaped like money, health or legal: their kept words can
// carry that value, so they open after a fresh sign-in too (G451 under spec §8).
function shutItems(s: State, n: Note): Set<string> {
  const out = new Set<string>();
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    for (const r of isDisputed(f) ? f.candidates : isList(f) ? f.items : [f as FactRecord]) {
      if (r.valid_to || !(shut(n, r) || n.fm.type === "money" || n.fm.id.startsWith("money/") || sensitiveShape(s.rules, attr, r.value))) continue;
      for (const x of r.sources ?? []) out.add(itemRef(refString(x)));
    }
  }
  return out;
}

// A settle side's evidence (audit v8 UX list, G619): the words its source gave that hold the side's
// value, short enough for a phone, under the page's rule: on the 30-day sign-in an item that a
// private, held, money, health or legal fact on the page also cites stays shut (shutItems).
const squashed = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
export const SIDE_WORDS_MAX = 160;
export function sideWords(root: string, rules: State["rules"], n: Note | undefined, refs: string[] | undefined, value: unknown, fresh: boolean): string | undefined {
  const want = squashed(plain(value));
  if (!n || !refs?.length || want.length < 2) return undefined;
  const shutHere = fresh ? new Set<string>() : shutItems({ rules } as State, n);
  for (const ref of refs) {
    if (shutHere.has(itemRef(ref))) continue;
    const q = keptQuotes(root, ref).find((x) => squashed(x).includes(want));
    if (q) return q.length <= SIDE_WORDS_MAX ? q : `${q.slice(0, SIDE_WORDS_MAX - 1).trimEnd()}…`;
  }
  return undefined;
}

// The page's text with every live value that is shut now taken out, as a whole word (carve.ts
// scrubExact), shown as PAGE_COPY.inProse.
function shutInProse(n: Note): string {
  return shutBody(n, PAGE_COPY.inProse);
}

function facts(s: State, n: Note, fresh: boolean): string {
  const rows = Object.entries(n.fm.facts ?? {}).map(([attr, f]) => {
    const live = isDisputed(f) ? [] : isList(f) ? f.items.filter((i) => !i.valid_to) : [f as FactRecord];
    if (!live.length) return "";
    // Each attribute in the owner's words and each day as a person writes it (audit v11).
    const name = esc(cap(attrWords(attr)));
    if (!fresh && live.some((r) => shut(n, r))) return `<dt>${name}</dt><dd class="kind">${PAGE_COPY.shut}</dd>`;
    const v = wikiLinks(s, live.map((r) => sayDays(linkText(r.value))).join(", ")).replace(/href="\/note\//g, 'href="/p/');
    // A date said as "last week" stays a guess: "since around".
    const first = [...live].filter((r) => r.as_of).sort((a, b) => String(a.as_of).localeCompare(String(b.as_of)))[0];
    // A value that is itself that day ("last contact 4 Sep 2026") doesn't say it twice.
    const since = first && !v.includes(sayDay(String(first.as_of))) ? `since ${first.as_of_approx ? "around " : ""}${sayDay(String(first.as_of))}` : "";
    return `<dt>${name}</dt><dd>${v}${since ? ` <span class="kind">${esc(since)}</span>` : ""}</dd>`;
  }).join("");
  return rows ? `<dl>${rows}</dl>` : "";
}

// The owner's yes on a suggestion (approved:) is an approval, not a source: a fact from one web
// page is "1 source".
function sourceCount(n: Note): number {
  const all = new Set<string>();
  for (const f of Object.values(n.fm.facts ?? {})) {
    const recs = isDisputed(f) ? f.candidates : isList(f) ? f.items : [f as FactRecord];
    for (const r of recs) for (const x of r.sources ?? []) if (!refString(x).startsWith("approved:")) all.add(refString(x));
  }
  return all.size;
}

const LEVELS: [string, string][] = [["public", "Public"], ["personal", "Personal"], ["private", "Private: only assistants allowed private pages"], ["secret", "Secret: no assistant"]];

// Who sees this page, and the owner's say on it, here on the page (outside review v5): hide it from
// one assistant by name, show it again (only undoes a hide, never adds a share), or set how private
// the page is (edit.ts hideNoteFrom, showNoteTo, setNoteSensitivity, through the same actions).
function whoSees(s: State, csrf: string, n: Note, closed: boolean): string {
  const id = n.fm.id;
  const seen = audience(s, id).seen;
  const names = seen.map((a) => agentTitle(s.rules, a));
  const first = callName(id, displayName(id, n.fm.title));
  const chips = `<div class="seen"><b>${esc(fill(PAGE_COPY.whoName, { name: first }))}</b>${names.length ? names.map((x) => `<span>${esc(x)}</span>`).join("") : esc(PAGE_COPY.nobody)}</div>`;
  if (closed) return chips;
  const act = (action: string, f: Record<string, string>, label: string) => `<form method="post" action="/action/${action}">${hidden(csrf, f)}<button>${esc(label)}</button></form>`;
  const rows = s.agents.map((a) => {
    const byName = (s.rules.policy.agents[a.name]?.exclude ?? []).includes(id);
    const state = seen.includes(a.name) ? PAGE_COPY.sees : byName ? PAGE_COPY.hiddenByYou : PAGE_COPY.cant;
    const btn = seen.includes(a.name) ? act("note-hide", { id, agent: a.name }, fill(PAGE_COPY.hide, { agent: agentTitle(s.rules, a.name) }))
      : byName ? act("note-show", { id, agent: a.name }, fill(PAGE_COPY.showAgain, { agent: agentTitle(s.rules, a.name) })) : "";
    return `<li class="line"><div class="t">${esc(agentTitle(s.rules, a.name))} · ${esc(state)}</div>${btn}</li>`;
  }).join("");
  const level = `<details><summary>${PAGE_COPY.level}</summary><p class="quiet">${PAGE_COPY.levelNote}</p><form method="post" action="/action/note-sensitivity">${hidden(csrf, { id })}<select name="sensitivity" aria-label="${PAGE_COPY.level}">${LEVELS.map(([v, l]) => `<option value="${v}"${v === n.fm.sensitivity ? " selected" : ""}>${esc(l)}</option>`).join("")}</select> <button>${PAGE_COPY.save}</button></form></details>`;
  return `${chips}<details id="who"><summary>${PAGE_COPY.change}</summary>${rows ? `<ul>${rows}</ul>` : ""}${level}</details>`;
}

// The page's open question as a card (the brief's Person board): what's next, and a conflict on the
// page with its way to settle. A value shows only where Details would show it.
function projectCard(s: State, n: Note, fresh: boolean): string {
  const id = n.fm.id;
  const open = [...ownerConflicts(s.root, s.now), ...inboxConflicts(s.root)].find((c) => c.page === id);
  const f = n.fm.facts?.next_step;
  const r = f && !isDisputed(f) && !isList(f) ? f as FactRecord : undefined;
  const next = r && !r.valid_to && (fresh || !shut(n, r)) ? plain(r.value, (x) => { const t = s.notes.find((m) => m.fm.id === x)?.fm.title; return t === undefined ? undefined : String(t); }) : "";
  if (!open && !next) return "";
  const inner = `<span class="nm">${esc(displayName(id, n.fm.title))}</span>${next ? `<span>${PAGE_COPY.next} ${esc(next)}</span>` : ""}${open ? `<span class="flag">${PAGE_COPY.disagree}</span>` : ""}`;
  return open ? `<a class="project" href="/settle/${esc(open.id)}">${inner}</a>` : `<div class="project">${inner}</div>`;
}

export function areaChip(s: State, n: Note, area: string, line: string | undefined): string {
  if (!area) return "";
  const label = String(s.rules.policy.areas?.[area]?.label ?? "").trim();
  const chip = label || (area.length <= 3 ? area.toUpperCase() : area.charAt(0).toUpperCase() + area.slice(1));
  // The orgs the chip could repeat: the org fact, linked or in plain words, the page itself when
  // it is an org, and any org filed in this area (area follows the org fact), so a role alone that
  // names it counts too (use-it on the Mac, 2026-11-08; G736).
  const f = n.fm.facts?.org;
  const r = f && !isDisputed(f) && !isList(f) ? f as FactRecord : undefined;
  const v = String(r?.value ?? "");
  const orgId = v.match(/\[\[([^\]|]+)/)?.[1]?.trim();
  const names = [orgId ? s.notes.find((x) => x.fm.id === orgId)?.fm.title : v.includes("[[") ? undefined : v, n.fm.type === "org" ? n.fm.title : undefined,
    ...s.notes.filter((x) => x.fm.type === "org" && String(x.fm.area ?? "") === area).map((x) => x.fm.title)].map((x) => String(x ?? "").trim()).filter(Boolean);
  const said = (x: string) => !!line && nameAt(line, x) >= 0;
  return names.some((o) => (said(o) || o === n.fm.title) && (chip.toLowerCase() === o.toLowerCase() || chip === initialsOf(o))) ? "" : chip;
}

// What a person does, under their name (canvas Person board: "QA lead at Harbourline · Montréal"):
// their role, where they work, their city, each only where Details would show it. None known: the
// page's kind and sources, as before.
function personLine(s: State, n: Note, fresh: boolean, closed: boolean): string | undefined {
  if (closed || folderOf(n.fm.id) !== "people") return undefined;
  const one = (attr: string) => {
    const f = n.fm.facts?.[attr];
    const r = f && !isDisputed(f) && !isList(f) ? f as FactRecord : undefined;
    return r && !r.valid_to && (fresh || !shut(n, r)) ? plain(r.value, (x) => { const t = s.notes.find((m) => m.fm.id === x)?.fm.title; return t === undefined ? undefined : String(t); }) : "";
  };
  const [role, org, city] = [one("role"), one("org"), one("city")];
  // A role that already names its org says it once (owner's phone, 2026-11-07; G731).
  const what = role && org ? (nameAt(role, org) >= 0 ? role : fill(PAGE_COPY.roleAt, { role, org })) : role || org;
  return [what, city].filter(Boolean).join(" · ") || undefined;
}

// When you last met and will next meet someone, and how often this quarter, from the calendar you
// connected (G694): read from its cache each time the page is drawn, never written to the brain
// and never a card. A meeting from a private calendar shows only right after a sign-in.
function meetings(s: State, n: Note, fresh: boolean, closed: boolean): Meetings | undefined {
  if (closed || folderOf(n.fm.id) !== "people") return undefined;
  const day = s.now.toISOString().slice(0, 10);
  return meetingsWith(n, loadCalendar(s.root, day), day, (e) => fresh || sensitivityRank(e.sensitivity ?? "personal") < sensitivityRank("private"));
}
function meetLine(s: State, m: Meetings | undefined, fresh: boolean): string {
  if (!m) return "";
  const year = s.now.toISOString().slice(0, 4);
  const say = (d: string) => sayDay(d.slice(0, 10)).replace(` ${year}`, "");
  // A title shaped like health, money or legal names only its day on the 30-day sign-in (G696).
  const next = m.next && (fresh || !sensitiveShape(s.rules, m.next.summary)) ? fill(PAGE_COPY.nextMeet, { what: m.next.summary, day: say(m.next.start) }) : m.next ? fill(PAGE_COPY.nextDay, { day: say(m.next.start) }) : "";
  const parts = [
    m.last ? fill(PAGE_COPY.lastMet, { day: say(m.last.start) }) : "",
    next,
    m.quarter > 1 ? fill(PAGE_COPY.quarterMeets, { n: String(m.quarter) }) : m.quarter === 1 ? PAGE_COPY.quarterMeet : "",
  ].filter(Boolean);
  return parts.length ? `<p class="kind meet">${esc(parts.join(" · "))}</p>` : "";
}

// The page never says "Last met 2 Oct" over prose saying "last in touch 24 Sep" (G696): when the
// calendar holds a meeting after the stored last contact (the nightly capture lags), the line wins
// and the stale sentence leaves the page as drawn. The brain itself is never changed.
export function dropStaleContact(text: string, n: Note, m: Meetings | undefined): string {
  const f = n.fm.facts?.last_contact;
  const r = f && !isDisputed(f) && !isList(f) ? f as FactRecord : undefined;
  const held = r ? String(r.value ?? "").match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? String(r.as_of ?? "").slice(0, 10) : "";
  if (!m?.last || !held || m.last.start.slice(0, 10) <= held) return text;
  return text.replace(/ ?[^.!?\n\]]*[.!?](?:\[\^[^\]\s]+\])*\[\^pf-last-contact\](?:\[\^[^\]\s]+\])*/g, "");
}

const AREAS = new Set(["work", "teaching", "personal"]);

// What the box and Who sees call a page: a person by their first name, anything else by its whole
// title (Mac, 2026-10-31: "What changed about Atlas?" on Atlas launch).
const callName = (id: string, name: string) => folderOf(id) === "people" ? name.split(/\s+/)[0]! : name;

// An org's line under its title, once it has one: what it is, and its site as a link.
function orgLine(s: State, n: Note, fresh: boolean): string {
  if (!isOrg(n)) return "";
  const r = whatItIs(n);
  if (!r || (!fresh && shut(n, r))) return "";
  const w = n.fm.facts?.website;
  const site = w && !isDisputed(w) && !isList(w) && !(w as FactRecord).valid_to && (fresh || !shut(n, w as FactRecord)) ? String((w as FactRecord).value ?? "") : "";
  const link = /^https:\/\//.test(site) ? ` · <a href="${esc(site)}" rel="noopener noreferrer nofollow" target="_blank">${esc(siteHost(site))}</a>` : "";
  return `<p class="what">${esc(plain(r.value, () => undefined))}${link}</p>`;
}

// The Gardener's suggestion for an org (src/describe.ts): the line, the site and the site's own
// sentence, with Yes and Not it; after Not it, a way to let it look again.
function describeCard(s: State, csrf: string, n: Note): string {
  const { waiting, declined } = describeCardState(s.root, n);
  const act = (action: string, label: string, cls = "") => `<form method="post" action="/action/${action}">${hidden(csrf, { id: n.fm.id })}<button${cls ? ` class="${cls}"` : ""}>${esc(label)}</button></form>`;
  if (declined) return `<div class="describe quiet-card"><p class="kind">${PAGE_COPY.declined}</p>${act("org-again", PAGE_COPY.askAgain, "pill")}</div>`;
  if (!waiting) return "";
  return `<div class="describe"><p class="q">${PAGE_COPY.isThisIt}</p><p class="said">${esc(waiting.what_it_is)} · <a href="${esc(waiting.website)}" rel="noopener noreferrer nofollow" target="_blank">${esc(siteHost(waiting.website))}</a></p><blockquote>${esc(waiting.quote)}</blockquote><div class="acts">${act("org-yes", PAGE_COPY.yesItIs, "yes")}${act("org-no", PAGE_COPY.notIt, "pill")}</div><p class="kind">${PAGE_COPY.fromWeb}</p></div>`;
}

// The owner's own page as the front of a book about them (owner-book.ts): what's new, right now,
// who matters, what waits. A line names its page as a link only where the line already says the
// page's name, so a line about a page only the owner can see never puts its id in a link.
function bookSections(s: State, fresh: boolean): string {
  const b = ownerBook(s, fresh);
  const title = (n: Note) => displayName(n.fm.id, n.fm.title);
  const link = (n: Note) => `<a href="${href(n.fm.id)}">${esc(title(n))}</a>`;
  const news = b.news.map((l) => {
    // The home says a person by first name ("Antoine is head TA now"): the full name, else that.
    const n = s.notes.find((x) => x.fm.id === l.page), what = esc(l.what);
    const at = (x: string) => new RegExp(`(^|[^\\p{L}])(${escapeRe(x)})(?![\\p{L}])`, "u");
    const name = n ? [esc(title(n)), esc(title(n).split(/\s+/)[0]!)].find((x) => x && at(x).test(what)) : undefined;
    const said = n && name ? what.replace(at(name), `$1<a href="${href(n.fm.id)}">$2</a>`) : what;
    return `<li><span>${said}</span><span class="kind">${esc(l.from)}</span></li>`;
  });
  const waits = b.waiting === 0 ? esc(PAGE_COPY.bookNothing) : `<a href="/home">${esc(b.waiting === 1 ? PAGE_COPY.bookWaitsOne : fill(PAGE_COPY.bookWaits, { n: b.waiting }))}</a>.`;
  return [
    news.length ? `<h2 class="sec">${PAGE_COPY.bookNew}</h2><ul class="book">${news.join("")}</ul>` : "",
    weekSection(s, b.week, b.now, link),
    b.matters.length ? `<h2 class="sec">${PAGE_COPY.bookMatters}</h2><p class="links">${b.matters.map(link).join(" · ")}</p>` : "",
    `<h2 class="sec">${PAGE_COPY.bookWaiting}</h2><p class="links">${waits}</p>`,
  ].join("");
}

// Right now is the week (src/week.ts; Louis 2026-11-06): what went past its due date, each of the
// coming seven days that has something, later this month, the next steps with no date, then the
// projects still going. A line names its page as a link; the right column says where it came from.
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function dayLabel(day: string, from: string): string {
  if (day === from) return PAGE_COPY.weekToday;
  if (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) === 864e5) return PAGE_COPY.weekTomorrow;
  const said = sayDay(day).replace(/ \d{4}$/, "");
  return `${WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${said}`;
}
function weekSection(s: State, w: Week, going: Note[], link: (n: Note) => string): string {
  const byId = new Map(s.notes.map((n) => [n.fm.id, n]));
  const page = (l: WeekLine) => (l.page ? byId.get(l.page) : undefined);
  const from = (l: WeekLine) => l.event ? PAGE_COPY.calendar : sourceWord(refString(l.record?.sources?.[0] ?? "") || "");
  const text = (l: WeekLine, past = false): string => {
    const n = page(l), a = n ? link(n) : "";
    const time = l.time ? `${esc(l.time)} ` : "";
    if (l.kind === "event") {
      // The event's own words, the page they name a link inside them, else after them.
      const t = n ? displayName(n.fm.id, n.fm.title) : "";
      const m = t ? new RegExp(`(^|[^\\p{L}])(${escapeRe(esc(t))})(?![\\p{L}])`, "iu") : undefined;
      const words = esc(l.what);
      return time + (m && m.test(words) ? words.replace(m, (_x, pre: string, name: string) => `${pre}<a href="${href(n!.fm.id)}">${name}</a>`) : n ? `${words} · ${a}` : words);
    }
    if (!n) return "";
    if (l.kind === "due") return time + (past ? fill(PAGE_COPY.wasDue, { page: a, day: esc(sayDay(l.day!).replace(/ \d{4}$/, "")) }) : fill(PAGE_COPY.isDue, { page: a }));
    if (l.kind === "birthday") return fill(PAGE_COPY.birthday, { page: a });
    return `${time}${a}: ${esc(sayDays(l.what))}`;
  };
  const list = (ls: WeekLine[], cap: number, f: (l: WeekLine) => string) => {
    const li = ls.map((l) => [f(l), l] as const).filter(([t]) => t).slice(0, cap).map(([t, l]) => `<li><span>${t}</span><span class="kind">${esc(from(l))}</span></li>`);
    return li.length ? `<ul class="book">${li.join("")}</ul>` : "";
  };
  const group = (head: string, body: string) => (body ? `<h3 class="day">${esc(head)}</h3>${body}` : "");
  const later = (l: WeekLine) => { const t = text(l); return t && l.kind !== "next" ? `${t} · ${esc(sayDay(l.day!).replace(/ \d{4}$/, ""))}` : t; };
  const parts = [
    group(PAGE_COPY.weekPast, list(w.past, WEEK_CAPS.past, (l) => text(l, true))),
    ...w.days.map((d) => group(dayLabel(d.day, w.from), list(d.lines, WEEK_CAPS.day, (l) => text(l)))),
    group(PAGE_COPY.weekLater, list(w.later, WEEK_CAPS.later, later)),
    group(PAGE_COPY.weekNext, list(w.next, WEEK_CAPS.next, (l) => text(l))),
  ].filter(Boolean);
  const quiet = parts.length ? "" : `<p class="links">${esc(PAGE_COPY.weekQuiet)}</p>`;
  // The projects still going that no line above already names.
  const named = new Set([w.past, ...w.days.map((d) => d.lines), w.later, w.next].flat().map((l) => l.page));
  const others = going.filter((n) => !named.has(n.fm.id));
  const rest = others.length ? `<h3 class="day">${esc(PAGE_COPY.weekGoing)}</h3><p class="links">${others.map(link).join(" · ")}</p>` : "";
  return `<h2 class="sec">${PAGE_COPY.bookNow}</h2>${parts.join("")}${quiet}${rest}`;
}

export function ownerPage(s: State, csrf: string, n: Note, lines: HomeLine[], o: { said?: string; reply?: SayReply; flash?: string; undo?: string; fresh?: boolean; edit?: boolean } = {}): string {
  const fresh = !!o.fresh, closed = !fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private");
  const name = displayName(n.fm.id, n.fm.title);
  const first = callName(n.fm.id, name);
  const count = sourceCount(n);
  const held = fresh ? new Set<string>() : shutItems(s, n);
  let withheld = false;
  // The prose was written when its facts were; a value private now is never in it on the 30-day
  // sign-in, whatever it was then (audit v7, G551).
  const met = meetings(s, n, fresh, closed);
  const text = dropStaleContact(fresh ? n.body : shutInProse(n), n, met);
  const prose = wikiBody(s, isOrg(n) ? text.replace(IMPORT_LINE, "") : text, (ref) => {
    if (!held.has(itemRef(ref))) return keptQuotes(s.root, ref);
    withheld ||= keptQuotes(s.root, ref).length > 0;
    return [];
  }, 2, true).replace(/href="\/note\//g, 'href="/p/').replace(/(class="b-ref">)\[(\d+)\]/g, "$1$2").replace(/\s+(<sup>)/g, "$1");
  const c = connections(s, n);
  // What links here, as one sentence of links.
  const mentioned = c.mentionedIn.length ? `<h2>${PAGE_COPY.mentioned}</h2><p class="links">${c.mentionedIn.map((x) => `<a href="${href(x.fm.id)}">${esc(displayName(x.fm.id, x.fm.title))}</a>`).join(", ")}.</p>` : "";
  const who = whoSees(s, csrf, n, closed);
  const details = closed ? "" : facts(s, n, fresh);
  const open = fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private") ? `<p class="kind">${PAGE_COPY.openPrivate}</p>` : "";
  const body = open + (closed ? `<p class="quiet">${PAGE_COPY.shutPage}</p>${signInAgain(csrf)}` : details.includes(PAGE_COPY.shut) || withheld ? `${proseOrEmpty()}${signInAgain(csrf)}` : proseOrEmpty());
  // When the owner last changed this page's own notes by hand (G718).
  const edited = closed ? undefined : editedOn(s.root, n.fm.id, n);
  const editedLine = edited ? `<p class="kind edited">${esc(fill(PAGE_COPY.editedBy, { day: dayWords(edited) }))}</p>` : "";
  const editor = !o.edit || closed ? "" : fresh
    ? `<form class="notes" method="post" action="/action/page-notes-save">${hidden(csrf, { id: n.fm.id })}<label for="notes"><b>${PAGE_COPY.notesHead}</b><small>${PAGE_COPY.notesHint}</small></label><textarea id="notes" name="text" rows="8" maxlength="${NOTE_MAX}">${esc(yourNotes(n.body))}</textarea><div class="acts"><button class="pill solid">${PAGE_COPY.notesSave}</button><a class="pill" href="${href(n.fm.id)}">${PAGE_COPY.notesCancel}</a></div></form>`
    : `<p class="quiet">${PAGE_COPY.notesSignIn}</p>${signInAgain(csrf)}`;
  // A sentence the box caught no fact in can be kept as the owner's note on this page (G719).
  const keep = !closed && o.said && o.reply?.kind === "say.didnt-catch" ? `<div class="chips"><form method="post" action="/action/page-note">${hidden(csrf, { id: n.fm.id, text: o.said })}<button>${PAGE_COPY.keepNote}</button></form></div>` : "";
  function proseOrEmpty() { return prose.trim() ? `<div class="prose">${prose}</div>` : `<p class="quiet">${esc(fill(PAGE_COPY.empty, { name: first }))}</p>`; }
  const area = String(n.fm.area ?? "");
  // The area's chip: its label in policy, a short slug ("ov") in capitals, never a lone "Ov"; none
  // when it only repeats the org the line under the name already says (owner's phone, 2026-11-07;
  // G732).
  const chip = areaChip(s, n, area, personLine(s, n, fresh, closed));
  // A routine says whose it is: "Town's routine" (owner, 2026-11-03: "which agent does what").
  const runsIn = (x: Note) => x.fm.type === "capability" && assistantOf(x.fm.id) ? agentTitle(s.rules, assistantOf(x.fm.id)) : undefined;
  const kind = runsIn(n) ? `${whose(runsIn(n)!)} ${PAGE_COPY.routine}` : String(n.fm.type ?? kindLabel(folderOf(n.fm.id)));
  // A person's name in two lines, the surname in the headline ink; anything else in one.
  const words = name.split(/\s+/);
  const title = folderOf(n.fm.id) === "people" && words.length > 1 ? `${esc(words[0]!)} <span>${esc(words.slice(1).join(" "))}</span>` : esc(name);
  // Edit opens the page's own notes (G718), right after a sign-in only.
  const editHref = `${href(n.fm.id)}?edit=1`;
  const band = `<header class="band${AREAS.has(area) ? ` t-${area}` : ""}"><div class="bar"><a href="/memory">‹ ${PAGE_COPY.back}</a>${closed ? "" : `<a href="${editHref}" aria-label="${PAGE_COPY.edit}">${PAGE_COPY.editShort}</a>`}</div>
<div class="head"><div><h1>${title}</h1><p class="kind">${esc(personLine(s, n, fresh, closed) ?? `${kind} · ${count === 1 ? PAGE_COPY.oneSource : fill(PAGE_COPY.sources, { n: count })}`)}</p>${closed ? "" : orgLine(s, n, fresh)}${meetLine(s, met, fresh)}</div></div>${chip ? `<div class="chips"><span class="chip">${esc(chip)}</span></div>` : ""}</header>`;
  const book = !closed && n.fm.id === ownerOf(s.rules, s.notes, ownerTitle(s.rules) ?? "")?.page ? bookSections(s, fresh) : "";
  const changedList = lines.length ? `<h2 class="sec">${PAGE_COPY.changed}</h2><ul>${lines.map((l) => line(l, csrf, n.fm.id)).join("")}</ul>` : "";
  // Routines that may do the same job as this one (G641): the others, linked; a secret page only
  // right after a sign-in, like Memory.
  const sameJob = closed || n.fm.type !== "capability" ? [] : (findOverlaps(s.notes).find((g) => g.ids.includes(n.fm.id))?.ids ?? [])
    .filter((id) => id !== n.fm.id).map((id) => s.notes.find((x) => x.fm.id === id)!).filter((x) => x && (fresh || x.fm.sensitivity !== "secret"));
  const overlapList = sameJob.length ? `<h2 class="sec">${PAGE_COPY.sameJob}</h2><p class="links">${byWhose(sameJob.map((x) => ({ who: runsIn(x), html: `<a href="${href(x.fm.id)}">${esc(displayName(x.fm.id, x.fm.title))}</a>` })), esc)}.</p>` : "";
  const mentionedList = mentioned.replace(`<h2>${PAGE_COPY.mentioned}</h2>`, `<h2 class="sec">${PAGE_COPY.mentioned}</h2>`);
  // Undo after an answer to the Gardener's line on an org: only that org's own answer (org-undo).
  const undoOrg = o.flash && o.undo && isOrg(n) ? `<div class="chips"><form method="post" action="/action/org-undo">${hidden(csrf, { id: n.fm.id, hash: o.undo })}<button>${PAGE_COPY.undo}</button></form></div>` : "";
  // What the box answered sits with the box, where the owner is looking, not at the page's foot
  // behind it: the page comes back at its top, with what changed already in it (G727).
  const said = `${replyHtml(csrf, { ...o, page: n.fm.id })}${keep}${undoOrg}`;
  const pinned = `<div class="pinned">${said ? `<div class="said">${said}</div>` : ""}${composer(csrf, { page: n.fm.id }, fill(PAGE_COPY.box, { name: first }), { label: fill(PAGE_COPY.box, { name: first }), send: PAGE_COPY.send })}</div>`;
  return appPage(name, "memory", `${band}
${closed ? "" : describeCard(s, csrf, n)}${editor}${editedLine}${body}${closed ? "" : projectCard(s, n, fresh)}${book}${changedList}${overlapList}${mentionedList}
${details ? `<details><summary>${PAGE_COPY.details}</summary>${details}</details>` : ""}${who}
${pinned}`, { css: PAGE_CSS, wrap: "page" });
}

// Ask's answer about a page (audit v7: Ask answered with a list of facts): the page's own opening
// prose, its links kept, and what it cites as chips (the page, the pages it names, how many
// sources). Worked out when Ask is drawn, from the page as it is then, with the same rule as the
// page: a private page answers nothing before a fresh sign-in. No new read: it is the page the box
// already answered from.
export interface AskProse { html: string; cites: { href: string; label: string }[] }
export function askProse(s: State, n: Note, fresh: boolean): AskProse | undefined {
  if (!fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private")) return undefined;
  // The page's opening: someone's own paragraph and the hub's sentences beneath it under "From its
  // facts" (G682), or the hub's alone; never a later section.
  const top = (fresh ? n.body ?? "" : shutInProse(n)).replace(/^## From its facts\n/m, "").split(/^#{1,6} /m)[0]!.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith("[^") && x !== MADE).slice(0, 2).join("\n\n") || undefined;
  if (!top) return undefined;
  const notes = new Set((top.match(/\[\^[^\]\s]+\]/g) ?? []));
  const text = top.replace(/\[\^[^\]\s]+\]/g, "").split(MADE).join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const html = wikiLinks(s, text).replace(/href="\/note\//g, 'href="/p/').replace(/ class="mono"/g, "").replace(/ title="[^"]*"/g, "");
  const linked = [...new Set([...html.matchAll(/href="\/p\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1]!)))].filter((id) => id !== n.fm.id).slice(0, 2);
  const title = (id: string) => displayName(id, s.notes.find((x) => x.fm.id === id)?.fm.title);
  const count = sourceCount(n) || notes.size;
  return { html, cites: [{ href: href(n.fm.id), label: displayName(n.fm.id, n.fm.title) }, ...linked.map((id) => ({ href: href(id), label: title(id) })), ...(count ? [{ href: href(n.fm.id), label: count === 1 ? PAGE_COPY.oneSource : fill(PAGE_COPY.sources, { n: count }) }] : [])] };
}

// An Ask answer that is one fact (G706): the sentence, then the page and where the fact came from,
// in words and its day, as the page's own Details say it.
export function askFact(s: State, n: Note, key: string, text: string, fresh: boolean): AskProse | undefined {
  if (!fresh && sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private")) return undefined;
  const f = n.fm.facts?.[key];
  if (!f) return undefined;
  const r = (isList(f) ? f.items.filter((i) => !i.valid_to).at(-1) : f) as FactRecord | undefined;
  const from = r ? sourceWords(r.sources) : "";
  const t = r?.as_of ? Date.parse(`${String(r.as_of).slice(0, 10)}T12:00:00Z`) : NaN;
  const day = Number.isNaN(t) ? "" : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return { html: esc(text), cites: [{ href: href(n.fm.id), label: displayName(n.fm.id, n.fm.title) }, ...(from ? [{ href: href(n.fm.id), label: `From ${from}${day ? `, ${day}` : ""}` }] : [])] };
}
