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

export function recordFreshness(r: FactRecord, spec: AttributeSpec, now: string): Freshness {
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
