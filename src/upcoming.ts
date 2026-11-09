// SPDX-License-Identifier: AGPL-3.0-only
// "What's next" from the calendar, at read time (docs/sources-pull.md#whats-next-from-the-calendar).
// A stored next step goes stale the day after it happens; the calendar already knows the next one.
// For a calendar source the owner marks `upcoming: true`, each pull keeps the coming 60 days' events
// (title, place, start and ref; never the description or guests) in a cache outside the brain,
// readable by the owner only. When an agent reads, a note's `next_*` fact that is no longer current
// is served as the soonest coming event that names the note (its title or an alias), citing the
// event. The note file never changes. It happens before the carve, so the carve decides who sees
// it like any fact: the event carries the source's min_sensitivity.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDisputed, isList, sensitivityRank, today, type FactRecord, type Note, type Sensitivity } from "./brain";
import { attributeSpec, type Rules } from "./rules";
import { factFreshness, daysBetween } from "./freshness";
import { findInjection, redactSecrets } from "./checks";

// `who`: the guests' addresses as hashes (guestKey), never the addresses, so a meeting can be tied
// to a person's page by an address the page holds (G695); not the owner, not a room.
export interface Upcoming { id: string; version: string; summary: string; location?: string; start: string; source: string; sensitivity?: Sensitivity; who?: string[] }
interface CacheFile { sources: Record<string, { at: string; events: Upcoming[] }> }

const DAYS = 60;          // how far ahead the cache reaches
export const PAST_DAYS = 92; // how far back it keeps what happened: a quarter, for "last met" (G695)
const MAX = 400;          // events kept per source
const GUESTS = 30;        // guests kept per event; a bigger meeting ties no one by its guest list
const FRESH_DAYS = 2;     // a source not refreshed for this long is no longer "live"; its events are ignored
const MIN_NAME = 4;       // shorter titles or aliases ("HR", "Bob") would match too much

const home = () => process.env.HOME || homedir();
export const upcomingFile = (root: string) =>
  join(resolve(process.env.PB_UPCOMING_DIR || join(home(), ".cache", "pocketbrain", "upcoming")), `${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)}.json`);

const norm = (s: string) => ` ${s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

// An events.list item (singleEvents) as the cache keeps it, or undefined for one that must not be
// kept: cancelled, private or confidential, an injection shape, or no title or start.
export function toUpcoming(r: Record<string, any>, source: string, sensitivity?: Sensitivity): Upcoming | undefined {
  const start = String(r.start?.dateTime ?? r.start?.date ?? "");
  if (!r.id || !r.summary || !start || r.status === "cancelled" || ["private", "confidential"].includes(r.visibility)) return undefined;
  if (findInjection(String(r.summary)) || (r.location && findInjection(String(r.location)))) return undefined;
  const summary = redactSecrets(String(r.summary)).text.slice(0, 200);
  const location = r.location ? redactSecrets(String(r.location)).text.slice(0, 200) : undefined;
  const guests = (Array.isArray(r.attendees) ? r.attendees : []).filter((a: Record<string, unknown>) => a && !a.self && !a.resource && typeof a.email === "string" && !/@resource\.calendar\.google\.com$/i.test(String(a.email)) && a.responseStatus !== "declined");
  const who = guests.length && guests.length <= GUESTS ? [...new Set(guests.map((a: Record<string, unknown>) => guestKey(String(a.email))))] as string[] : [];
  return { id: String(r.id), version: String(r.etag ?? r.updated ?? "1").replace(/"/g, ""), summary, ...(location ? { location } : {}), start, source, ...(sensitivity ? { sensitivity } : {}), ...(who.length ? { who } : {}) };
}

// An address as the cache keeps it: a hash, so the file never holds who the owner meets.
export const guestKey = (email: string) => createHash("sha256").update(`pocketbrain-guest:${email.trim().toLowerCase()}`).digest("hex").slice(0, 20);

function readCache(root: string): CacheFile {
  try { return JSON.parse(readFileSync(upcomingFile(root), "utf8")); } catch { return { sources: {} }; }
}

// One source's coming events, replacing what it had. Owner-only file, outside the brain and its backups.
export function saveUpcoming(root: string, source: string, events: Upcoming[], day = today()) {
  const f = upcomingFile(root);
  const c = readCache(root);
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + DAYS * 864e5).toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - PAST_DAYS * 864e5).toISOString().slice(0, 10);
  const kept = events.filter((e) => e.start.slice(0, 10) >= from && e.start.slice(0, 10) <= end).sort((a, b) => a.start.localeCompare(b.start));
  // Past the cap the coming ones stay and the oldest go.
  c.sources[source] = { at: day, events: kept.slice(Math.max(0, kept.length - MAX)) };
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
  chmodSync(f, 0o600);
  memo = undefined;
}

// Drops a source's events (it was removed, or lost `upcoming: true`).
export function dropUpcoming(root: string, keep: (source: string) => boolean) {
  const f = upcomingFile(root);
  if (!existsSync(f)) return;
  const c = readCache(root);
  const gone = Object.keys(c.sources).filter((s) => !keep(s));
  if (!gone.length) return;
  for (const s of gone) delete c.sources[s];
  writeFileSync(f, JSON.stringify(c), { mode: 0o600 });
  memo = undefined;
}

let memo: { file: string; mtime: number; day: string; events: Upcoming[] } | undefined;
// Every event the cache holds, past quarter and coming 60 days, from sources refreshed in the last
// FRESH_DAYS, soonest first.
export function loadCalendar(root: string, day = today()): Upcoming[] {
  const f = upcomingFile(root);
  let mtime: number;
  try { mtime = statSync(f).mtimeMs; } catch { return []; }
  if (memo && memo.file === f && memo.mtime === mtime && memo.day === day) return memo.events;
  const events = Object.values(readCache(root).sources)
    .filter((s) => s?.at && daysBetween(s.at, day) <= FRESH_DAYS)
    .flatMap((s) => s.events ?? [])
    .sort((a, b) => a.start.localeCompare(b.start));
  memo = { file: f, mtime, day, events };
  return events;
}
// The events still to come today or later, soonest first.
export const loadUpcoming = (root: string, day = today()): Upcoming[] => loadCalendar(root, day).filter((e) => e.start.slice(0, 10) >= day);

// A recurring meeting's instance id is its series id plus the instance's date or time.
export const seriesId = (id: string) => id.replace(/_\d{8}(T\d{6}Z?)?$/, "");
// The coming events of one source whose event (or series) its pull never read: events made long
// before the first sync for a date past its window, or an old series, that no change ever brought
// back through the sync token (G744). Series ids, soonest first, once each.
export function unreadComing(root: string, source: string, seen: Record<string, string>, day = today()): string[] {
  return [...new Set(loadUpcoming(root, day).filter((e) => e.source === source).map((e) => seriesId(e.id)))].filter((id) => !(id in seen));
}

// The meetings tied to a person's page (G694): those whose guests include an address the page
// holds, or whose title names the person in full (two words at least, MIN_NAME letters). The last
// one before today, the next from today on, and how many so far this calendar quarter.
export interface Meetings { last?: Upcoming; next?: Upcoming; quarter: number }
export function meetingsWith(n: Note, events: Upcoming[], day = today(), keep: (e: Upcoming) => boolean = () => true): Meetings {
  const out: Meetings = { quarter: 0 };
  if (n.fm.type !== "person" || !events.length) return out;
  const em = n.fm.facts?.emails;
  const mails = em && !isDisputed(em) ? (isList(em) ? em.items : [em as FactRecord]).filter((r) => r && !r.valid_to && !r.retired && typeof r.value === "string").map((r) => guestKey(String(r.value))) : [];
  const names = [n.fm.title, ...(Array.isArray(n.fm.aliases) ? n.fm.aliases : [])].filter((x): x is string => typeof x === "string" && x.trim().length >= MIN_NAME && /\S\s+\S/.test(x.trim())).map(norm);
  const q = `${day.slice(0, 5)}${String(Math.floor((Number(day.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  for (const e of events) {
    if (!keep(e) || !((e.who ?? []).some((h) => mails.includes(h)) || names.some((nm) => norm(e.summary).includes(nm)))) continue;
    const d = e.start.slice(0, 10);
    if (d < day) { out.last = e; if (d >= q) out.quarter++; } else out.next ??= e;
  }
  return out;
}

// A stamp that changes when the cache does, for read caches keyed on what they served.
export function upcomingStamp(root: string, day = today()): string {
  try { return `${statSync(upcomingFile(root)).mtimeMs}:${day}`; } catch { return `-:${day}`; }
}

const when = (start: string) => (start.length > 10 ? start.slice(0, 16).replace("T", " ") : start);

// The notes as an agent should read them: each `next_*` fact that isn't current, on a note a coming
// event names, served as that event. Only changed notes are copied; the rest are returned as they are.
export function withUpcoming(notes: Note[], rules: Rules, events: Upcoming[], day = today()): Note[] {
  if (!events.length) return notes;
  const texts = events.map((e) => norm(`${e.summary} ${e.location ?? ""}`));
  return notes.map((n) => {
    const facts = n.fm.facts ?? {};
    const stale = Object.entries(facts).filter(([a, f]) => a.startsWith("next_") && !isList(f) && !isDisputed(f)
      && !(f as FactRecord).retired && !(f as FactRecord).valid_to && factFreshness(f, attributeSpec(rules, n.fm.type, a), day) !== "current");
    if (!stale.length) return n;
    const names = [n.fm.title, ...(Array.isArray(n.fm.aliases) ? n.fm.aliases : [])].filter((s): s is string => typeof s === "string" && s.trim().length >= MIN_NAME).map(norm);
    const at = names.length ? texts.findIndex((t) => names.some((nm) => t.includes(nm))) : -1;
    if (at < 0) return n;
    const e = events[at];
    const live = Object.fromEntries(stale.map(([a, f]) => {
      const r = f as FactRecord;
      const rec: FactRecord = {
        value: `${e.summary}, ${when(e.start)}${e.location ? `, ${e.location}` : ""} (from the calendar)`,
        as_of: day, last_confirmed: day, sources: [`gcal:${e.id}@${e.version}`], verification: "verified-by-source",
        by: "calendar", recorded: day,
        ...(e.sensitivity || r.sensitivity ? { sensitivity: [e.sensitivity, r.sensitivity].filter((s): s is Sensitivity => !!s).sort((x, y) => sensitivityRank(y) - sensitivityRank(x))[0] } : {}),
        ...(r.share_with ? { share_with: r.share_with } : {}),
      };
      return [a, rec];
    }));
    return { ...n, fm: { ...n.fm, facts: { ...facts, ...live } } };
  });
}
