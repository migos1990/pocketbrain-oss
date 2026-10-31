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

export interface Upcoming { id: string; version: string; summary: string; location?: string; start: string; source: string; sensitivity?: Sensitivity }
interface CacheFile { sources: Record<string, { at: string; events: Upcoming[] }> }

const DAYS = 60;          // how far ahead the cache reaches
const MAX = 200;          // events kept per source
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
  return { id: String(r.id), version: String(r.etag ?? r.updated ?? "1").replace(/"/g, ""), summary, ...(location ? { location } : {}), start, source, ...(sensitivity ? { sensitivity } : {}) };
}

function readCache(root: string): CacheFile {
  try { return JSON.parse(readFileSync(upcomingFile(root), "utf8")); } catch { return { sources: {} }; }
}

// One source's coming events, replacing what it had. Owner-only file, outside the brain and its backups.
export function saveUpcoming(root: string, source: string, events: Upcoming[], day = today()) {
  const f = upcomingFile(root);
  const c = readCache(root);
  const end = new Date(Date.parse(`${day}T00:00:00Z`) + DAYS * 864e5).toISOString().slice(0, 10);
  c.sources[source] = { at: day, events: events.filter((e) => e.start.slice(0, 10) >= day && e.start.slice(0, 10) <= end).sort((a, b) => a.start.localeCompare(b.start)).slice(0, MAX) };
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
// The events still to come today or later, from sources refreshed in the last FRESH_DAYS, soonest first.
export function loadUpcoming(root: string, day = today()): Upcoming[] {
  const f = upcomingFile(root);
  let mtime: number;
  try { mtime = statSync(f).mtimeMs; } catch { return []; }
  if (memo && memo.file === f && memo.mtime === mtime && memo.day === day) return memo.events;
  const events = Object.values(readCache(root).sources)
    .filter((s) => s?.at && daysBetween(s.at, day) <= FRESH_DAYS)
    .flatMap((s) => s.events ?? []).filter((e) => e.start.slice(0, 10) >= day)
    .sort((a, b) => a.start.localeCompare(b.start));
  memo = { file: f, mtime, day, events };
  return events;
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
