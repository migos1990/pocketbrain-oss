// SPDX-License-Identifier: AGPL-3.0-only
// What a project page really is (G787, owner's phone 2026-11-12): a mail or calendar item whose
// title names "a project" the brain doesn't hold started a project page under that title, so a
// flight, a check-in, a booking, an appointment, a game and a provider's survey all became
// projects. Code reads the title, never a model:
//   - travel: a flight, a stay, a booking, a check-in. It is part of a trip: the trip page whose
//     dates hold it is its parent (`tripPlan`), never a project of its own.
//   - event: one dated thing that happens once (an appointment, a game, "A vs B").
//   - errand: a provider's mail (a survey, a contest, a receipt, an order, a renewal).
// None of them is a project: capture never starts a project or decision page for one, and the
// owner's page never lists one as a project. A page the owner has spoken for (a fact in his own
// word) is what he says it is, whatever its title.
import { isDisputed, type Note, type FactRecord } from "./brain";
import { records } from "./carve";
import { isOwnerConfirmed } from "./owner";

export type PieceKind = "travel" | "event" | "errand";

const fold = (t: string) => t.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
// Whole words, accents folded, so "Réservation" is "reservation" and "vol" never matches "volunteer".
const words = (list: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${list})(?![\\p{L}\\p{N}])`, "u");

// A flight code: two letters or a letter and a digit, then 1 to 4 digits ("AC 7978", "TS739", "U2 1234").
// A year is no flight number: "Q4 2026" is a quarter.
const FLIGHT_CODE = /(?:^|[^\p{L}\p{N}])(?:[A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(?!(?:19|20)\d\d(?!\d))\d{1,4}(?![\p{L}\p{N}])/u;
// Where a flight code goes: whole words only ("into" is not "to", "volunteer" not "vol").
const HEADING = words(["flight", "vol", "to", "vers", "pour"].join("|"));
const TRAVEL = words([
  "flight", "flights", "vol", "vols", "boarding pass", "carte d'embarquement", "layover", "escale",
  "check-in", "check in", "checkin", "check-out", "checkout", "arrivee", "depart",
  "reservation", "booking", "booked stay", "airbnb", "vrbo", "hotel", "motel", "auberge", "gite",
  "itinerary", "itineraire", "car rental", "location de voiture", "train to", "train vers", "ferry",
].join("|"));
const EVENT = words([
  "appointment", "appt", "rendez-vous", "rdv", "consultation", "vs", "versus", "webinar", "webinaire",
].join("|"));
const ERRAND = words([
  "survey", "sondage", "questionnaire", "contest", "concours", "giveaway", "sweepstakes", "tirage",
  "promo", "promotion", "newsletter", "infolettre", "receipt", "recu", "invoice", "facture",
  "order #", "order no", "order number", "your order", "votre commande", "commande no", "renewal notice",
  "avis de renouvellement", "confirmation number", "numero de confirmation",
].join("|"));
// A title that ends on one date in brackets is one dated thing: "… check-in (Oct 12, 2026)".
const ONE_DATE = /\((?:[^()]*\d{4}-\d{2}-\d{2}|(?:\p{L}+\.?\s+)?\p{L}{3,}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+\p{L}{3,}\.?\s+\d{4})\)\s*$/u;
// A ticket's or calendar's "what | where" title: "Appointment at Clinic | Town".
const PIPE = /\s\|\s/;

// What a title names, or undefined for a title that reads as a project. Errand first (a "flight
// sale" newsletter is mail), then travel, then a one-off event.
export function titlePiece(title: string): PieceKind | undefined {
  const raw = String(title ?? "");
  const t = fold(raw);
  if (!t.trim()) return undefined;
  if (ERRAND.test(t)) return "errand";
  // A trip is the thing its flights and stays are part of, whatever date its title carries.
  if (isTripTitle(raw)) return undefined;
  if (TRAVEL.test(t) || (FLIGHT_CODE.test(raw) && HEADING.test(t))) return "travel";
  if (EVENT.test(t) || ONE_DATE.test(raw) || PIPE.test(raw)) return "event";
  return undefined;
}

const live = (r: FactRecord) => !r.valid_to && !r.retired;
// The owner has spoken for this page: one of its live facts is in his own word.
export function ownerKept(n: Note): boolean {
  return Object.values(n.fm.facts ?? {}).some((f) => !isDisputed(f) && records(f).filter(live).some((r) => isOwnerConfirmed(r.verification) || (r.sources ?? []).some((x) => /^(?:owner|louis|approved):/.test(String(x)))));
}

// The kind of a project page: by its title, unless the owner spoke for it or it holds other pages
// (a page with parts under it is the thing they are part of).
export function pageKind(n: Note, hasParts = false): PieceKind | undefined {
  if (n.fm.type !== "project" && n.fm.type !== "decision") return undefined;
  if (hasParts || ownerKept(n)) return undefined;
  return titlePiece(String(n.fm.title ?? ""));
}

// ---- Trips -----------------------------------------------------------------------------------
// A trip page: an active project whose title says it is a trip.
const TRIP = words(["trip", "voyage", "vacation", "vacations", "vacances", "holiday", "holidays", "getaway", "sejour", "travel", "travels", "road trip", "escapade", "conge"].join("|"));
export const isTripTitle = (title: string) => TRIP.test(fold(String(title ?? "")));

const MONTHS: [RegExp, number][] = [
  [/^(?:jan|janv|january|janvier)$/, 1], [/^(?:feb|fev|february|fevrier)$/, 2], [/^(?:mar|march|mars)$/, 3],
  [/^(?:apr|avr|april|avril)$/, 4], [/^(?:may|mai)$/, 5], [/^(?:jun|june|juin)$/, 6], [/^(?:jul|juil|july|juillet)$/, 7],
  [/^(?:aug|aou|august|aout)$/, 8], [/^(?:sep|sept|september|septembre)$/, 9], [/^(?:oct|october|octobre)$/, 10],
  [/^(?:nov|november|novembre)$/, 11], [/^(?:dec|december|decembre)$/, 12],
];
const monthOf = (w: string) => MONTHS.find(([re]) => re.test(w.replace(/\.$/, "")))?.[1];
const DAY = 86_400_000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

export interface Span { from: number; to: number }

interface Said { y?: number; m: number; d?: number; at: number }

// Every date a text states, as day spans: "2026-12-12", "Dec 12", "12 décembre", "December 2026"
// (the whole month). A date with no year takes `year`, or the next one when that would put it
// more than 90 days before the first date the text gives with its year (or, with none, before
// its first date): a trip "out Dec 12, back Jan 2" ends in January of the next year.
// Given a day (`on`, YYYY-MM-DD: the page's own day) in place of a year, a date with no year takes
// the year that puts it nearest that day: a flight page made in October that says "Jan 2" is next January.
export function datesIn(text: string, yearOrDay: number | string): Span[] {
  const on = typeof yearOrDay === "string" && /^\d{4}-\d{2}-\d{2}/.test(yearOrDay) ? Date.parse(yearOrDay.slice(0, 10)) : undefined;
  const year = on !== undefined ? new Date(on).getUTCFullYear() : Number(yearOrDay) || new Date().getUTCFullYear();
  const t = fold(String(text ?? ""));
  const said: Said[] = [];
  const taken: [number, number][] = [];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  const take = (m: RegExpMatchArray, s: Omit<Said, "at">) => { const a = m.index!, b = a + m[0].length; if (!free(a, b)) return; taken.push([a, b]); said.push({ ...s, at: a }); };
  for (const m of t.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) take(m, { y: +m[1], m: +m[2], d: +m[3] });
  for (const m of t.matchAll(/(\p{L}{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th|er)?(?:,?\s+(\d{4}))?(?![\p{N}])/gu)) { const mo = monthOf(m[1]!); if (mo) take(m, { y: m[3] ? +m[3] : undefined, m: mo, d: +m[2]! }); }
  for (const m of t.matchAll(/(?<![\p{N}])(\d{1,2})(?:er)?\s+(\p{L}{3,9})\.?(?:\s+(\d{4}))?/gu)) { const mo = monthOf(m[2]!); if (mo) take(m, { y: m[3] ? +m[3] : undefined, m: mo, d: +m[1]! }); }
  for (const m of t.matchAll(/(\p{L}{3,9})\.?,?\s+(\d{4})/gu)) { const mo = monthOf(m[1]!); if (mo) take(m, { y: +m[2]!, m: mo }); }
  said.sort((a, b) => a.at - b.at);
  const withYear = said.filter((s) => s.y !== undefined);
  const first = withYear.length ? utc(withYear[0]!.y!, withYear[0]!.m, withYear[0]!.d ?? 1) : undefined;
  let anchor = first;
  return said.map((s) => {
    if (s.d === undefined) return { from: utc(s.y!, s.m, 1), to: utc(s.m === 12 ? s.y! + 1 : s.y!, s.m === 12 ? 1 : s.m + 1, 1) - DAY };
    if (s.y !== undefined) { const v = utc(s.y, s.m, s.d); return { from: v, to: v }; }
    let v = utc(year, s.m, s.d);
    if (on !== undefined) { const c = [year - 1, year, year + 1].map((y) => utc(y, s.m, s.d!)); return { from: (v = c.sort((a, b) => Math.abs(a - on) - Math.abs(b - on))[0]!), to: v }; }
    if (anchor === undefined) anchor = v;
    else if (v < anchor - 90 * DAY) v = utc(year + 1, s.m, s.d);
    return { from: v, to: v };
  });
}

const shown = (v: unknown): string => typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v);
const DONE = new Set(["archived", "merged", "superseded", "done", "closed", "cancelled", "canceled", "completed"]);
const rankOf = (s: unknown) => ["public", "personal", "private", "secret"].indexOf(String(s ?? "personal"));
// A trip holds at most this many days: "Travel, 2026" is no trip a flight is part of.
const TRIP_MAX_DAYS = 120;
const SLACK = 2 * DAY;

// The days a page says, from its title, its text and its facts every reader of it sees (none hidden
// from one of them, none more private than the page, none shared with one person).
function pageDays(n: Note, hidden: (key: string) => boolean): Span[] {
  const created = String(n.fm.created ?? "");
  // A reference line ("[^1]: Email, 2026-09-12 (…)") dates the source, not the page.
  const parts = [String(n.fm.title ?? ""), (n.body ?? "").split("\n").filter((l) => !/^\[\^[^\]]+\]:/.test(l)).join("\n")];
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (isDisputed(f) || hidden(`${n.fm.id}#${attr}`)) continue;
    for (const r of records(f).filter(live)) if (!r.share_with && (!r.sensitivity || rankOf(r.sensitivity) <= rankOf(n.fm.sensitivity))) parts.push(shown(r.value));
  }
  return datesIn(parts.join("\n"), /^\d{4}-\d{2}-\d{2}/.test(created) ? created : new Date().getUTCFullYear());
}

// On unless the owner turned it off (`pocketbrain wiki trips off`, policy `trips: false`).
export const tripsOn = (rules: { policy: unknown }) => (rules.policy as { trips?: boolean }).trips !== false;

// The first day a page states (title, text and the facts the reader sees), for putting a trip's parts in order.
export function firstDay(n: Note, hidden: (key: string) => boolean = () => true): number | undefined {
  const d = pageDays(n, hidden);
  return d.length ? Math.min(...d.map((s) => s.from)) : undefined;
}

export interface TripPlan { id: string; parent: string }

// Each flight, stay or booking page (titlePiece travel) whose dates fall inside exactly one trip's
// dates, two days either side, is part of that trip. A piece with a parent already, one the owner
// spoke for, or one whose trip some reader of it can't see (`sees`) is left as it is.
export function tripPlan(notes: Note[], hidden: (key: string) => boolean, sees: (child: string, parent: string) => boolean = () => true): TripPlan[] {
  const active = (n: Note) => n.fm.type === "project" && n.fm.id.startsWith("projects/") && !DONE.has(String(n.fm.status ?? "active"));
  const trips = notes.filter((n) => active(n) && isTripTitle(String(n.fm.title ?? "")) && !n.fm.parent).flatMap((n) => {
    const d = pageDays(n, hidden);
    if (!d.length) return [];
    const from = Math.min(...d.map((s) => s.from)), to = Math.max(...d.map((s) => s.to));
    return to - from > TRIP_MAX_DAYS * DAY ? [] : [{ id: n.fm.id, from: from - SLACK, to: to + SLACK }];
  });
  if (!trips.length) return [];
  const out: TripPlan[] = [];
  for (const n of notes) {
    if (!active(n) || n.fm.parent || pageKind(n) !== "travel") continue;
    const d = pageDays(n, hidden);
    const hit = trips.filter((t) => t.id !== n.fm.id && d.some((s) => s.from <= t.to && s.to >= t.from) && sees(n.fm.id, t.id));
    if (hit.length === 1) out.push({ id: n.fm.id, parent: hit[0]!.id });
  }
  return out;
}
