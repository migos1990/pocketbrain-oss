// SPDX-License-Identifier: AGPL-3.0-only
// The memory exam (docs/memory-sync.md, "Memory exam"): one scorecard per agent, from the logs
// alone. It answers four questions about each assistant over a window (7 days by default):
// - Memory: when quizzed (memory_check), does its own memory agree with the brain? Answers are
//   graded by memsync's rules when they arrive; the exam only counts the verdicts.
// - Brain first: did it read a note (or search) before writing to it?
// - Citations: how many of its writes were refused for their source?
// - Slice: did it ask for notes outside its view, or trip a leak alert?
// Owner-only and rule-only: no model, nothing served to an agent, and the report names fact keys
// and counts, never a value. Fresh questions come from memsync (the gardener's nightly
// memory_sync, or `pocketbrain exam --quiz`); the exam itself never asks or changes anything
// except its own report and log.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRules } from "./rules";
import { state, brainFirst } from "./memsync";
import { appendChained } from "./readlog";
import { readJsonl } from "./util";

const iso = () => (process.env.PB_NOW ? new Date(process.env.PB_NOW) : new Date()).toISOString();
const DAY = 86_400_000;
// A question nobody answered within a day: the agent isn't calling memory_check.
const ANSWER_HOURS = 24;
// Checks that refuse a write for its source, not its content.
const SOURCE_CHECKS = new Set(["source_present", "source_resolvable", "source_exists", "source_matches_type", "approval_needs_message_id", "owner_message_registered"]);
// Alerts that mean an agent held or tried to pass on something outside its slice.
const SLICE_ALERTS = new Set(["leak_tripwire", "withheld_category"]);
// Over this share of writes made without reading first, the agent answers from somewhere else.
const UNREAD_SHARE = 0.25;

export type Grade = "pass" | "watch" | "fail" | "no data";

export interface ExamRow {
  agent: string;
  memory: { asked: number; answered: number; unanswered: number; inSync: number; drift: number; missing: number; differs: number; stale: string[] };
  corrections: { open: number; verified: number; stillWrong: number; needsHand: number };
  brainFirst: { writes: number; unread: number };
  citations: { writes: number; refused: number };
  slice: { probes: number; alerts: number };
  sync: { sent: number; confirmed: number; unconfirmed: number }; // live change lists (memory_check)
  grade: Grade;
  why: string[];
}

// The agents that keep a memory of their own: everyone with a grant, except the gardener and
// those inside the wall (the upkeep pass), which have no memory_check.
function examined(root: string): string[] {
  const rules = loadRules(root);
  return Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall && a.role !== "gardener").map(([n]) => n).sort();
}

export function exam(root: string, days = 7): ExamRow[] {
  const now = iso();
  const since = new Date(Date.parse(now) - days * DAY).toISOString();
  const late = new Date(Date.parse(now) - ANSWER_HOURS * 3_600_000).toISOString();
  const s = state(root);
  const bf = new Map(brainFirst(root, days).map((u) => [u.agent, u]));
  const writes = readJsonl<{ at: string; agent: string; key?: string; outcome?: string; checks?: string[] }>(join(root, "log", "writes.jsonl")).filter((w) => w.at >= since && w.key && !w.key.startsWith("agents/"));
  const reads = readJsonl<{ at: string; agent: string; asked?: string }>(join(root, "log", "reads.jsonl")).filter((r) => r.at >= since && r.asked);
  const alerts = readJsonl<{ at: string; agent?: string; check?: string }>(join(root, "log", "alerts.jsonl")).filter((a) => String(a.at) >= since && SLICE_ALERTS.has(String(a.check)));

  return examined(root).map((agent) => {
    // Rechecks (asked again after a correction) count toward the correction, not the memory.
    const qs = s.quizzes.filter((q) => q.agent === agent && q.at >= since && !q.recheck);
    const answered = qs.filter((q) => q.state === "answered");
    const verdict = (v: string) => answered.filter((q) => q.verdict === v).length;
    const unanswered = qs.filter((q) => q.state !== "answered" && q.at <= late).length;
    const cs = s.corrections.filter((c) => c.agent === agent && c.at >= since);
    const fixed = new Set(cs.filter((c) => c.state === "verified").map((c) => c.from.quiz).filter(Boolean));
    // A stale answer stays against the agent until its correction is verified.
    const stale = [...new Set(answered.filter((q) => q.verdict === "drift" && !fixed.has(q.id)).map((q) => q.key))];
    const scanned = cs.filter((c) => c.from.file && c.kind !== "pointer" && !["verified", "declined"].includes(c.state)).map((c) => c.key);
    const mine = writes.filter((w) => w.agent === agent);
    const b = bf.get(agent);
    const row: ExamRow = {
      agent,
      memory: { asked: qs.length, answered: answered.length, unanswered, inSync: verdict("in-sync"), drift: verdict("drift"), missing: verdict("missing"), differs: verdict("differs"), stale: [...new Set([...stale, ...scanned])].sort() },
      corrections: {
        open: cs.filter((c) => ["proposed", "approved", "delivered", "applied"].includes(c.state)).length,
        verified: cs.filter((c) => c.state === "verified").length,
        stillWrong: cs.filter((c) => c.state === "still-wrong").length,
        needsHand: cs.filter((c) => c.state === "needs-hand").length,
      },
      brainFirst: { writes: b?.writes ?? 0, unread: b?.unread.length ?? 0 },
      citations: { writes: mine.length, refused: mine.filter((w) => w.outcome === "refused" && (w.checks ?? []).some((c) => SOURCE_CHECKS.has(c))).length },
      slice: { probes: reads.filter((r) => r.agent === agent).length, alerts: alerts.filter((a) => a.agent === agent).length },
      sync: syncRow(s.feeds.filter((f) => f.agent === agent && f.at >= since), late),
      grade: "no data",
      why: [],
    };
    return gradeRow(row);
  });
}

// A list replaced by a newer one counts once, through the newer one. Unconfirmed: the open list
// went out over a day ago (the same day's grace as an unanswered question).
function syncRow(fs: ReturnType<typeof state>["feeds"], late: string): ExamRow["sync"] {
  const live = fs.filter((f) => f.state !== "replaced");
  return { sent: live.length, confirmed: live.filter((f) => f.state === "seen").length, unconfirmed: live.filter((f) => f.state === "open" && f.at <= late).reduce((n, f) => n + f.items.length, 0) };
}

// Fail: the agent holds something wrong or leaked. Watch: it isn't using the brain the way the
// standing instruction says. "nothing" from memory is fine: keeping no copy is brain-first.
function gradeRow(r: ExamRow): ExamRow {
  const fail: string[] = [], watch: string[] = [];
  if (r.memory.stale.length) fail.push(`stale in its own memory: ${r.memory.stale.join(", ")}`);
  if (r.corrections.stillWrong) fail.push(`${r.corrections.stillWrong} correction(s) still wrong after a re-ask`);
  if (r.slice.alerts) fail.push(`${r.slice.alerts} leak alert(s)`);
  if (r.memory.unanswered) watch.push(`${r.memory.unanswered} question(s) unanswered for a day: it isn't calling memory_check`);
  if (r.memory.differs) watch.push(`${r.memory.differs} answer(s) differ from the brain without a known old value`);
  if (r.corrections.needsHand) watch.push(`${r.corrections.needsHand} correction(s) need a hand fix`);
  if (r.brainFirst.writes && r.brainFirst.unread / r.brainFirst.writes > UNREAD_SHARE) watch.push(`${r.brainFirst.unread} of ${r.brainFirst.writes} write(s) with no read first`);
  if (r.citations.refused) watch.push(`${r.citations.refused} write(s) refused for their source`);
  if (r.sync.unconfirmed) watch.push(`${r.sync.unconfirmed} changed fact(s) not confirmed for a day: its own memory may still hold the old values`);
  if (r.slice.probes) watch.push(`${r.slice.probes} ask(s) for notes outside its view`);
  const evidence = r.memory.answered + r.memory.unanswered + r.brainFirst.writes + r.citations.writes + r.slice.probes + r.slice.alerts + r.corrections.verified + r.corrections.open + r.sync.sent;
  r.grade = fail.length ? "fail" : watch.length ? "watch" : evidence ? "pass" : "no data";
  r.why = [...fail, ...watch];
  return r;
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");

export function examText(rows: ExamRow[], days: number, at = iso()): string {
  const L = [`# Memory exam, ${at.slice(0, 10)} (last ${days} days)`, "",
    "Each assistant's own memory against the brain, and whether it reads the brain first. Keys and counts only. Fix drift with `pocketbrain memsync list`.", "",
    "| Agent | Grade | Memory in sync | Stale | Unanswered | Writes read first | Source refusals | Slice probes / alerts |", "|---|---|---|---|---|---|---|---|"];
  for (const r of rows) L.push(`| ${r.agent} | ${r.grade} | ${r.memory.inSync}/${r.memory.answered} | ${r.memory.stale.length} | ${r.memory.unanswered} | ${pct(r.brainFirst.writes - r.brainFirst.unread, r.brainFirst.writes)} | ${r.citations.refused} | ${r.slice.probes} / ${r.slice.alerts} |`);
  const notes = rows.filter((r) => r.why.length);
  if (notes.length) { L.push("", "## Why"); for (const r of notes) L.push("", `**${r.agent}** (${r.grade})`, ...r.why.map((w) => `- ${w}`)); }
  return L.join("\n") + "\n";
}

const examLog = (root: string) => join(root, "log", "exam.jsonl");

// Writes digest/exam-<date>.md and one chained line per run (grades and counts, no values).
export function examRun(root: string, days = 7, only?: string): { file: string; text: string; rows: ExamRow[] } {
  const at = iso();
  const rows = exam(root, days).filter((r) => !only || r.agent === only);
  const text = examText(rows, days, at);
  mkdirSync(join(root, "digest"), { recursive: true });
  const file = join(root, "digest", `exam-${at.slice(0, 10)}.md`);
  writeFileSync(file, text);
  if (!only) appendChained(examLog(root), { at, days, grades: Object.fromEntries(rows.map((r) => [r.agent, r.grade])), stale: Object.fromEntries(rows.filter((r) => r.memory.stale.length).map((r) => [r.agent, r.memory.stale])) });
  return { file, text, rows };
}

// For the digest: the latest run as one line, and one Needs-you line per failing agent.
export function examLines(root: string): { numbers: string[]; need: string[] } {
  const last = readJsonl<{ at: string; grades: Record<string, Grade>; stale?: Record<string, string[]> }>(examLog(root)).at(-1);
  if (!last) return { numbers: [], need: [] };
  const graded = Object.entries(last.grades).filter(([, g]) => g !== "no data");
  const file = `digest/exam-${last.at.slice(0, 10)}.md`;
  return {
    numbers: [`- Memory exam (${last.at.slice(0, 10)}): ${graded.map(([a, g]) => `${a} ${g}`).join(", ") || "nothing to grade yet"}; ${file}`],
    need: graded.filter(([, g]) => g === "fail").map(([a]) => `- **${a} failed its memory exam**${last.stale?.[a]?.length ? `: stale ${last.stale[a].join(", ")}` : ""}. \`pocketbrain memsync list\`, details in ${file}.`),
  };
}

// Weekly: on Sundays, or as soon as the last run is over a week old (a hub that slept through
// Sunday catches up). A new hub waits for its first Sunday.
export function examDue(root: string, now = new Date()): boolean {
  const last = readJsonl<{ at: string }>(examLog(root)).at(-1);
  const day = now.toISOString().slice(0, 10);
  if (!last) return now.getDay() === 0;
  return last.at.slice(0, 10) !== day && (now.getDay() === 0 || now.getTime() - Date.parse(last.at) > 7 * DAY);
}
