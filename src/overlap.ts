// SPDX-License-Identifier: AGPL-3.0-only
// Routines that may do the same job (owner, 2026-11-03: "maybe there's a way to flag overlapping
// things agents do?"; G641, docs/wiki.md "Routines that overlap"). An assistant's routine is a
// `capability` page with `schedule`, `tools` and `status` facts. Two active routines overlap when
// both run on their own (not "on request"), read one source (Gmail, Calendar, Discord…) and do one
// kind of job (alerts, digests, reminders…, read from the title). Code only, never a model. It is a
// hint for the owner: nothing is merged, nothing waits on a tap, and the Gardener's upkeep finding
// is a count under a key that is no page's id.
import type { Note } from "./brain";
import { liveRecords } from "./health";

export interface Overlap { ids: string[]; sources: string[]; job: string }

// The source a tool line names, in the owner's words. "Google Workspace (Calendar, Gmail)" names two.
const SOURCES: [RegExp, string][] = [
  [/\bg-?mail\b/i, "Gmail"], [/\bcalendar\b/i, "Calendar"], [/\bdiscord\b/i, "Discord"], [/\bnotion\b/i, "Notion"],
  [/\bimessage|\btexts?\b/i, "Texts"], [/\boutlook\b/i, "Outlook"], [/\bslack\b/i, "Slack"], [/\blinear\b/i, "Linear"],
  [/\bgithub\b/i, "GitHub"], [/\bgranola\b/i, "Granola"], [/\bdrive\b/i, "Drive"], [/\bagentmail\b/i, "AgentMail"],
];
// The kind of job a title names. The first that matches wins.
const JOBS: [RegExp, string][] = [
  [/\b(digest|brief(ing)?|summary|recap|morning)\b/i, "summaries"],
  [/\b(alerts?|monitor|watch|notif\w*|inbox|triage|critical)\b/i, "alerts"],
  [/\b(remind\w*|follow[- ]?ups?|nudges?)\b/i, "reminders"],
  [/\b(turnover|check-?ins?|cleaning|booking)\b/i, "bookings"],
];
const MANUAL = /\b(on request|on demand|ad hoc|user asks|when asked|any |every .* conversation)/i;
const RETIRED = /^(retired|inactive|off|paused|disabled|stopped)$/i;

const valuesOf = (n: Note, attr: string) => liveRecords(n).filter((x) => x.attr === attr).map((x) => String(x.r.value ?? ""));

export function routineOf(n: Note): { id: string; sources: Set<string>; job: string } | undefined {
  if (n.fm.type !== "capability") return undefined;
  const status = valuesOf(n, "status")[0] ?? "active";
  if (RETIRED.test(status.trim())) return undefined;
  const schedule = valuesOf(n, "schedule").join(" ");
  if (!schedule.trim() || MANUAL.test(schedule)) return undefined;
  const job = JOBS.find(([re]) => re.test(String(n.fm.title ?? "")))?.[1];
  if (!job) return undefined;
  const sources = new Set<string>();
  for (const t of valuesOf(n, "tools")) for (const [re, name] of SOURCES) if (re.test(t)) sources.add(name);
  return sources.size ? { id: n.fm.id, sources, job } : undefined;
}

// Groups of two or more: routines with one kind of job joined by a shared source, transitively.
export function findOverlaps(notes: Note[]): Overlap[] {
  const rs = notes.map(routineOf).filter((r): r is NonNullable<typeof r> => !!r).sort((a, b) => a.id.localeCompare(b.id));
  const parent = new Map(rs.map((r) => [r.id, r.id]));
  const find = (id: string): string => { let p = parent.get(id)!; while (p !== parent.get(p)) p = parent.get(p)!; return p; };
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i]!, b = rs[j]!;
    if (a.job === b.job && [...a.sources].some((s) => b.sources.has(s))) parent.set(find(b.id), find(a.id));
  }
  const groups = new Map<string, typeof rs>();
  for (const r of rs) groups.set(find(r.id), [...(groups.get(find(r.id)) ?? []), r]);
  return [...groups.values()].filter((g) => g.length > 1).map((g) => {
    const shared = [...g[0]!.sources].filter((s) => g.some((x, i) => i > 0 && x.sources.has(s)));
    return { ids: g.map((r) => r.id), sources: shared, job: g[0]!.job };
  });
}
