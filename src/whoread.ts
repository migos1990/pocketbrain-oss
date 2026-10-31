// SPDX-License-Identifier: AGPL-3.0-only
// Who read what: per agent per day, the notes it was handed and the words it searched for, from
// the read log (log/reads.jsonl), with one 'unusual' line when most of a day's notes sit outside
// the areas the agent read in the 28 days before. Owner only: `pocketbrain reads <agent>` and the
// dashboard's agent page; never served to an agent. See docs/sleep-and-explain.md.
import { loadBrain, today as todayDate, type Note } from "./brain";
import { loadRules, type Rules } from "./rules";
import { readEntries, type ReadEntry } from "./readlog";
import { oneLine } from "./memsync";

export const USUAL_DAYS = 28;
// An agent needs reads on this many earlier days before a day can be called unusual, and a day
// needs this many distinct notes outside its usual areas, at least half of the day's notes.
export const USUAL_MIN_DAYS = 3;
export const UNUSUAL_MIN_NOTES = 2;

export interface ReadDay {
  day: string;
  notes: { id: string; area: string; n: number }[];
  searches: { op: string; q: string; hits: number }[];
  whole: number; // whole-view pulls (context_pack with no topic): no note named
  asked: number; // notes asked for and not given (hidden or missing)
  unusual?: { outside: string[]; areas: string[]; of: number };
}

// The dashboard passes the notes, rules and read log it already holds, so a page reads no file again.
export interface ReadsOpts { days?: number; today?: string; tz?: string; entries?: ReadEntry[]; notes?: Note[]; rules?: Rules }

const dayIn = (tz: string) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : f.format(d); };
};
const minus = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
// Note ids only: "*" is the whole view, "log:" ids are the agent's own logs.
const noteIds = (e: ReadEntry) => (e.ids ?? []).filter((id) => id !== "*" && !String(id).startsWith("log:"));

export function readsByDay(root: string, agent: string, o: ReadsOpts = {}): ReadDay[] {
  const rules = o.rules ?? loadRules(root);
  let tz = o.tz ?? rules.policy.owner?.timezone ?? "UTC";
  try { dayIn(tz); } catch { tz = "UTC"; }
  const dayOf = dayIn(tz);
  const last = o.today ?? todayDate(), first = minus(last, (o.days ?? 7) - 1), from = minus(first, USUAL_DAYS);
  const area = new Map((o.notes ?? loadBrain(root, { shared: true })).map((n) => [n.fm.id, n.fm.area || "(none)"]));
  const areaOf = (id: string) => area.get(id) ?? "(gone)";
  const mine = (o.entries ?? readEntries(root)).filter((e) => e.agent === agent).map((e) => ({ e, day: dayOf(e.at) })).filter((x) => x.day >= from && x.day <= last);

  const out: ReadDay[] = [];
  const byDay = new Map<string, ReadEntry[]>();
  for (const { e, day } of mine) if (day >= first) (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(e);
  for (const day of [...byDay.keys()].sort().reverse()) {
    const es = byDay.get(day)!;
    const count = new Map<string, number>();
    for (const e of es) for (const id of noteIds(e)) count.set(id, (count.get(id) ?? 0) + 1);
    const notes = [...count].map(([id, n]) => ({ id, area: areaOf(id), n })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
    const searches = es.filter((e) => e.q).map((e) => ({ op: e.op, q: oneLine(String(e.q)), hits: noteIds(e).length }));
    const d: ReadDay = { day, notes, searches, whole: es.filter((e) => (e.ids ?? []).includes("*")).length, asked: es.filter((e) => e.asked).length };
    // The usual areas: every area the agent was handed a note from in the 28 days before.
    const before = mine.filter((x) => x.day < day && x.day >= minus(day, USUAL_DAYS));
    const usual = new Set(before.flatMap((x) => noteIds(x.e).map(areaOf)));
    const seenDays = new Set(before.filter((x) => noteIds(x.e).length).map((x) => x.day)).size;
    const outside = notes.filter((n) => !usual.has(n.area)).map((n) => n.id).sort();
    if (seenDays >= USUAL_MIN_DAYS && outside.length >= UNUSUAL_MIN_NOTES && outside.length * 2 >= notes.length)
      d.unusual = { outside, areas: [...new Set(outside.map(areaOf))].sort(), of: notes.length };
    out.push(d);
  }
  return out;
}

// The CLI's text. Search words are the agent's own: control characters and line breaks become
// spaces, so they can't forge a line or an escape in the owner's terminal.
export function readsReport(root: string, agent: string, o: ReadsOpts = {}): string {
  const days = readsByDay(root, agent, o);
  if (!days.length) return `${agent} read nothing in the last ${o.days ?? 7} day(s).`;
  const L: string[] = [];
  for (const d of days) {
    L.push(`${d.day}  ${d.notes.length} note(s)${d.whole ? `, ${d.whole} whole-view pull(s)` : ""}${d.asked ? `, ${d.asked} not given` : ""}`);
    if (d.unusual) L.push(`  unusual: ${d.unusual.outside.length} of ${d.unusual.of} notes outside its usual areas (${d.unusual.areas.join(", ")})`);
    for (const n of d.notes) L.push(`  ${n.id}  [${n.area}]${n.n > 1 ? ` x${n.n}` : ""}`);
    for (const s of d.searches) L.push(`  ${s.op} "${s.q}" -> ${s.hits} note(s)`);
  }
  return L.join("\n");
}
