// SPDX-License-Identifier: AGPL-3.0-only
// The owner's home (phone UI spec §2.1, owner 2026-10-26): a greeting, the text box, what waits on
// the owner (only real conflicts so far), and the diary of what the brain learned, newest day first,
// each line with Undo. Built from diary/*.jsonl (src/diary.ts), never from git log. The page itself is
// html-home.ts; the words are the owner's (test/owner-copy.test.ts).
import { ownerAsks, type OwnerAsks } from "../waiting";
import { waitingTeachAsks } from "../teaching";
import { waitingLinkAsks } from "../dangling";
import { HOME_COPY } from "./html-home";
import { dateWordForms, sha256 } from "../util";
import type { Note } from "../brain";
import { isDisputed, sensitivityRank, loadBrain, type Sensitivity } from "../brain";
import { records, scrubExact } from "../carve";
import { needleFor, findCarried, type Needle } from "../match";
import type { Rules } from "../rules";
import { ownerName, ownAssistant } from "../rules";
import { isOwnerId } from "../owner";
import { readDiary, shownValue, displayName, sayDay, sayDays, ID_IN_TEXT, type DiaryRow } from "../diary";
import { ownerLocal } from "../clock";
import { ownerConflicts, type SettleCase } from "../core";
import { unseenFacts, keptFacts, type Unseen } from "../seen";
import { inboxConflicts } from "../settle-inbox";
import { comms } from "./data";
import { agentLabel, agentTitle, cap } from "./labels";
import { loadRules } from "../rules";
import { readEntriesSince, type ReadEntry } from "../readlog";
import type { WrongLine } from "./home-beliefs";
import { ownerDay, clock } from "../clock";
import { sensitiveShape, sensitiveName } from "../shape";
import type { Mark } from "./marks";
import { yourToDo } from "../wiki";
import { lateJobs, lateLine } from "../heartbeat";
import { quietAssistants, quietLine, quietWords } from "../quiet";
// Settings, where what the home doesn't list itself waits (the dashboard's overview).
export const SETTINGS_HREF = "/overview#needs";

export interface HomeLine {
  token: string;
  page: string; // note id the line opens
  what: string; // the line, in plain words
  from: string; // where from and the day: "from an email, Mon"
  was?: string; // the value before, when there was one
  undo: "undo" | "changed" | "undone" | "none";
  maybe: boolean; // a guess (inferred): "Maybe:" first
  shapeless: boolean; // private: the line says only that something is new
  key?: string; // the fact a filed line is about, for its marks (marks.ts); none for a held or set-aside one
  held?: boolean; // its value waits for the owner's Show: a lock, never marks
  just?: boolean; // the owner said it in the last hour: it leads the mind, drawn as just told
  marks?: Mark[]; // one per assistant, added by the dashboard (withMarks in marks.ts)
  said?: string; // where it came from as the canvas says it: "From Wednesday's email", "You said so today"
  attr?: string; // the attribute, for which lines lead the face (faceLines)
  kind?: string; // the diary row's kind, likewise
}
export interface Waiting { what: string; verb: string; href: string; n?: number; teach?: string; link?: string; choices?: { label: string; answer: string }[]; seen?: string; look?: string[]; stranger?: boolean; meta?: string; parts?: string[] } // look: each held value as a sentence, only on a fresh sign-in (G630) // parts: the values that disagree, in the order the sentence says them, for the highlighter; meta: the small line under a conflict ("Two emails disagree") // teach: a teaching question's key, for its three taps (teachKey); seen: a held fact's key, for its Show button; stranger: from an address the pages don't hold
// reads: each assistant (its policy key and the name the owner knows it by) and how many times it read the brain since the owner's midnight.
// wrong, more, sees, of, seeHref: the belief radar and See as for that assistant (home-beliefs.ts), added by the dashboard.
export interface HomeView { all?: boolean; name: string; date: string; reads: { agent: string; name: string; today: number; quiet?: string; asked?: AskLine[]; askedMore?: number; wrong?: WrongLine[]; more?: number; sees?: number; of?: number; seeHref?: string }[]; waiting: Waiting[]; gardener: Waiting[]; since: HomeLine[]; folded: number; earlier: { day: string; lines: HomeLine[] }[]; earlierFolded: number; late?: string; quiet?: string }

export const SINCE_CAP = 7;
// The face of On your mind (canvas "final direction", Louis 2026-10-31: the home was a log): six
// cards at most, what waits first, then the memories worth acting on; the rest a tap away.
export const MIND_CAP = 6;
const MIND_MIN_MEMORIES = 2;
// Held values shown one by one on the home before the rest fold into one line.
export const HELD_EACH = 3;
const JUST_SAID_MS = 60 * 60_000;
// Earlier days on one phone screen: the last few days, a few lines each; the rest behind Show more.
export const EARLIER_DAYS = 3;
export const EARLIER_PER_DAY = 5;
const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (iso: string) => ownerLocal(iso).slice(0, 10);
const weekday = (day: string) => WEEKDAY[new Date(`${day}T12:00:00Z`).getUTCDay()]!;
const longDay = (day: string) => `${weekday(day)} ${Number(day.slice(8, 10))} ${MONTH[Number(day.slice(5, 7)) - 1]}`;
// An attribute in the owner's words: its name with spaces, but "next step" is the next thing to do.
const OWNER_WORDS: Record<string, string> = { next_step: "next thing to do", org: "workplace" };
const words = (attr: string) => OWNER_WORDS[attr] ?? attr.replace(/[_-]+/g, " ");
export const attrWords = words;
// An attribute that is itself a verb reads as a sentence: "Jane Roy prefers long novels", never
// "prefers is long novels" (G512).
const VERB_ATTRIBUTES = new Set(["prefers", "works_with", "works_on"]);
export const isVerbAttribute = (attr: string) => VERB_ATTRIBUTES.has(attr);
// A value as words: a [[link]] shows its label, else the linked page's name; a bare page id in
// the text shows the page's name too. Never an id.
export const plain = (v: unknown, title?: (id: string) => string | undefined, slugs?: Map<string, string>): string => {
  const name = (id: string) => displayName(id, title?.(id));
  if (v === undefined || v === null) return "";
  if (typeof v === "string") {
    // A value that is only a page's slug ("bay-institute") is that page.
    const bare = slugs?.get(v.trim());
    if (bare) return name(bare);
    if (/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return sayDay(v);
    const text = v.replace(/\[\[([^\]|]*?)(?:\|([^\]]+))?\]\]/g, (_m, id: string, label?: string) => label ?? name(id)).replace(ID_IN_TEXT, (id) => name(id))
      // a page's slug inside a sentence ("moved to bay-institute") is that page
      .replace(/(?<![\w/-])[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\w/-])/g, (w) => { const id = slugs?.get(w); return id ? name(id) : w; })
      // a day inside a sentence reads as "12 Oct 2026" too
      .replace(/(?<![\w/-])\d{4}-\d{2}-\d{2}(?![\w-])/g, (d) => sayDays(d));
    // a value that is only a slug of no page ("coach-tennis") reads as its words
    return /^[a-z]+(?:-[a-z]+)+$/.test(text.trim()) ? text.trim().replace(/-/g, " ") : text;
  }
  if (Array.isArray(v)) return v.map((x) => plain(x, title, slugs)).join(", ");
  if (typeof v === "object") return Object.values(v as object).map((x) => plain(x, title, slugs)).join(", ");
  return String(v);
};
// slug -> page id, for slugs that name exactly one page.
export function slugMap(notes: Iterable<Note>): Map<string, string> {
  const seen = new Map<string, string | null>();
  for (const n of notes) { const slug = n.fm.id.split("/").pop()!; seen.set(slug, seen.has(slug) ? null : n.fm.id); }
  return new Map([...seen].filter((e): e is [string, string] => !!e[1]));
}

export function fromWords(row: Pick<DiaryRow, "source_word" | "by"> & Partial<Pick<DiaryRow, "why">>, rules: Rules): string {
  // A fact the hub set aside itself says so, never where the fact came from (G673).
  if (row.why === "receipt" || row.why === "machine") return "set aside by your brain";
  switch (row.source_word) {
    // The owner's own write; an assistant passing on what the owner told it says so (audit v4).
    case "you": return !row.by || isOwnerId(row.by) ? "you said" : `you told your ${rules.policy.agents[row.by]?.label ?? row.by}`;
    case "email": return "from an email";
    case "calendar": return "from calendar";
    case "notion": return "from your Notion";
    case "assistant": return `from your ${rules.policy.agents[row.by]?.label ?? row.by}`;
    case "none": return `from your ${rules.policy.agents[row.by]?.label ?? row.by}`;
    default: return `from ${row.source_word}`;
  }
}

const slugCache = new WeakMap<Map<string, Note>, Map<string, string>>();
const slugsOf = (notes: Map<string, Note>) => { let m = slugCache.get(notes); if (!m) slugCache.set(notes, m = slugMap(notes.values())); return m; };

// The memories in the owner's words (owner app brief, 2026-10-30): each line is a sentence, never
// "Page: attribute is now value". {title}'s takes the apostrophe alone after a final s.
export const LINE_COPY = {
  new: "{title}'s {attr} is {value}",
  changed: "{title}'s {attr} is now {value}",
  settled: "You settled it: {title}'s {attr} is {value}",
  nextNew: "Next for {title}: {value}",
  nextChanged: "Next for {title}: {value}",
  nextSettled: "You settled what's next for {title}: {value}",
  contactNew: "You were last in touch with {title} on {value}",
  contactChanged: "You were last in touch with {title} on {value}",
  contactSettled: "You settled it: you were last in touch with {title} on {value}",
  roleNew: "{title}'s role is {value}",
  orgNew: "{title} works at {value}",
  orgChanged: "{title} works at {value} now",
  orgSettled: "You settled it: {title} works at {value}",
  roleChanged: "{title} is {value} now",
  roleChangedFrom: "{title} is {value} now, not {was}",
  roleSettled: "You settled it: {title} is {value}",
  siteNew: "{title}'s site is {value}",
  siteChanged: "{title}'s site is now {value}",
  siteSettled: "You settled it: {title}'s site is {value}",
  kindNew: "{title} is filed under {value}",
  kindChanged: "{title} is filed under {value} now",
  kindSettled: "You settled it: {title} is filed under {value}",
  verbNew: "{title} {attr} {value}",
  verbChanged: "{title} now {attr} {value}",
  verbSettled: "You settled it: {title} {attr} {value}",
  verbKept: "{older} {title} {attr} {value}; I kept your word",
  itemAdded: "Added to {title}'s {attr}: {value}",
  retracted: "{title}'s {attr} was taken back",
  keptYours: "{title}'s {attr} was {value} earlier, kept as history",
  kept: "{older} {title}'s {attr} is {value}; I kept your word",
  undone: "You undid the change to {title}'s {attr}",
  confirmed: "Another {source} confirms {title}'s {attr}",
  saidAgain: "{title}'s {attr} was said again; nothing new",
  pageNew: "{title} {value}",
  itsNew: "Its {attr} is {value}",
  proseNew: "{title} has a longer {attr} note on its page",
  prosePart: "has a longer {attr} note on its page",
  somethingNew: "Something new about {title}",
  somethingUnnamed: "Something new only you can see",
  manyUnnamed: "{value} new things only you can see",
  manyUnnamedPages: "{value} new things on {a} pages only you can see",
  moreHeld: "{value} more held from your assistants",
  keptPrivate: "Kept private: something about {title}",
  keptUnnamed: "Kept private: something only you can see",
  manyNew: "{value} new things about {title}",
  heldUntil: "Something new about {title}, held until {until}",
  questionSetAside: "A question about {title} was set aside, since only a conflict asks you",
  takeBackSetAside: "A take-back on {title} was set aside, since only a conflict asks you",
  receipt: "A receipt on {title} was set aside; receipts aren't facts",
  folded: "Two pages called {title} are one page now",
  moved: "{title}'s page moved from {was} to {value}, with the workplace you named",
  movedUnnamed: "A page only you can see moved with the workplace you named",
  foldedUnnamed: "Two pages only you can see are one page now",
  receiptUnnamed: "A receipt was set aside; receipts aren't facts",
  machine: "A fact from a no-reply mail on {title} was set aside; machine mail isn't read for facts",
  machineUnnamed: "A fact from a no-reply mail was set aside; machine mail isn't read for facts",
  family: "{title} may be family: same surname as you",
  disagree: "Two sources disagree on {title}'s {attr}",
  disagreeNext: "Two sources disagree on what's next for {title}",
  disagreeValues: "{title}'s {attr} is {a}. Or {b}?",
  disagreeNextValues: "Next for {title}: {a}. Or {b}?",
  disagreeRoleValues: "{title} is {a}. Or {b}?",
  disagreeVerbValues: "{title} {attr} {a}. Or {b}?",
  disagreeMany: "{value} things about {title} disagree: {attr}",
} as const;
// Where a memory came from, as the canvas says it under the line.
export const SAID_COPY = {
  email: "From {day}'s email",
  calendar: "From {day}'s calendar",
  notion: "From your Notion {when}",
  you: "You said so {when}",
  youVia: "You told your {name} {when}",
  assistant: "{name} learned it {when}",
  other: "From {source} {when}",
  twoEmails: "Two emails disagree",
  twoSources: "Two sources disagree",
  // A fact the hub set aside itself (a receipt, machine mail): said for the day it did it, never as
  // where the fact came from (G673).
  setAside: "Your brain set it aside {when}",
} as const;
export type LineKey = keyof typeof LINE_COPY;
// Each line is a sentence: capitalised, and ending with a full stop unless it asks.
// A next step the owner told as their own to-do is said back with "You" (src/wiki.ts, one rule
// for the page and the home).
export { yourToDo };

export function lineWords(k: LineKey, v: Partial<Record<"title" | "attr" | "value" | "older" | "source" | "until" | "was" | "a" | "b", string>>): string {
  const s = LINE_COPY[k].replace(/\{title\}'s/g, () => /s$/i.test(v.title ?? "") ? `${v.title}'` : `${v.title}'s`).replace(/\{(\w+)\}/g, (_m, x: string) => (v as Record<string, string>)[x] ?? "");
  return (s.charAt(0).toUpperCase() + s.slice(1)).replace(/(?<![.?!…”])$/, ".");
}

// The name a held value's card or line may say for its page, or undefined when it may not: a page
// a stranger's mail named (every fact on it came from addresses the pages don't hold, so its title
// is that mail's subject), a money page, or a name shaped like
// money, health or legal.
export function heldName(rules: Rules, n: Note | undefined, u: { page: string; title?: string; unknownSender?: boolean }): string | undefined {
  const title = displayName(u.page, n?.fm.title !== undefined ? String(n.fm.title) : u.title);
  // A page every fact of which came from addresses the pages don't hold was named by that mail.
  const recs = Object.values(n?.fm.facts ?? {}).flatMap((f) => { const x = f as { items?: unknown[]; candidates?: unknown[] }; return (x.items ?? x.candidates ?? [f]) as { sender?: unknown }[]; });
  const fromStranger = u.unknownSender && (!n || (recs.length > 0 && recs.every((r) => r?.sender === "unknown")));
  if (fromStranger || n?.fm.type === "money" || u.page.startsWith("money/") || sensitiveName(rules, title)) return undefined;
  return title;
}

// Attributes that hold a web address, and the address as its host: "https://www.x.example/a" is
// "x.example". Anything that isn't an address stays as it is.
const SITE_ATTRIBUTES = new Set(["website", "site", "url", "homepage"]);
// What kind of thing a page is reads as where it is filed: "Harbour Mutual is filed under insurance",
// never "Harbour Mutual's kind is insurance" (owner's phone, 2026-11-02, G630).
const KIND_ATTRIBUTES = new Set(["kind", "type", "category"]);
export function siteHost(v: string): string {
  const m = v.trim().match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:www\.)?([^\s/?#:]+\.[^\s/?#:]+)(?::\d+)?(?:[/?#]\S*)?$/i);
  return m ? m[1]!.toLowerCase() : v;
}

// A person by their first name when no other person page starts with it (the canvas says
// "Antoine is head TA now"); anyone else, and any other page, by their whole name.
const firstCache = new WeakMap<Map<string, Note>, Map<string, number>>();
export function shortName(id: string, title: string, notes: Map<string, Note>): string {
  if (!id.startsWith("people/")) return title;
  const first = title.split(/\s+/)[0]!;
  if (first === title || !/^\p{Lu}/u.test(first)) return title;
  let counts = firstCache.get(notes);
  if (!counts) {
    counts = new Map();
    for (const n of notes.values()) if (n.fm.id.startsWith("people/")) { const f = displayName(n.fm.id, n.fm.title).split(/\s+/)[0]!; counts.set(f, (counts.get(f) ?? 0) + 1); }
    firstCache.set(notes, counts);
  }
  return (counts.get(first) ?? 0) === 1 ? first : title;
}

// The days a line says, as words the owner uses: "today", "yesterday", else the weekday.
const FULL_DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function dayName(day: string, today: string): { day: string; when: string } {
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return { day: "today", when: "today" };
  if (day === yesterday) return { day: "yesterday", when: "yesterday" };
  const w = FULL_DAY[new Date(`${day}T12:00:00Z`).getUTCDay()]!;
  return Date.parse(today) - Date.parse(day) < 7 * 86_400_000 ? { day: w, when: `on ${w}` } : { day: longDay(day), when: `on ${longDay(day)}` };
}
export function saidWords(row: Pick<DiaryRow, "source_word" | "by" | "at"> & Partial<Pick<DiaryRow, "why">>, rules: Rules, today = dayOf(clock().toISOString())): string {
  const d = dayName(dayOf(row.at), today);
  const label = (by: string) => rules.policy.agents[by]?.label ?? by;
  const f = (s: string, v: Record<string, string>) => { const t = s.replace(/\{(\w+)\}/g, (_m, x: string) => v[x] ?? ""); return t.charAt(0).toUpperCase() + t.slice(1); };
  if (row.why === "receipt" || row.why === "machine") return f(SAID_COPY.setAside, d);
  switch (row.source_word) {
    case "email": return f(SAID_COPY.email, d);
    case "calendar": return f(SAID_COPY.calendar, d);
    case "notion": return f(SAID_COPY.notion, d);
    case "you": return !row.by || isOwnerId(row.by) ? f(SAID_COPY.you, d) : f(SAID_COPY.youVia, { ...d, name: label(row.by) });
    case "assistant": case "none": return f(SAID_COPY.assistant, { ...d, name: label(row.by) });
    default: return f(SAID_COPY.other, { ...d, source: row.source_word });
  }
}

// The words two sides share at the start are said once: "freeze the beta build on 15 October. Or
// 22 October?" (canvas). Only a shared start of two words or more, and never the whole of a side.
export function differ(values: string[]): { shared: string; rest: string[] } {
  const words = values.map((v) => v.split(/\s+/));
  let n = 0;
  while (words.every((w) => n < w.length - 1 && w[n] === words[0]![n])) n++;
  return n >= 2 ? { shared: words[0]!.slice(0, n).join(" "), rest: words.map((w) => w.slice(n).join(" ")) } : { shared: "", rest: values };
}

// Whether a diary line's value is private at render time (audit v7, G551; CLAUDE.md "Lines on the
// 30-day sign-in"): the page's sensitivity and every record of the fact as the note holds them now,
// and the row's own as a floor. A note that is gone counts as private: there is nothing to check.
export function privateNow(note: Note | undefined, attr: string, rowSensitivity?: Sensitivity): boolean {
  const P = sensitivityRank("private");
  if (rowSensitivity && sensitivityRank(rowSensitivity) >= P) return true;
  if (!note) return true;
  if (sensitivityRank(note.fm.sensitivity) >= P) return true;
  const f = note.fm.facts?.[attr];
  return !!f && records(f).some((r) => !!r.sensitivity && sensitivityRank(r.sensitivity) >= P);
}

// A page's text with every live value that is shut now (unseen, or private on its record or its
// page) taken out as a whole word and said as `mark`: what /p shows on the 30-day sign-in, and what
// Ask and the box answer with there too (slice audit of claude/audit9-fixes: a fact made private
// after it was written still showed in Ask's prose, G582).
const valueText = (v: unknown): string => (v === undefined || v === null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map(valueText).join(", ") : typeof v === "object" ? Object.values(v as object).map(valueText).join(", ") : String(v));
export function shutBody(n: Note, mark = "(private)"): string {
  const P = sensitivityRank("private");
  const shut = (r: { unseen?: boolean; sensitivity?: Sensitivity }) => !!r.unseen || sensitivityRank(r.sensitivity ?? n.fm.sensitivity) >= P || sensitivityRank(n.fm.sensitivity) >= P;
  const values = Object.values(n.fm.facts ?? {}).flatMap((f) => records(f).filter((r) => !r.valid_to && shut(r)))
    .map((r) => valueText(r.value).trim()).flatMap((v) => [v, ...dateWordForms(v)]).filter((v) => v.length >= 2).sort((a, b) => b.length - a.length);
  if (!values.length) return n.body ?? "";
  // Then the disguised spellings (spaced out, hyphen dropped, look-alike letters), with the same
  // matcher as an assistant's view (view.ts scrubCarved): a line that still carries a value goes
  // whole (audit v10, G614). Whole values only, as in carve.ts needlesWith: a two-word fragment would
  // hide innocent lines.
  const needles = values.filter((v) => !/^\p{L}+$/u.test(v)).map((v) => needleFor(v, v)).filter((x): x is Needle => !!x).map((x) => ({ ...x, parts: [] }));
  const exact = scrubExact(n.body ?? "", values);
  const out = needles.length && findCarried(exact, needles) ? exact.split("\n").map((line) => findCarried(line, needles) ? line.replace(/^(\s*(?:[-*] )?).*$/, "$1[withheld]") : line).join("\n") : exact;
  return out.replace(/\[withheld\]/g, mark);
}

// A filing that confirmed a held value, by the kind of source it added (G524).
const CONFIRMED_BY: Record<string, string> = { email: "email", calendar: "calendar event", notion: "Notion page", assistant: "assistant", you: "word of yours" };

function lineOf(row: DiaryRow & { count?: number }, rules: Rules, notes: Map<string, Note>, undone: Set<string>): HomeLine | undefined {
  const [id, attr] = [row.fact_key.slice(0, row.fact_key.lastIndexOf("#")), row.fact_key.slice(row.fact_key.lastIndexOf("#") + 1)];
  const a = words(attr);
  row = { ...row, title: displayName(id, notes.get(id)?.fm.title ?? row.title) };
  const say = (v: unknown) => plain(v, (x) => { const t = notes.get(x)?.fm.title; return t === undefined ? undefined : String(t); }, slugsOf(notes));
  // A private line, or one whose value waits for the owner's Show (spec §7), names only its page.
  const held = (() => { const f = notes.get(id)?.fm.facts?.[attr] as { items?: { unseen?: boolean; valid_to?: string }[]; unseen?: boolean } | undefined; return !!f && (f.unseen === true || (f.items ?? []).some((i) => i.unseen && !i.valid_to)); })();
  // Decided from the page as it is now, never only from the stored row (audit v7's rule; owner-canvas
  // slice audit): a page or a fact's live record made private since says only that something is new.
  const noteNow = notes.get(id), factNow = noteNow?.fm.facts?.[attr] as { items?: unknown[] } | undefined;
  const shapeless = held || privateNow(noteNow, attr, row.sensitivity);
  // A private line names its page only as its held card would (heldName).
  const stranger = [factNow, ...(factNow?.items ?? [])].some((r) => (r as { sender?: unknown } | undefined)?.sender === "unknown");
  const safeName = heldName(rules, noteNow, { page: id, title: row.title, unknownSender: stranger }) !== undefined;
  const named = !shapeless || safeName;
  const from = `${fromWords(row, rules)}, ${weekday(dayOf(row.at))}`;
  const said = saidWords(row, rules), tag = { said, attr, kind: row.kind };
  // An assistant's proposal held until its day, or one set aside (src/filing.ts): never its value.
  if (row.kind === "held") return { token: row.undo_token, page: id, what: lineWords("heldUntil", { title: row.title, until: row.until ? longDay(row.until) : "you let it file" }), from, undo: "none", maybe: false, shapeless: true, ...tag };
  // A fold (src/fold.ts): its Undo puts the two pages back, nothing else (audit v11).
  // Either page private now names its page only as a held card would, like every other line
  // (privateNow and heldName, invariant 16).
  if (row.kind === "folded") return { token: row.undo_token, page: id, what: named && (!row.dropped || !privateNow(notes.get(row.dropped), "", row.sensitivity) || heldName(rules, notes.get(row.dropped), { page: row.dropped, title: row.title }) !== undefined) ? lineWords("folded", { title: shortName(id, row.title!, notes) }) : lineWords("foldedUnnamed", {}), from, undo: undone.has(row.undo_token) ? "undone" : "undo", maybe: false, shapeless, ...tag };
  // A page that moved with the workplace the owner named (G664), from one area to the other.
  if (row.kind === "moved") { const area = (a: unknown) => String(a ?? "").replace(/^./, (c) => c.toUpperCase()); return { token: row.undo_token, page: id, what: named ? lineWords("moved", { title: shortName(id, row.title!, notes), was: area(row.from), value: area(row.to) }) : lineWords("movedUnnamed", {}), from, undo: undone.has(row.undo_token) ? "undone" : "undo", maybe: false, shapeless, ...tag }; }
  if (row.kind === "set_aside") return { token: row.undo_token, page: id, what: lineWords(attr === "open_question" ? "questionSetAside" : "takeBackSetAside", { title: row.title }), from, undo: "none", maybe: false, shapeless: true, ...tag };
  const verb = isVerbAttribute(attr);
  const t = shortName(id, row.title!, notes);
  // A web address says its host only ("harbourline.example"), never a bare address in a sentence.
  const site = SITE_ATTRIBUTES.has(attr);
  const val = (v: unknown) => site ? siteHost(say(v)) : say(v);
  const prose = isProse(val(row.to)) || (row.from !== undefined && isProse(val(row.from)));
  const w = (k: LineKey) => lineWords(k, { title: t, attr: a, value: val(row.to), older: olderSay(row), source: CONFIRMED_BY[row.source_word] ?? "source", ...(row.from !== undefined && !shapeless ? { was: val(row.from) } : {}) });
  // A few attributes have their own sentence: what's next, when the owner was last in touch, a role.
  const own = attr === "next_step" ? "next" : attr === "last_contact" ? "contact" : attr === "role" ? "role" : attr === "org" && notes.get(id)?.fm.type === "person" ? "org" : site ? "site" : KIND_ATTRIBUTES.has(attr) ? "kind" : undefined;
  // What may be said is decided first (owner-canvas re-audit): a receipt says its page only by a
  // name heldName allows, and a family line, like any other, says nothing on a page private now.
  let what = row.why === "receipt" ? (safeName ? w("receipt") : lineWords("receiptUnnamed", {}))
    : row.why === "machine" ? (safeName ? w("machine") : lineWords("machineUnnamed", {}))
    : shapeless ? (named ? w("somethingNew") : lineWords("somethingUnnamed", {}))
    : row.why === "family" ? w("family")
    : verb && (row.kind === "new" || row.kind === "item_added") ? w("verbNew")
    : verb && row.kind === "changed" ? w("verbChanged")
    : verb && row.kind === "settled" ? w("verbSettled")
    : verb && row.kind === "kept" && row.source_word !== "you" ? w("verbKept")
    : own === "role" && row.kind === "changed" && row.from !== undefined ? w("roleChangedFrom")
    : own && (row.kind === "new" || row.kind === "changed" || row.kind === "settled") ? w(`${own}${row.kind === "new" ? "New" : row.kind === "changed" ? "Changed" : "Settled"}` as LineKey)
    // Prose is a note on its page, and a value that says itself reads bare (G634).
    : (row.kind === "new" || row.kind === "changed") && prose ? lineWords("proseNew", { title: t, attr: a })
    : row.kind === "new" && clause(attr, val(row.to)) ? lineWords("pageNew", { title: t, value: clause(attr, val(row.to))! })
    : row.kind === "new" ? w("new")
    : row.kind === "changed" ? w("changed")
    : row.kind === "item_added" ? w("itemAdded")
    : row.kind === "retracted" ? w("retracted")
    : row.kind === "kept" && row.source_word === "you" ? w("keptYours")
    : row.kind === "kept" ? w("kept")
    : row.kind === "settled" ? w("settled")
    : row.kind === "undone" ? w("undone")
    : row.kind === "confirmed" ? (row.added?.length ? w("confirmed") : w("saidAgain"))
    : undefined;
  if (!what) return undefined; // a conflict line waits on the owner instead
  // The owner's own to-do says it as they did: "You owe Ben the sample", never "Next for Ben: owe…" (G623).
  const todo = own === "next" && row.source_word === "you" && (row.kind === "new" || row.kind === "changed") ? yourToDo(val(row.to)) : undefined;
  if (todo) what = todo;
  // "You settled" only of the owner's own settle (Mac, 2026-10-31): an assistant's names it, and a
  // row that doesn't say who settled it says neither.
  const who = row.kind !== "settled" || isOwnerId(row.settled_by) ? undefined : row.settled_by ? agentTitle(rules, row.settled_by) : "";
  if (who !== undefined) what = what.replace(/^You settled it: /, who ? `${who} settled it: ` : "Settled: ").replace(/^You settled /, who ? `${who} settled ` : "Settled ");
  const about = { ...tag, ...(row.why === "receipt" || row.why === "machine" ? { kind: "receipt" } : { key: row.fact_key, ...(held ? { held } : {}) }) };
  if (row.kind === "kept" || (row.kind === "confirmed" && !row.added?.length)) return { token: row.undo_token, page: id, what, from, undo: "none", maybe: false, shapeless, ...about };
  const note = notes.get(id);
  const now = note ? shownValue(note.fm.facts?.[attr]) : undefined;
  const same = JSON.stringify(now ?? null) === JSON.stringify(row.kind === "retracted" ? null : row.kind === "item_added" ? undefined : row.to ?? null);
  const itemThere = row.kind === "item_added" && Array.isArray(now) && now.some((v) => JSON.stringify(v) === JSON.stringify(row.to));
  const undo = row.kind === "undone" ? "none" : undone.has(row.undo_token) ? "undone" : (same || itemThere) && !(note?.fm.facts?.[attr] && isDisputed(note.fm.facts[attr])) ? "undo" : "changed";
  return { token: row.undo_token, page: id, what, from, ...(row.kind === "changed" && !shapeless && !prose && row.from !== undefined ? { was: val(row.from) } : {}), undo, maybe: row.confidence === "inferred", shapeless, ...about };
}

// "3 older emails still say", "An older email still says" (spec §4.6).
function olderSay(row: DiaryRow & { count?: number }): string {
  const n = row.count ?? 1;
  const what = row.source_word === "email" ? "email" : row.source_word === "calendar" ? "calendar event" : "source";
  return n === 1 ? `An older ${what} still says` : `${n} older ${what}s still say`;
}

// Older sources the owner's word outranked are one line per fact per day, the newest of them
// counting the rest (spec §4.6).
function foldKept(rows: DiaryRow[]): (DiaryRow & { count?: number })[] {
  const last = new Map<string, number>(), count = new Map<string, number>();
  const k = (r: DiaryRow) => `${r.fact_key}\0${dayOf(r.at)}`;
  rows.forEach((r, i) => { if (r.kind === "kept") { last.set(k(r), i); count.set(k(r), (count.get(k(r)) ?? 0) + 1); } });
  return rows.flatMap((r, i) => r.kind !== "kept" ? [r] : last.get(k(r)) === i ? [{ ...r, count: count.get(k(r)) }] : []);
}

// Real conflicts the owner settles: open ones the Gardener is not still weighing (core.ts). Those it
// still weighs are listed apart, quietly, and open the same settle screen.
// One fact as a sentence the owner reads: a held value on its card, and the done line after Show
// (G630). The page by its whole name, the value in words with no stray full stop of its own.
// A value that says itself (an amount, a status) reads bare, "Notes app subscription: will renew",
// never "status is will renew"; prose an assistant wrote (a review, a summary) is a note on its page,
// never read out here (owner's phone, 2026-11-03; G634).
export function factSentence(id: string, title: unknown, attr: string, value: unknown, notes: Map<string, Note>): string {
  const t = displayName(id, title);
  const value_ = valueWords(attr, value, notes);
  const c = clause(attr, value_);
  if (c) return lineWords("pageNew", { title: t, value: c });
  // The owner's own to-do says it as they did: "You owe Ben the sample" (G623).
  if (attr === "next_step" && yourToDo(value_)) return `${yourToDo(value_)!}.`;
  const k: LineKey = isVerbAttribute(attr) ? "verbNew" : attr === "next_step" ? "nextNew" : attr === "last_contact" ? "contactNew" : attr === "role" ? "roleNew" : attr === "org" && notes.get(id)?.fm.type === "person" ? "orgNew" : SITE_ATTRIBUTES.has(attr) ? "siteNew" : KIND_ATTRIBUTES.has(attr) ? "kindNew" : "new";
  return lineWords(k, { title: t, attr: words(attr), value: value_ });
}
// Prose, not a fact: long, or more than one sentence. Its words stay on its page.
export const PROSE_CHARS = 140;
const isProse = (v: string) => v.length > PROSE_CHARS || (v.length > 80 && /[.!?]\s+\p{Lu}/u.test(v));
// What a thing does or is, said after its name: "comes to CAD 6.20", "is due 9 Nov 2026", "will
// renew", "is paid". Money first, then dates, the state last; undefined for any other attribute,
// which keeps its own sentence ("Jane Roy's fee is …").
const MONEY_ATTRIBUTES = new Set(["amount", "total", "price", "cost"]);
const DUE_ATTRIBUTES = new Set(["due", "due_date", "due_on"]);
const STATE_ATTRIBUTES = new Set(["status", "state"]);
const VERBISH = /^(?:will|won't|was|were|is|are|has|had|have|can|may|must|did|does|needs?|awaits?|expires?|renews?)\b/i;
function clause(attr: string, v: string): string | undefined {
  if (isProse(v)) return lineWords("prosePart", { attr: words(attr) }).replace(/\.$/, "").replace(/^./, (x) => x.toLowerCase());
  if (MONEY_ATTRIBUTES.has(attr)) return `comes to ${v}`;
  if (DUE_ATTRIBUTES.has(attr)) return `is due ${v}`;
  if (STATE_ATTRIBUTES.has(attr)) return VERBISH.test(v) ? v : `is ${v}`;
  return undefined;
}
// A longer note goes last, after the state.
const clauseRank = (attr: string, v: string) => isProse(v) ? 4 : MONEY_ATTRIBUTES.has(attr) ? 0 : DUE_ATTRIBUTES.has(attr) ? 1 : STATE_ATTRIBUTES.has(attr) ? 3 : 2;
function valueWords(attr: string, value: unknown, notes: Map<string, Note>): string {
  const v = plain(value, (x) => { const tt = notes.get(x)?.fm.title; return tt === undefined ? undefined : String(tt); }, slugsOf(notes)).replace(/[\s.]+$/, "");
  return SITE_ATTRIBUTES.has(attr) ? siteHost(v) : v;
}
// Several held values, one line per page (owner's phone, 2026-11-03: one subscription was three
// lines): "Notes app subscription comes to CAD 6.20, is due 9 Nov 2026 and will renew." Any other
// attribute follows in its own short sentence, "Its plan is Family." Pages keep their first order.
export interface HeldValue { page: string; title: unknown; attr: string; value: unknown }
export function pageSentences(values: HeldValue[], notes: Map<string, Note>): string[] {
  const byPage = new Map<string, HeldValue[]>();
  for (const v of values) byPage.set(v.page, [...(byPage.get(v.page) ?? []), v]);
  return [...byPage.values()].map((vs) => {
    if (vs.length === 1) return factSentence(vs[0]!.page, vs[0]!.title, vs[0]!.attr, vs[0]!.value, notes);
    const t = displayName(vs[0]!.page, vs[0]!.title);
    const said = vs.map((x) => ({ ...x, v: valueWords(x.attr, x.value, notes) })).sort((a, b) => clauseRank(a.attr, a.v) - clauseRank(b.attr, b.v)).map((x) => ({ ...x, c: clause(x.attr, x.v) }));
    const cs = said.filter((x) => x.c).map((x) => x.c!), rest = said.filter((x) => !x.c);
    const first = cs.length ? [lineWords("pageNew", { title: t, value: cs.length === 1 ? cs[0]! : `${cs.slice(0, -1).join(", ")} and ${cs.at(-1)}` })] : [];
    const others = rest.map((x, i) => !first.length && i === 0 ? factSentence(x.page, x.title, x.attr, x.value, notes) : lineWords("itsNew", { attr: words(x.attr), value: x.v }));
    return [...first, ...others].join(" ");
  });
}

function conflicts(root: string, now: Date, expand = false, asks = ownerAsks(root, now), fresh = false): { waiting: Waiting[]; gardener: Waiting[] } {
  const open = ownerConflicts(root, now, { held: true });
  const rules = loadRules(root);
  const notes = new Map(loadBrain(root, { shared: true }).map((n) => [n.fm.id, n]));
  const unseen = unseenFacts(root);
  const disagree = (page: string, title: string | undefined, attr: string) => lineWords(attr === "next_step" ? "disagreeNext" : "disagree", { title: displayName(page, title), attr: words(attr) });
  // A conflict says its two values, as the canvas does, only when they could show on any sign-in:
  // worked out from the page as it is now, never from what the conflict stored (audit v7's rule):
  // the page and the fact below private, no value held for Read it, nothing money-, health- or
  // legal-shaped, and short enough for a line. Else the sentence names only the page.
  const valued = (c: SettleCase): { what: string; parts: string[] } | undefined => {
    const n = notes.get(c.page);
    if (!n || c.private || c.sides.length !== 2 || sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private")) return undefined;
    const f = n.fm.facts?.[c.attr] as { sensitivity?: string; candidates?: { sensitivity?: string }[]; items?: { sensitivity?: string }[] } | undefined;
    if ([f, ...(f?.candidates ?? []), ...(f?.items ?? [])].some((r) => r?.sensitivity && sensitivityRank(r.sensitivity as never) >= sensitivityRank("private"))) return undefined;
    if (unseen.some((u) => u.page === c.page)) return undefined;
    const say = (v: unknown) => plain(v, (x) => { const t = notes.get(x)?.fm.title; return t === undefined ? undefined : String(t); }, slugsOf(notes));
    const vals = c.sides.map((x) => say(x.value));
    if (vals.some((v) => !v || v.length > 80) || sensitiveShape(rules, c.attr, ...vals)) return undefined;
    const d = differ(vals);
    const a = d.shared ? `${d.shared} ${d.rest[0]}` : vals[0]!, b = d.rest[1]!;
    const t = shortName(c.page, displayName(c.page, c.title), notes);
    return { what: lineWords(c.attr === "next_step" ? "disagreeNextValues" : c.attr === "role" ? "disagreeRoleValues" : isVerbAttribute(c.attr) ? "disagreeVerbValues" : "disagreeValues", { title: t, attr: words(c.attr), a, b }), parts: [d.rest[0] ?? vals[0]!, b] };
  };
  const meta = (c: SettleCase) => c.sides.every((x) => x.source_word === "email") ? SAID_COPY.twoEmails : SAID_COPY.twoSources;
  // Every conflict card says where its sides came from, also when its values are too long or too
  // private for the line (owner's phone, 2026-11-03: only the first of three cards said "Two emails
  // disagree"; G662). The source line names kinds of source, never a value.
  const line = (c: SettleCase, verb: string) => { const v = valued(c); return { what: v?.what ?? disagree(c.page, c.title, c.attr), verb, href: `/settle/${c.id}`, meta: meta(c), ...(v ? { parts: v.parts } : {}) }; };
  // One card for the questions one page's same two sources raise (owner's phone, 2026-11-03: three
  // cards for one project from the same two emails, G669): it names each field, counts each question,
  // and opens on the first; a pick goes on to the next (settleNext).
  const card = (cs: SettleCase[], verb: string): Waiting => {
    if (cs.length === 1) return line(cs[0]!, verb);
    const c = cs[0]!, attrs = [...new Set(cs.map((x) => x.attr))];
    const named = attrs.map((a) => a === "next_step" ? "what's next" : `its ${words(a)}`);
    const what = attrs.length === 1 ? disagree(c.page, c.title, c.attr) : lineWords("disagreeMany", { title: displayName(c.page, c.title), value: String(cs.length), attr: `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` });
    return { n: cs.length, what, verb, href: `/settle/${c.id}`, meta: cs.every((x) => meta(x) === SAID_COPY.twoEmails) ? SAID_COPY.twoEmails : SAID_COPY.twoSources };
  };
  // What the owner hasn't seen yet is held from every assistant (spec §7): named, never shown here.
  // A held value's card names its page only when that name is safe on any sign-in (owner's phone,
  // 2026-10-31: "Something new about Apple Services payment" twice): never a name a stranger's mail
  // gave it, a money page or a name shaped like money, health or legal. Cards that would read the
  // same are one card that counts them; its Read it shows each (the keys, one per line).
  const groups = new Map<string, Unseen[]>();
  for (const u of unseen) {
    const name = heldName(rules, notes.get(u.page), u);
    const g = groups.get(name ?? "") ?? [];
    g.push(u); groups.set(name ?? "", g);
  }
  // Named cards first, then the one that counts what it can't name.
  const ordered = [...groups].sort(([a], [b]) => Number(a === "") - Number(b === ""));
  // Each held value is its own locked card with Read it (owner app brief, 2026-10-30), but only a
  // few (owner's phone, 2026-10-29: a wall of receipts was the first thing on the home). Past
  // HELD_EACH, the last card counts every value left, named or not, so the home never says two
  // counts for the same kind of thing (Mac, 2026-10-31: "5 new things only you can see", two
  // cards, then "3 more new private things").
  // That last card only counts and links to the full list: it releases nothing, so each held value
  // still needs its own Read it (PR #6 review: one tap let every value left out across pages).
  const overflow = !expand && ordered.length > HELD_EACH;
  const cards = overflow ? [...ordered.slice(0, HELD_EACH - 1), ["", ordered.slice(HELD_EACH - 1).flatMap(([, us]) => us)] as [string, Unseen[]]] : ordered;
  const shown = cards.map(([name, us], i) => {
    if (overflow && i === cards.length - 1) return { n: us.length, what: lineWords("moreHeld", { value: String(us.length) }), verb: `${us.some((u) => u.unknownSender) ? "from an address your pages don't hold · " : ""}only you can see them yet`, href: "/home?all=1", ...(us.some((u) => u.unknownSender) ? { stranger: true } : {}) };
    const one = us.length === 1, page = us[0]!.page, stranger = us.some((u) => u.unknownSender);
    const what = name ? (one ? lineWords("somethingNew", { title: name }) : lineWords("manyNew", { title: name, value: String(us.length) })) : one ? lineWords("somethingUnnamed", {}) : ((pages) => pages > 1 && pages < us.length ? lineWords("manyUnnamedPages", { value: String(us.length), a: String(pages) }) : lineWords("manyUnnamed", { value: String(us.length) }))(new Set(us.map((u) => u.page)).size);
    // The values themselves only on a fresh sign-in (G630): read first, then let out or kept.
    const look = fresh ? pageSentences(us.map((u) => ({ page: u.page, title: notes.get(u.page)?.fm.title ?? u.title, attr: u.attr, value: u.value })), notes) : undefined;
    return { n: us.length, what, verb: `${stranger ? "from an address your pages don't hold · " : ""}only you can see ${one ? "it" : "them"} yet`, href: one || us.every((u) => u.page === page) ? `/p/${page.split("/").map(encodeURIComponent).join("/")}` : "/home?all=1", seen: us.map((u) => u.fact_key).join("\n"), ...(look ? { look } : {}), ...(stranger ? { stranger: true } : {}) };
  });
  // The full list also shows what the owner kept private, counted nowhere (n: 0), each with Let
  // them have it, so Keep it private is never final (review of #60, G630).
  const kept: Waiting[] = expand ? keptFacts(root).map((u) => ({ n: 0, what: ((name) => name ? lineWords("keptPrivate", { title: name }) : lineWords("keptUnnamed", {}))(heldName(rules, notes.get(u.page), u)), verb: "kept private", href: `/p/${u.page.split("/").map(encodeURIComponent).join("/")}`, seen: u.fact_key, ...(fresh ? { look: [factSentence(u.page, notes.get(u.page)?.fm.title ?? u.title, u.attr, u.value, notes)] } : {}), ...(u.unknownSender ? { stranger: true } : {}) })) : [];
  // A contradiction the write path handed over as a proposal is a conflict too (settle-inbox.ts).
  const asking = settleCards(open.filter((c) => !c.held), inboxConflicts(root)).map((cs) => card(cs, "tap to settle"));
  // A message the relay held between two assistants: send it or not, on its own settle screen.
  const mail = comms(root).filter((m) => m.verdict === "held").map((m) => ({ what: `${cap(agentLabel(rules, m.from))}'s message to ${agentLabel(rules, m.to)} is held.`, verb: "tap to decide", href: `/settle/m-${m.id}` }));
  // A question about a class the owner may teach (src/teaching.ts, G715), answered here with his
  // three taps. It names the class and the school only while every page behind it is still below
  // private, read now (invariant 16); else it asks without them.
  const below = (id: string) => { const n = notes.get(id); return !!n && sensitivityRank(n.fm.sensitivity) < sensitivityRank("private"); };
  const teach: Waiting[] = waitingTeachAsks(root).map((a) => ({ what: below(a.org) && a.pages.every(below) ? a.question : HOME_COPY.teachUnnamed, verb: "tap to answer", href: "/home", teach: teachKey(a.code) }));
  // A fact linking a page the brain doesn't have (src/dangling.ts, G749): which page he meant, the
  // plain name, or leave it, each its own tap. It names the pages only while each is still below
  // private, read now; else it asks without them and offers only the name or leave it.
  const link: Waiting[] = waitingLinkAsks(root).map((a) => {
    const named = below(a.page) && a.choices.every(below);
    return { what: named ? a.question : HOME_COPY.linkUnnamed, verb: "tap to answer", href: "/home", link: a.key,
      choices: [...(named ? a.choices.map((id) => ({ label: String(notes.get(id)?.fm.title ?? id), answer: `pick:${id}` })) : []), { label: HOME_COPY.linkName, answer: "name" }, { label: HOME_COPY.linkLeave, answer: "no" }] };
  });
  // What waits on Settings (src/waiting.ts): one card that counts it and links there (G626).
  const settings: Waiting[] = asks.settings > 0 ? [{ n: asks.settings, what: settingsWords(asks), verb: "on Settings", href: SETTINGS_HREF }] : [];
  return { waiting: [...asking, ...mail, ...teach, ...link, ...shown, ...kept, ...settings], gardener: open.filter((c) => c.held).map((c) => line(c, "the Gardener looks tonight")) };
}

// The home's waiting cards alone, for a test or a probe.
export const homeWaiting = (root: string, now: Date) => conflicts(root, now).waiting;

// A teaching question's key on the home's forms: never the course code itself, which the card
// leaves out once a page behind it is private.
export const teachKey = (code: string) => sha256(`teach:${code}`).slice(0, 16);

// How many things the home lists as waiting on the owner: the one count the digest and the text
// say too (conflicts to settle and held values to see; never the Gardener's, never an alert).
// Each thing counts once (G625): a card that holds several held values counts each of them, so the
// home's big number, the digest and the north star say the same number.
export const waitingTotal = (ws: Waiting[]) => ws.reduce((a, w) => a + (w.n ?? 1), 0);
// What waits on Settings, by kind, in the owner's words: "4 names that fit two pages; 5 changes an
// assistant couldn't see the whole page for". Kinds the home lists itself aren't here.
const SETTINGS_KINDS: [string, string, string][] = [
  ["held_by_ambiguity", "name that fits two pages", "names that fit two pages"],
  ["held_by_access", "change an assistant couldn't see the whole page for", "changes an assistant couldn't see the whole page for"],
  ["held_by_capture", "note about a person to check", "notes about people to check"],
  ["held-answer", "answer to check", "answers to check"],
  ["capture", "capture to check", "captures to check"],
  ["held", "new page held past its day", "new pages held past their day"],
  ["upkeep", "upkeep finding", "upkeep findings"],
  ["rules", "rules change", "rules changes"],
  ["usage", "spending notice", "spending notices"],
];
export function settingsWords(a: Pick<OwnerAsks, "by" | "settings">): string {
  const parts = SETTINGS_KINDS.filter(([k]) => (a.by[k] ?? 0) > 0).map(([k, one, many]) => `${a.by[k]} ${a.by[k] === 1 ? one : many}`);
  const named = SETTINGS_KINDS.reduce((n, [k]) => n + (a.by[k] ?? 0), 0);
  const rest = a.settings - named; // proposals that change nothing the home lists: "something to check"
  if (rest > 0) parts.push(`${rest} ${rest === 1 ? "change to check" : "changes to check"}`);
  return `${cap(parts.join("; "))}.`;
}

// The questions waiting on the owner, one group per home card: a page's conflicts that share their
// two sources (the same refs on each side, in either order) or their field are one card (G669).
// Conflicts with no refs group only by field. Each group keeps the order the home lists them in.
const pairOf = (c: SettleCase) => c.sides.length === 2 && c.sides.every((s) => s.refs?.length) ? c.sides.map((s) => [...s.refs!].sort().join(",")).sort().join("|") : "";
export function settleCards(open: SettleCase[], inbox: SettleCase[] = []): SettleCase[][] {
  const groups: SettleCase[][] = [];
  for (const c of [...open, ...inbox]) {
    const k = pairOf(c);
    const g = groups.find((cs) => cs[0]!.page === c.page && cs.some((x) => x.attr === c.attr || (!!k && pairOf(x) === k)));
    if (g) g.push(c); else groups.push([c]);
  }
  return groups;
}
// After a pick on one of a card's questions: the next one on that card still open, if any (G669).
// `card` is the card's ids as they were before the pick.
export function settleCard(root: string, id: string, now = new Date()): string[] {
  const open = ownerConflicts(root, now, { held: true }).filter((c) => !c.held || c.id === id);
  return settleCards(open, inboxConflicts(root)).find((cs) => cs.some((c) => c.id === id))?.map((c) => c.id) ?? [];
}
export function settleNext(root: string, card: string[], done: string, now = new Date()): string | undefined {
  const still = new Set([...ownerConflicts(root, now).map((c) => c.id), ...inboxConflicts(root).map((c) => c.id)]);
  return card.find((id) => id !== done && still.has(id));
}

// How many questions still wait on a Settle (or Decide) screen: what the line after a pick says is
// left (G631).
export function settleLeft(root: string, now = new Date()): number {
  return waitingTotal(conflicts(root, now, true).waiting.filter((w) => w.href.startsWith("/settle/")));
}
// The north star passes its own asks, read at its own time, so the two count one list (G626).
export function waitingCount(root: string, now = new Date(), asks?: OwnerAsks): number {
  return waitingTotal(conflicts(root, now, true, asks ?? ownerAsks(root, now)).waiting);
}

// The newest diary lines across the brain, as the home says them (the owner's page's What's new).
export function latestLines(root: string, rules: Rules, notes: Note[], max: number): HomeLine[] {
  const rows = readDiary(root);
  const undone = new Set(rows.filter((r) => r.undoes).map((r) => r.undoes!));
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const out: HomeLine[] = [];
  for (const r of foldKept(rows).reverse()) {
    const l = lineOf(r, rules, byId, undone);
    if (l && !out.some((x) => x.page === l.page && x.what === l.what)) out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

// One page's diary lines, newest first (the page screen's Changed list).
export function pageLines(root: string, rules: Rules, notes: Note[], id: string): HomeLine[] {
  const rows = readDiary(root);
  const undone = new Set(rows.filter((r) => r.undoes).map((r) => r.undoes!));
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  return foldKept(rows.filter((r) => r.fact_key.startsWith(`${id}#`))).reverse().map((r) => lineOf(r, rules, byId, undone)).filter((l): l is HomeLine => !!l);
}

// Whether each assistant read the brain today (Louis, 2026-10-29, G475), by any read (its context
// first of all, a search, a page): the one number that says
// the brain is being used. Every assistant with a grant, but the Gardener (its night run is not a
// read for the owner's day) and one the owner paused; by the name the owner knows it by.
// What an assistant asked the brain today, in the owner's words (Louis's fourth outside read,
// 2026-10-29, G502): the question or the page, which pages it was told, and the time. Owner-only,
// from the read log; a page it asked for and couldn't see is never named.
export interface AskLine { at: string; what: string; told: string }
export const ASKS_PER_ASSISTANT = 5;
const TOLD_NAMES = 3;
// What it typed is shown only right after a sign-in (G545): a query can carry a guessed private or
// held value, so on an older sign-in the line names the first page it got instead, or nothing.
function askLine(e: ReadEntry, title: (id: string) => string, fresh = true): Omit<AskLine, "at"> {
  const pages = e.ids.filter((id) => id !== "*" && !id.startsWith("log:"));
  const names = pages.slice(0, TOLD_NAMES).map(title).join(", ") + (pages.length > TOLD_NAMES ? ` and ${pages.length - TOLD_NAMES} more` : "");
  const told = e.ids.includes("*") ? "everything it gets" : names || "nothing";
  const q = (s: string) => `“${s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s}”`;
  switch (e.op) {
    case "context_pack": return { what: !e.q ? "read what it gets" : fresh ? `asked about ${q(e.q)}` : pages[0] ? `asked about ${title(pages[0])}` : "asked something", told };
    case "search": return { what: e.q && fresh ? `searched ${q(e.q)}` : "searched", told };
    case "read": return pages[0] ? { what: `opened ${title(pages[0])}`, told } : { what: "looked for a page it can't see", told: "nothing" };
    case "who_is": return { what: "asked who someone is", told };
    case "why": return { what: pages[0] ? `asked where something on ${title(pages[0])} came from` : "asked where something came from", told };
    case "whats_new": case "changes_since": return { what: "checked what's new", told };
    case "connect": return { what: "connected", told: "its guide" };
    case "orientation": return { what: "read its guide", told: "its guide and today's next steps" };
    case "open_disputes": return { what: "looked at the questions still open", told };
    case "ask_read": return { what: pages[0] ? `read ${title(pages[0])} with your OK` : "read a page with your OK", told };
    case "log_search": return { what: "searched its own notes", told: "its own notes" };
    case "log_read": return { what: "read its own notes", told: "its own notes" };
    // Every read the row counts has a line, so "3 times" never stands with nothing under it.
    default: return { what: "read your brain", told };
  }
}

// A page that is secret now is named only right after a sign-in, as on Memory (builder's audit,
// 2026-10-31): an assistant may have read it before it was made secret.
export const ONLY_YOU = "a page only you can see";
export function assistantReads(root: string, rules: Rules, now: Date, notes: Note[] = [], fresh = true): HomeView["reads"] {
  const day = ownerDay(rules, now);
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const title = (id: string) => !fresh && byId.get(id)?.fm.sensitivity === "secret" ? ONLY_YOU : displayName(id, byId.get(id)?.fm.title === undefined ? undefined : String(byId.get(id)!.fm.title));
  const entries = readEntriesSince(root, new Date(now.getTime() - 26 * 3_600_000).toISOString(), (at) => ownerDay(rules, at) === day);
  const quiet = quietAssistants(root, rules, now);
  return Object.entries(rules.policy.agents).filter(([k, a]) => ownAssistant(rules, k) && a.status !== "paused")
    .map(([k, a]) => {
      const mine = entries.filter((e) => e.agent === k);
      // The same line again right after (an assistant connects at every new chat) is one line, counted.
      const asked: AskLine[] = [];
      for (const e of [...mine].reverse()) {
        const l = { at: ownerLocal(e.at).slice(11, 16).replace(/^0/, ""), ...askLine(e, title, fresh) }, last = asked.at(-1);
        if (last && last.what.replace(/ \(\d+ times\)$/, "") === l.what && last.told === l.told) { const n = Number(last.what.match(/\((\d+) times\)$/)?.[1] ?? 1) + 1; last.what = `${l.what} (${n} times)`; }
        else asked.push(l);
      }
      const q = quiet.find((x) => x.agent === k);
      return { agent: k, name: agentTitle(rules, k), today: mine.length, ...(q ? { quiet: quietWords(q) } : {}), ...(asked.length ? { asked: asked.slice(0, ASKS_PER_ASSISTANT), ...(asked.length > ASKS_PER_ASSISTANT ? { askedMore: asked.length - ASKS_PER_ASSISTANT } : {}) } : {}) };
    }).sort((a, b) => a.name.localeCompare(b.name));
}

// The owner's day as the screens say it ("Thu 8 Oct") and the name they greet: shared by the tabs.
export const dayWords = (now: Date) => longDay(dayOf(now.toISOString()));
export const firstName = (rules: Rules) => (rules.policy.owner?.name ?? ownerName(rules)).split(/\s+/)[0]!;

export function homeView(root: string, rules: Rules, notes: Note[], now: Date, o: { all?: boolean; fresh?: boolean } = {}): HomeView {
  const rows = readDiary(root);
  const undone = new Set(rows.filter((r) => r.undoes).map((r) => r.undoes!));
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const today = dayOf(now.toISOString());
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const recent: [DiaryRow, HomeLine][] = [], older = new Map<string, HomeLine[]>();
  for (const r of foldKept(rows).reverse()) {
    const line = lineOf(r, rules, byId, undone);
    if (!line) continue;
    const day = dayOf(r.at);
    if (day >= yesterday) recent.push([r, line]);
    else older.set(day, [...(older.get(day) ?? []), line]);
  }
  // What the owner said in the last hour leads, newest first, and the cap never cuts it: they can
  // see and undo what they just typed (use-it check, 2026-10-27). Then least certain first: a
  // guess, then by the source's rank, newest first within a rank.
  const justSaid = (r: DiaryRow) => isOwnerId(r.by) && r.kind !== "kept" && now.getTime() - Date.parse(r.at) < JUST_SAID_MS;
  recent.sort(([a], [b]) => Number(justSaid(b)) - Number(justSaid(a)) || (justSaid(a) ? b.at.localeCompare(a.at) : 0) || (a.confidence === "inferred" ? 0 : 1) - (b.confidence === "inferred" ? 0 : 1) || a.rank - b.rank || b.at.localeCompare(a.at));
  const cap = o.all ? recent.length : SINCE_CAP + recent.filter(([r]) => justSaid(r)).length;
  return {
    ...(o.all ? { all: true } : {}),
    name: firstName(rules),
    date: longDay(today),
    reads: assistantReads(root, rules, now, notes, o.fresh ?? true),
    ...conflicts(root, now, o.all, undefined, o.fresh ?? false),
    since: recent.slice(0, cap).map(([r, l]) => (justSaid(r) ? { ...l, just: true } : l)),
    folded: Math.max(0, recent.length - cap),
    earlier: [...older].slice(0, o.all ? undefined : EARLIER_DAYS).map(([day, lines]) => ({ day: longDay(day), lines: o.all ? lines : lines.slice(0, EARLIER_PER_DAY) })),
    earlierFolded: o.all ? 0 : [...older].reduce((n, [, lines], i) => n + (i < EARLIER_DAYS ? Math.max(0, lines.length - EARLIER_PER_DAY) : lines.length), 0),
    // One line only when a scheduled job is late or failing (src/heartbeat.ts, G691); nothing when all
    // is well. Not an ask: it adds nothing to the count and has no card.
    ...((): { late?: string } => { const l = lateLine(lateJobs(root, now), now); return l ? { late: l } : {}; })(),
    // One line when a connected assistant has gone quiet by its own habit (src/quiet.ts, G697, G698):
    // not an ask, nothing added to the count, gone once it reads again.
    ...((): { quiet?: string } => { const l = quietLine(quietAssistants(root, rules, now), (a) => agentTitle(rules, a)); return l ? { quiet: l } : {}; })(),
  };
}

// The memories that lead the face: what the owner just said, then what's next, a role, the facts
// that read as a verb ("prefers"), then other news. A last-contact date, a confirmation, a value
// kept or said again, an undo, a take-back, a receipt, a set-aside and a line that may only say
// "something new" (its card above waits already) are the full list's only.
const FACE_KINDS = new Set(["new", "changed", "settled", "item_added"]);
const faceRank = (l: HomeLine) => l.just ? 0 : l.attr === "next_step" ? 1 : l.attr === "role" ? 2 : l.attr && isVerbAttribute(l.attr) ? 3 : 4;
export function faceLines(lines: HomeLine[], room: number): HomeLine[] {
  const fit = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.just || (FACE_KINDS.has(l.kind ?? "") && l.attr !== "last_contact" && l.undo !== "undone"));
  return fit.sort((a, b) => faceRank(a.l) - faceRank(b.l) || a.i - b.i).slice(0, Math.max(room, fit.filter(({ l }) => l.just).length)).map(({ l }) => l);
}
export const faceRoom = (waiting: number) => Math.max(MIND_MIN_MEMORIES, MIND_CAP - waiting);

// Memory's "Pages that changed" (owner app step 3): one row per page the diary touched in the last
// 7 days, newest first, with its area, the attributes that changed in the owner's words (never a
// value), where the newest change came from and its day. A private page, a private or held fact,
// or a value held for Read it is "something new" only, as on the home.
export interface ChangedPage { id: string; title: string; area?: string; what: string[]; from: string; day: string }
export function changedPages(root: string, rules: Rules, notes: Note[], now: Date, shown: (n: Note) => boolean): ChangedPage[] {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString(), today = dayOf(now.toISOString());
  const out = new Map<string, ChangedPage & { quiet: boolean }>();
  for (const row of readDiary(root).filter((r) => r.at >= since && r.kind !== "held" && r.kind !== "set_aside").reverse()) {
    const hash = row.fact_key.lastIndexOf("#"), id = row.fact_key.slice(0, hash), attr = row.fact_key.slice(hash + 1);
    const n = byId.get(id);
    if (!n || id.startsWith("disputes/") || !shown(n)) continue;
    const f = n.fm.facts?.[attr] as { items?: { unseen?: boolean; valid_to?: string }[]; unseen?: boolean } | undefined;
    const held = !!f && (f.unseen === true || (f.items ?? []).some((i) => i.unseen && !i.valid_to));
    const quiet = held || privateNow(n, attr, row.sensitivity);
    let p = out.get(id);
    if (!p) {
      const day = dayOf(row.at);
      p = { id, title: displayName(id, n.fm.title), ...(n.fm.area ? { area: String(n.fm.area) } : {}), what: [], from: fromWords(row, rules), day: day === today ? "today" : weekday(day), quiet: false };
      out.set(id, p);
    }
    if (quiet) p.quiet = true;
    else if (!p.what.includes(words(attr))) p.what.push(words(attr));
  }
  return [...out.values()].map(({ quiet, ...p }) => (quiet ? { ...p, what: [] } : p));
}

// Who knows' numbers (owner app step 5): what the memory learned in the last 7 days (facts the
// diary saw filed, changed, added to or settled, each once) and when it was last backed up.
export function learnedThisWeek(root: string, now: Date): number {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  return new Set(readDiary(root).filter((r) => r.at >= since && ["new", "changed", "item_added", "settled"].includes(r.kind)).map((r) => r.fact_key)).size;
}
export function backedUpWords(at: string | undefined, now: Date): string | undefined {
  if (!at) return undefined;
  const day = dayOf(at), today = dayOf(now.toISOString());
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return day === today ? "Backed up today" : day === yesterday ? "Backed up yesterday" : `Backed up on ${longDay(day)}`;
}
