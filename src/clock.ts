// SPDX-License-Identifier: AGPL-3.0-only
// One clock (backlog 273): every per-day rule (the budget alert, the night pass and digest, the
// handoff cap, the verify_source cap, a source's failure alert) counts days in the owner's
// timezone, policy.yaml owner.timezone, the same zone the gardener's windows use. A UTC day
// would start at 20:00 in Toronto, so an alert meant once a day came twice in one evening.
import type { Rules } from "./rules";

export const DEFAULT_TZ = "America/Toronto";
// The time the hub goes by. PB_NOW lets tests pin it; only the operator sets the environment.
export const clock = () => (process.env.PB_NOW ? new Date(process.env.PB_NOW) : new Date());
export const timezoneOf = (rules: Rules) => rules.policy.owner?.timezone?.trim() || DEFAULT_TZ;

// The owner's date (YYYY-MM-DD), hour (0-23) and weekday (0 = Sunday) at `now` in zone `tz`. An
// unknown zone name falls back to the default rather than throwing on every request.
function partsIn(tz: string, now: Date): { day: string; hour: number; dow: number } {
  const fmt = (z: string) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  let p: Record<string, string>;
  try { p = fmt(tz); } catch { p = fmt(DEFAULT_TZ); }
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), dow: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(String(p.weekday).toLowerCase().slice(0, 3)) };
}
export const ownerClock = (rules: Rules, now: Date = clock()) => partsIn(timezoneOf(rules), now);
export const ownerDay = (rules: Rules, at: Date | string = clock()) => ownerClock(rules, typeof at === "string" ? new Date(at) : at).day;

// The day in zone `tz` (a policy's owner.timezone, or the default), for code that holds a policy
// but not a whole Rules.
export const zoneDay = (tz: string | undefined, at: Date = clock()) => partsIn(tz?.trim() || DEFAULT_TZ, at).day;

// brain.ts today() (dates on facts, handoff folders, decided and done stamps) has no brain to read,
// so loadRules records the zone of the last policy it read; before any, the default. One process
// serves one brain (the hub, the CLI); a process that reads two brains' rules stamps dates in the
// zone of the one it read last (G287), a day off at most.
let zone = DEFAULT_TZ;
export const setOwnerZone = (tz?: string) => { zone = tz?.trim() || DEFAULT_TZ; };
export const ownerToday = (now: Date = clock()) => partsIn(zone, now).day;

// A stored timestamp as the owner reads it (backlog 353): "YYYY-MM-DDTHH:MM" in the owner's zone,
// so the dashboard's dates and times match their evening, not UTC's next day. A bare date or
// anything that isn't a timestamp is returned as it is.
export function ownerLocal(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return iso;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const fmt = (z: string) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t).map((p) => [p.type, p.value]));
  let p: Record<string, string>;
  try { p = fmt(zone); } catch { p = fmt(DEFAULT_TZ); }
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
