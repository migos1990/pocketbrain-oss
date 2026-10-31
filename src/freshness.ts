// SPDX-License-Identifier: AGPL-3.0-only
// Freshness is computed when a view is built, never stored (memory-shape.md 4.8).
import type { FactRecord, Fact } from "./brain";
import { isDisputed, isList } from "./brain";
import type { AttributeSpec } from "./rules";
import { shelfLifeDays } from "./rules";

export type Freshness = "current" | "due" | "stale" | "disputed";

function toDate(d: string): Date {
  // partial dates count from the start of their period
  const s = d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d.slice(0, 10);
  return new Date(s + "T00:00:00Z");
}

export function daysBetween(a: string, b: string): number {
  return Math.floor((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  janv: 1, janvier: 1, fevr: 2, fevrier: 2, mars: 3, avr: 4, avril: 4, mai: 5, juin: 6, juil: 7, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const pad = (n: number) => String(n).padStart(2, "0");

// The dates a value names: ISO (2026-10-15), "Oct 14[, 2026]" and "14 octobre [2026]". A date with no
// year is in the year it was written, or the next one when that would put it over 60 days before.
export function datesIn(value: string, asOf: string): string[] {
  const t = value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const out = [...t.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/g)].map((m) => `${m[1]}-${m[2]}-${m[3]}`);
  const day = (mo: string, d: string, y?: string) => {
    const m = MONTHS[mo.replace(/\.$/, "")];
    if (!m || +d < 1 || +d > 31) return;
    let year = y ? +y : +asOf.slice(0, 4);
    if (!y && daysBetween(`${year}-${pad(m)}-${pad(+d)}`, asOf) > 60) year++;
    out.push(`${year}-${pad(m)}-${pad(+d)}`);
  };
  for (const m of t.matchAll(/\b([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?\b(?:,? (20\d\d))?/g)) day(m[1], m[2], m[3]);
  for (const m of t.matchAll(/\b(\d{1,2})(?:er)? ([a-z]{3,9})\.?(?: (20\d\d))?\b/g)) day(m[2], m[1], m[3]);
  return out;
}

// True when a value names dates and the latest of them is before today.
export function pastDate(value: unknown, asOf: string, now: string): boolean {
  if (typeof value !== "string") return false;
  const ds = datesIn(value, asOf).sort();
  return ds.length > 0 && ds[ds.length - 1] < now.slice(0, 10);
}

// The day a fact that ends on its date (a next step, a due date, a deadline, any `until_date`
// attribute) named, once that day has passed and nobody confirmed the fact on or after it.
// The owner's "Still true" under Needs a look (`confirmFact`) confirms it, so the
// fact reads current again until a later day it names passes.
export function passedDay(r: FactRecord, spec: AttributeSpec, now: string): string | undefined {
  if (!(spec.ends_on_date || spec.shelf_life === "until_date") || typeof r.value !== "string") return undefined;
  const d = datesIn(r.value, r.as_of).sort().at(-1);
  if (!d || d >= now.slice(0, 10) || (r.last_confirmed && r.last_confirmed >= d)) return undefined;
  return d;
}

export function recordFreshness(r: FactRecord, spec: AttributeSpec, now: string): Freshness {
  if (passedDay(r, spec, now)) return "stale";
  if (r.review_after && r.review_after <= now) return "due";
  const shelf = shelfLifeDays(spec);
  if (!shelf) return "current";
  const age = daysBetween(r.last_confirmed ?? r.as_of, now);
  if (age > 2 * shelf) return "stale";
  if (age > shelf) return "due";
  return "current";
}

export function factFreshness(f: Fact, spec: AttributeSpec, now: string): Freshness {
  if (isDisputed(f)) return "disputed";
  if (isList(f)) {
    const live = f.items.filter((i) => !i.valid_to);
    if (live.some((i) => (i as { dispute?: string }).dispute)) return "disputed";
    const levels = live.map((i) => recordFreshness(i, spec, now));
    return levels.includes("stale") ? "stale" : levels.includes("due") ? "due" : "current";
  }
  return recordFreshness(f as FactRecord, spec, now);
}

// How a fact ages (memory-graph.md item 5, docs/wiki.md "Facts that change and facts that don't"):
// "changes" for a kind with a shelf life, with the day to check it again by; "fixed" for a kind
// declared in checks.yaml with none (an outcome, a website); nothing for a kind not declared,
// since nobody said how it ages.
export type Life = { kind: "changes"; by?: string } | { kind: "fixed" } | { kind: "latest" };
export function lifeOf(r: FactRecord, spec: AttributeSpec, declared: boolean): Life | undefined {
  const days = shelfLifeDays(spec);
  if (days) {
    const from = toDate(r.last_confirmed ?? r.as_of);
    return Number.isFinite(from.getTime()) ? { kind: "changes", by: new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10) } : { kind: "changes" };
  }
  if (spec.shelf_life === "until_date" || spec.ends_on_date) return { kind: "changes" };
  if (spec.merge === "latest") return { kind: "latest" };
  return declared ? { kind: "fixed" } : undefined;
}
