// SPDX-License-Identifier: AGPL-3.0-only
// The owner's home (phone UI spec §2.1, owner 2026-10-26): a greeting, the text box, what waits on
// the owner (only real conflicts so far), and the diary of what the brain learned, newest day first,
// each line with Undo. Built from diary/*.jsonl (src/diary.ts), never from git log. The page itself is
// html-home.ts; the words are the owner's (test/owner-copy.test.ts).
import type { Note } from "../brain";
import { isDisputed, sensitivityRank } from "../brain";
import type { Rules } from "../rules";
import { ownerName, ownAssistant } from "../rules";
import { isOwnerId } from "../owner";
import { readDiary, shownValue, displayName, sayDay, sayDays, ID_IN_TEXT, type DiaryRow } from "../diary";
import { ownerLocal } from "../clock";
import { ownerConflicts } from "../core";
import { unseenFacts } from "../seen";
import { inboxConflicts } from "../settle-inbox";
import { comms } from "./data";
import { agentLabel, cap } from "./labels";
import { loadRules } from "../rules";
import { readEntriesSince, type ReadEntry } from "../readlog";
import type { WrongLine } from "./home-beliefs";
import { ownerDay } from "../clock";
import type { Mark } from "./marks";

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
}
export interface Waiting { what: string; verb: string; href: string; seen?: string; stranger?: boolean } // seen: a held fact's key, for its Show button; stranger: from an address the pages don't hold
// reads: each assistant (its policy key and the name the owner knows it by) and how many times it read the brain since the owner's midnight.
// wrong, more, sees, of, seeHref: the belief radar and See as for that assistant (home-beliefs.ts), added by the dashboard.
export interface HomeView { name: string; date: string; reads: { agent: string; name: string; today: number; asked?: AskLine[]; askedMore?: number; wrong?: WrongLine[]; more?: number; sees?: number; of?: number; seeHref?: string }[]; waiting: Waiting[]; gardener: Waiting[]; since: HomeLine[]; folded: number; earlier: { day: string; lines: HomeLine[] }[]; earlierFolded: number }

export const SINCE_CAP = 7;
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
const OWNER_WORDS: Record<string, string> = { next_step: "next thing to do" };
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

export function fromWords(row: Pick<DiaryRow, "source_word" | "by">, rules: Rules): string {
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
  roleChanged: "{title} is {value} now",
  roleSettled: "You settled it: {title} is {value}",
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
  somethingNew: "Something new about {title}",
  heldUntil: "Something new about {title}, held until {until}",
  questionSetAside: "A question about {title} was set aside, since only a conflict asks you",
  takeBackSetAside: "A take-back on {title} was set aside, since only a conflict asks you",
  receipt: "A receipt on {title} was set aside; receipts aren't facts",
  disagree: "Two sources disagree on {title}'s {attr}",
  disagreeNext: "Two sources disagree on what's next for {title}",
} as const;
export type LineKey = keyof typeof LINE_COPY;
export function lineWords(k: LineKey, v: Partial<Record<"title" | "attr" | "value" | "older" | "source" | "until", string>>): string {
  const s = LINE_COPY[k].replace(/\{title\}'s/g, () => /s$/i.test(v.title ?? "") ? `${v.title}'` : `${v.title}'s`).replace(/\{(\w+)\}/g, (_m, x: string) => (v as Record<string, string>)[x] ?? "");
  return s.charAt(0).toUpperCase() + s.slice(1);
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
  const shapeless = held || sensitivityRank(row.sensitivity) >= sensitivityRank("private");
  const from = `${fromWords(row, rules)}, ${weekday(dayOf(row.at))}`;
  // An assistant's proposal held until its day, or one set aside (src/filing.ts): never its value.
  if (row.kind === "held") return { token: row.undo_token, page: id, what: lineWords("heldUntil", { title: row.title, until: row.until ? longDay(row.until) : "you let it file" }), from, undo: "none", maybe: false, shapeless: true };
  if (row.kind === "set_aside") return { token: row.undo_token, page: id, what: lineWords(attr === "open_question" ? "questionSetAside" : "takeBackSetAside", { title: row.title }), from, undo: "none", maybe: false, shapeless: true };
  const verb = isVerbAttribute(attr);
  const w = (k: LineKey) => lineWords(k, { title: row.title!, attr: a, value: say(row.to), older: olderSay(row), source: CONFIRMED_BY[row.source_word] ?? "source" });
  // A few attributes have their own sentence: what's next, when the owner was last in touch, a role.
  const own = attr === "next_step" ? "next" : attr === "last_contact" ? "contact" : attr === "role" ? "role" : undefined;
  const what = row.why === "receipt" ? w("receipt")
    : shapeless ? w("somethingNew")
    : verb && (row.kind === "new" || row.kind === "item_added") ? w("verbNew")
    : verb && row.kind === "changed" ? w("verbChanged")
    : verb && row.kind === "settled" ? w("verbSettled")
    : verb && row.kind === "kept" && row.source_word !== "you" ? w("verbKept")
    : own && (row.kind === "new" || row.kind === "changed" || row.kind === "settled") ? w(`${own}${row.kind === "new" ? "New" : row.kind === "changed" ? "Changed" : "Settled"}` as LineKey)
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
  const about = row.why === "receipt" ? {} : { key: row.fact_key, ...(held ? { held } : {}) };
  if (row.kind === "kept" || (row.kind === "confirmed" && !row.added?.length)) return { token: row.undo_token, page: id, what, from, undo: "none", maybe: false, shapeless, ...about };
  const note = notes.get(id);
  const now = note ? shownValue(note.fm.facts?.[attr]) : undefined;
  const same = JSON.stringify(now ?? null) === JSON.stringify(row.kind === "retracted" ? null : row.kind === "item_added" ? undefined : row.to ?? null);
  const itemThere = row.kind === "item_added" && Array.isArray(now) && now.some((v) => JSON.stringify(v) === JSON.stringify(row.to));
  const undo = row.kind === "undone" ? "none" : undone.has(row.undo_token) ? "undone" : (same || itemThere) && !(note?.fm.facts?.[attr] && isDisputed(note.fm.facts[attr])) ? "undo" : "changed";
  return { token: row.undo_token, page: id, what, from, ...(row.kind === "changed" && !shapeless && row.from !== undefined ? { was: say(row.from) } : {}), undo, maybe: row.confidence === "inferred", shapeless, ...about };
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
function conflicts(root: string, now: Date, expand = false): { waiting: Waiting[]; gardener: Waiting[] } {
  const open = ownerConflicts(root, now, { held: true });
  const disagree = (page: string, title: string | undefined, attr: string) => lineWords(attr === "next_step" ? "disagreeNext" : "disagree", { title: displayName(page, title), attr: words(attr) });
  const line = (c: (typeof open)[number], verb: string) => ({ what: disagree(c.page, c.title, c.attr), verb, href: `/settle/${c.id}` });
  // What the owner hasn't seen yet is held from every assistant (spec §7): named, never shown here.
  const held = unseenFacts(root).map((u) => ({ what: lineWords("somethingNew", { title: displayName(u.page, u.title) }), verb: `${u.unknownSender ? "from an address your pages don't hold · " : ""}only you can see it yet`, href: `/p/${u.page.split("/").map(encodeURIComponent).join("/")}`, seen: u.fact_key, ...(u.unknownSender ? { stranger: true } : {}) }));
  // A contradiction the write path handed over as a proposal is a conflict too (settle-inbox.ts).
  const inbox = inboxConflicts(root).map((c) => ({ what: disagree(c.page, c.title, c.attr), verb: "tap to settle", href: `/settle/${c.id}` }));
  // A message the relay held between two assistants: send it or not, on its own settle screen.
  const rules = loadRules(root);
  const mail = comms(root).filter((m) => m.verdict === "held").map((m) => ({ what: `${cap(agentLabel(rules, m.from))}'s message to ${agentLabel(rules, m.to)} is held`, verb: "tap to decide", href: `/settle/m-${m.id}` }));
  // Each held value is its own locked card with Read it (owner app brief, 2026-10-30), after the
  // conflicts, but only a few (owner's phone, 2026-10-29: a wall of receipts was the first thing on
  // the home); the rest are one line, a tap away.
  const shown = held.length > HELD_EACH && !expand ? [...held.slice(0, HELD_EACH), { what: `${held.length - HELD_EACH} more new private things`, verb: "only you can see them yet · tap to see them", href: "/home?all=1" }] : held;
  return { waiting: [...open.filter((c) => !c.held).map((c) => line(c, "tap to settle")), ...inbox, ...mail, ...shown], gardener: open.filter((c) => c.held).map((c) => line(c, "the Gardener looks tonight")) };
}

// How many things the home lists as waiting on the owner: the one count the digest and the text
// say too (conflicts to settle and held values to see; never the Gardener's, never an alert).
export function waitingCount(root: string, now = new Date()): number {
  return conflicts(root, now, true).waiting.length;
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
      return { agent: k, name: a.label ?? k, today: mine.length, ...(asked.length ? { asked: asked.slice(0, ASKS_PER_ASSISTANT), ...(asked.length > ASKS_PER_ASSISTANT ? { askedMore: asked.length - ASKS_PER_ASSISTANT } : {}) } : {}) };
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
    name: firstName(rules),
    date: longDay(today),
    reads: assistantReads(root, rules, now, notes, o.fresh ?? true),
    ...conflicts(root, now, o.all),
    since: recent.slice(0, cap).map(([r, l]) => (justSaid(r) ? { ...l, just: true } : l)),
    folded: Math.max(0, recent.length - cap),
    earlier: [...older].slice(0, o.all ? undefined : EARLIER_DAYS).map(([day, lines]) => ({ day: longDay(day), lines: o.all ? lines : lines.slice(0, EARLIER_PER_DAY) })),
    earlierFolded: o.all ? 0 : [...older].reduce((n, [, lines], i) => n + (i < EARLIER_DAYS ? Math.max(0, lines.length - EARLIER_PER_DAY) : lines.length), 0),
  };
}

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
    const quiet = held || sensitivityRank(row.sensitivity) >= sensitivityRank("private") || sensitivityRank(n.fm.sensitivity) >= sensitivityRank("private");
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
