// SPDX-License-Identifier: AGPL-3.0-only
// The week, built by code across pages (plans/next-level.md F1, gaps G688/G689): what falls on each
// of the coming seven days (a due date, a dated next step, a birthday, a calendar event), what went
// past its due date on a page still going, what comes later this month, and the next steps that
// have no date. No model and no new fact: every line is one fact the reader can already see, or
// one event the calendar cache holds (src/upcoming.ts), and carries the page it came from.
//
// Two readers. The owner's page (src/dashboard/owner-book.ts) passes every note and the calendar's
// events. An assistant's context_pack (src/core.ts) passes only the notes and facts its carve shows
// and no events: a coming event reaches an assistant only as the `next_*` fact withUpcoming serves on
// a note it can see, so this block never widens what an assistant reads.
import { isDisputed, isList, type Fact, type FactRecord, type Sensitivity } from "./brain";
import { attributeSpec, type Rules } from "./rules";
import { factFreshness } from "./freshness";
import type { Upcoming } from "./upcoming";

export type WeekKind = "event" | "due" | "date" | "birthday" | "next";
export interface WeekLine {
  kind: WeekKind;
  summary?: string; // a calendar line's event title, to list one event once
  day?: string; // YYYY-MM-DD; none for a next step with no date
  time?: string; // HH:MM, for a timed event
  page?: string; // the page the line is about (for an event, the first page its title names)
  attr?: string; // the fact the line is (none for a calendar event)
  what: string; // the line's own words, without the page's title
  record?: FactRecord; // the fact's record, for its source
  event?: Upcoming;
  sensitivity?: Sensitivity; // the event's own, for a calendar line
}
export interface Week { from: string; to: string; days: { day: string; lines: WeekLine[] }[]; past: WeekLine[]; later: WeekLine[]; next: WeekLine[] }
// A page as the week reads it: its facts are the ones this reader can see.
export interface WeekNote { id: string; title: string; type: string; status?: unknown; aliases?: unknown; facts: [string, Fact][] }

export const WEEK_DAYS = 7, PAST_DAYS = 30, LATER_DAYS = 30;
export const WEEK_CAPS = { day: 6, past: 4, later: 4, next: 5 };
const DUE = /^(due|deadline|due_date|ends?|end_date)$/;
const DONE = /^(done|closed|archived|cancelled|canceled|finished|retired|complete|completed)$/i;
const ISO = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/;
// A next step the calendar serves (withUpcoming): "<title>, 2026-11-10 14:00, <place> (from the calendar)".
const FROM_CAL = /^(.*), (\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?(?:, (.*))? \(from the calendar\)$/;
const LINK = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const MIN_NAME = 4;
// A day written in a next step's words: "on 15 October", "by Oct 9", "le 3 décembre", or YYYY-MM-DD.
const MONTHS = /(january|february|march|april|may|june|july|august|september|october|november|december|janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?/u;
const MONTH_IX = (w: string) => ["jan", "feb|fev|fév", "mar", "apr|avr", "may|mai", "jun|juin", "jul|juil", "aug|aou|aoû", "sep", "oct", "nov", "dec|déc"].findIndex((x) => new RegExp(`^(${x})`, "u").test(w.toLowerCase()));
const DAY_MONTH = new RegExp(`(?<![\\p{L}\\p{N}])(\\d{1,2})(?:st|nd|rd|th|er)? ${MONTHS.source}(?![\\p{L}])`, "iu");
const MONTH_DAY = new RegExp(`(?<![\\p{L}])${MONTHS.source} (\\d{1,2})(?:st|nd|rd|th)?(?![\\p{L}\\p{N}])`, "iu");
// The day a next step names in its words, in the year that puts it nearest after it was said.
export function dayInWords(text: string, said: string): string | undefined {
  const iso = text.match(/(?<![\d-])(\d{4}-\d{2}-\d{2})(?![\d-])/);
  if (iso) return iso[1];
  const a = text.match(DAY_MONTH), b = a ? undefined : text.match(MONTH_DAY);
  const [d, m] = a ? [Number(a[1]), MONTH_IX(a[2])] : b ? [Number(b[2]), MONTH_IX(b[1])] : [0, -1];
  if (m < 0 || d < 1 || d > 31) return undefined;
  const y = Number(said.slice(0, 4)) || new Date().getUTCFullYear();
  const at = (yy: number) => `${yy}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  // Said in December about "3 January": next year. A day up to a month before it was said is this year's (a late note).
  return at(y) < addDays(said.slice(0, 10), -31) ? at(y + 1) : at(y);
}

function addDays(day: string, n: number): string { return new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10); }
const norm = (s: string) => ` ${s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
const words = (attr: string) => attr.replace(/[_-]+/g, " ").trim();

// The record a single fact holds now, or undefined for a list, a dispute (use neither), a retired
// or ended one.
function live(f: Fact): FactRecord | undefined {
  if (isList(f) || isDisputed(f)) return undefined;
  const r = f as FactRecord;
  return r.retired || r.valid_to ? undefined : r;
}

// A value as words: a link reads as the title of a page this reader can see; a link to any other
// page drops the line (hidden answers like missing).
function said(v: unknown, title: (id: string) => string | undefined): string | undefined {
  if (v === undefined || v === null || typeof v === "object") return undefined;
  let gone = false;
  const s = String(v).replace(LINK, (_m, id: string, label?: string) => { const t = title(id.trim()); if (!t) gone = true; return label?.trim() || t || ""; }).trim();
  return gone || !s ? undefined : s;
}

// This year's (or next year's) day of a birthday held as MM-DD or YYYY-MM-DD, on or after `from`.
function nextBirthday(v: string, from: string): string | undefined {
  const m = v.trim().match(/^(?:\d{4}-)?(\d{2})-(\d{2})$/);
  if (!m) return undefined;
  const y = Number(from.slice(0, 4));
  const at = (yy: number) => `${yy}-${m[1]}-${m[2]}`;
  return at(y) >= from ? at(y) : at(y + 1);
}

// A page still going: a project marked anything but active, or whose status fact says it ended, is not.
const ongoing = (n: WeekNote) => {
  if (n.type === "project" && String(n.status ?? "active") !== "active") return false;
  const st = n.facts.find(([a]) => a === "status")?.[1];
  return !DONE.test(String((st ? live(st)?.value : undefined) ?? ""));
};

// The week from `day`: every reader passes what it can see; the caller renders.
export function weekOf(notes: WeekNote[], rules: Rules, events: Upcoming[], day: string, title: (id: string) => string | undefined): Week {
  const to = addDays(day, WEEK_DAYS - 1), pastFrom = addDays(day, -PAST_DAYS), laterTo = addDays(day, WEEK_DAYS - 1 + LATER_DAYS);
  const dated: WeekLine[] = [], past: WeekLine[] = [], next: (WeekLine & { at: string })[] = [];
  for (const n of notes) {
    const going = ongoing(n);
    for (const [attr, f] of n.facts) {
      const r = live(f);
      if (!r) continue;
      const v = String(r.value ?? "");
      if (attr === "birthday") {
        const d = nextBirthday(v, day);
        if (d) dated.push({ kind: "birthday", day: d, page: n.id, attr, what: "birthday", record: r });
        continue;
      }
      if (!going) continue;
      const cal = r.by === "calendar" ? v.match(FROM_CAL) : null;
      if (attr.startsWith("next_") && cal) {
        dated.push({ kind: "event", day: cal[2], ...(cal[3] ? { time: cal[3] } : {}), page: n.id, attr, what: [cal[1], cal[4]].filter(Boolean).join(", "), summary: cal[1], record: r });
        continue;
      }
      const iso = v.match(ISO);
      if (iso && (DUE.test(attr) || attr.startsWith("next_"))) {
        const line: WeekLine = { kind: DUE.test(attr) ? "due" : "date", day: iso[1], ...(iso[2] ? { time: iso[2] } : {}), page: n.id, attr, what: DUE.test(attr) ? "due" : words(attr), record: r };
        if (iso[1] < day) { if (line.kind === "due" && iso[1] >= pastFrom) past.push(line); }
        else dated.push(line);
        continue;
      }
      // A next step with no date, on a project still going, while it is not stale.
      if (attr === "next_step" && n.type === "project" && factFreshness(f, attributeSpec(rules, n.type, attr), day) !== "stale") {
        const w = said(r.value, title);
        if (!w) continue;
        // A step that names its day goes on that day; one whose day went by is no longer next.
        const d = dayInWords(w, String(r.as_of ?? day));
        if (d && d < day) continue;
        if (d) dated.push({ kind: "next", day: d, page: n.id, attr, what: w, record: r });
        else next.push({ kind: "next", page: n.id, attr, what: w, record: r, at: String(r.last_confirmed ?? r.as_of ?? "") });
      }
    }
  }
  // The calendar's own events (the owner's reader only), each with the first page its words name.
  const names = notes.flatMap((n) => [n.title, ...(Array.isArray(n.aliases) ? n.aliases : [])].filter((s): s is string => typeof s === "string" && s.trim().length >= MIN_NAME).map((s) => ({ id: n.id, name: norm(s) })))
    .sort((a, b) => b.name.length - a.name.length);
  const seen = new Set(dated.filter((l) => l.kind === "event").map((l) => `${l.day}|${l.time ?? ""}|${l.summary ?? l.what}`));
  for (const e of events) {
    const d = e.start.slice(0, 10), time = e.start.length > 10 ? e.start.slice(11, 16) : undefined;
    if (d < day || d > laterTo || seen.has(`${d}|${time ?? ""}|${e.summary}`)) continue;
    const text = norm(`${e.summary} ${e.location ?? ""}`);
    const page = names.find((x) => text.includes(x.name))?.id;
    dated.push({ kind: "event", day: d, ...(time ? { time } : {}), ...(page ? { page } : {}), what: [e.summary, e.location].filter(Boolean).join(", "), event: e, ...(e.sensitivity ? { sensitivity: e.sensitivity } : {}) });
  }
  const order = (a: WeekLine, b: WeekLine) => (a.day ?? "").localeCompare(b.day ?? "") || (a.time ?? "99").localeCompare(b.time ?? "99") || a.what.localeCompare(b.what);
  dated.sort(order);
  const days = Array.from({ length: WEEK_DAYS }, (_, i) => addDays(day, i)).map((d) => ({ day: d, lines: dated.filter((l) => l.day === d) })).filter((x) => x.lines.length);
  return {
    from: day, to, days,
    past: past.sort(order).reverse(),
    later: dated.filter((l) => l.day! > to && l.day! <= laterTo && l.kind !== "birthday"),
    next: next.sort((a, b) => b.at.localeCompare(a.at) || a.what.localeCompare(b.what)).map(({ at: _a, ...l }) => l),
  };
}
