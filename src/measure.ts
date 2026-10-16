// SPDX-License-Identifier: AGPL-3.0-only
// What the owner's first week is judged on (first-week.md sections 3 and 4): one function that
// reads the logs the brain already keeps and counts each measure per day, plus the two logs only
// the owner writes: re-explanations ("I had to tell <agent> X again") and minutes spent.
//   log/reexplain.jsonl   {at, agent, what, via}       pocketbrain reexplain, the dashboard, "re: <agent> <what>" by text
//   log/owner-time.jsonl  {at, minutes?, via}          dashboard page loads, one a minute at most, polls excluded (minutes derived), or a self-report
//   log/drills.jsonl      {at, ok}                     every `pocketbrain drill`
//   log/fixes.jsonl       {at, what, via}              pocketbrain fix: a hand fix, which resets the real-use bar; via
//                                                      "auto:..." when the hub saw it itself (handEdits, noteStart, repairs)
//   log/hub-runs.jsonl    {at, ev, signal?, build?}          each start of `pocketbrain start`, and each stop by a signal
//   log/owner-tasks.jsonl {at, ev, id, what?, via?}    pocketbrain task: what waits on the owner's own hands
// Everything else comes from log/reads.jsonl, log/writes.jsonl, log/alerts.jsonl,
// textline/log.jsonl, inbox/reflect/*.md and git.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { uptime } from "node:os";
import { today } from "./brain";
import { loadRules, gardeners } from "./rules";
import YAML from "yaml";
import { git } from "./git";
import { readJsonl, appendJsonl } from "./util";
import { lastBackup } from "./backup";
import { failingNow } from "./probe";
import { findSecret } from "./checks";
import { keysDir } from "./secrets";
import { fillQuality, fillQualityLines } from "./fill";

const jsonl = (f: string) => readJsonl(f);
const day = (at: unknown) => String(at ?? "").slice(0, 10);
const append = (root: string, name: string, e: Record<string, unknown>) =>
  appendJsonl(join(root, "log", name), { at: new Date().toISOString(), ...e });

export function recordReexplain(root: string, agent: string, what: string, via: string): string {
  const a = agent.trim().toLowerCase(), w = what.trim().slice(0, 300);
  if (!loadRules(root).policy.agents[a]) throw new Error(`unknown agent ${agent}`);
  if (!w) throw new Error("say what you had to explain again");
  append(root, "reexplain.jsonl", { agent: a, what: w, via });
  return `noted: you re-explained "${w.slice(0, 60)}" to ${a}`;
}

export function recordOwnerTime(root: string, via: string, minutes?: number) {
  append(root, "owner-time.jsonl", { via, ...(minutes !== undefined ? { minutes } : {}) });
}

export function recordDrill(root: string, ok: boolean) { append(root, "drills.jsonl", { ok }); }

// A hand fix: anything the owner (or a session on his machine) had to do to keep the brain working.
export function recordFix(root: string, what: string, via: string): string {
  const w = what.trim().slice(0, 300);
  if (!w) throw new Error("say what you had to fix by hand");
  append(root, "fixes.jsonl", { what: w, via });
  return `noted: hand fix "${w.slice(0, 60)}"; the real-use bar starts again tomorrow`;
}

// Hand fixes the hub sees without being told (backlog 215), next to the ones logged with
// `pocketbrain fix`. Every commit pocketBrain makes is authored <name>@pocketbrain.local
// (authorEnv in src/git.ts), so a commit under any other identity was made by hand: an edit in a
// text editor, a hand revert, a hand merge. A brain's first commit is its setup, not a fix.
export function handEdits(root: string, since?: string): { at: string; what: string; via: string }[] {
  const out = git(root, ["log", ...(since ? [`--since=${since}T00:00:00Z`] : []), "--format=%at%x09%ae%x09%P%x09%h %s"]);
  return out.split("\n").filter(Boolean).map((l) => l.split("\t")).filter(([, email, parents]) => parents && !email.endsWith("@pocketbrain.local"))
    .map(([t, , , s]) => ({ at: new Date(Number(t) * 1000).toISOString(), what: `hand edit: ${s.slice(0, 120)}`, via: "auto:git" }));
}

const allFixes = (root: string, since?: string) =>
  [...jsonl(join(root, "log", "fixes.jsonl")), ...handEdits(root, since)].sort((a, b) => String(a.at).localeCompare(String(b.at)));

// Owner-run repair commands log themselves (src/cli.ts): running one means something was stuck.
export function recordRepair(root: string, cmd: string) {
  append(root, "fixes.jsonl", { what: `ran pocketbrain ${cmd} by hand`, via: `auto:${cmd.replace(/\s+/g, "-")}` });
}

// Hand restarts. `pocketbrain start` logs each start, and each stop by a signal (launchd's
// kickstart and a Ctrl-C both send one). A start right after such a stop, with no reboot in
// between and no restart by the updater (scripts/deploy.ts leaves deploy.restart next to
// deploy.json just before it restarts the hub), was a restart by hand. A start with no stop
// before it followed a crash, which launchd recovered from alone and the probe reports. The
// menu's Restart hub logs its own fix, so the start after it isn't counted again.
const runsLog = (root: string) => join(root, "log", "hub-runs.jsonl");
const RESTART_WINDOW_MS = 5 * 60_000;
export function noteStop(root: string, signal: string, now = new Date()) {
  appendJsonl(runsLog(root), { at: now.toISOString(), ev: "stop", signal });
}
function plannedRestart(): Date | undefined {
  try { const d = new Date(readFileSync(join(dirname(keysDir()), "deploy.restart"), "utf8").trim()); return Number.isFinite(d.getTime()) ? d : undefined; } catch { return undefined; }
}
export function noteStart(root: string, o: { now?: Date; bootAt?: Date; planned?: Date; build?: string } = {}): string | undefined {
  const now = o.now ?? new Date();
  const runs = jsonl(runsLog(root));
  const last = runs.at(-1);
  const before = runs.filter((e) => e.ev === "start").at(-1)?.build;
  appendJsonl(runsLog(root), { at: now.toISOString(), ev: "start", ...(o.build ? { build: o.build } : {}) });
  if (last?.ev !== "stop") return undefined;
  // New code since the last start: an update, whoever ran the kickstart after pulling it.
  if (o.build && before && before !== o.build) return undefined;
  const stopped = Date.parse(String(last.at));
  const boot = (o.bootAt ?? new Date(Date.now() - uptime() * 1000)).getTime();
  if (boot > stopped) return undefined;
  const planned = (o.planned ?? plannedRestart())?.getTime();
  if (planned !== undefined && planned >= stopped - RESTART_WINDOW_MS && planned <= now.getTime()) return undefined;
  if (jsonl(join(root, "log", "fixes.jsonl")).some((f) => f.via === "auto:menubar" && Date.parse(String(f.at)) >= stopped - RESTART_WINDOW_MS)) return undefined;
  const what = "the hub was restarted by hand";
  append(root, "fixes.jsonl", { at: now.toISOString(), what, via: "auto:restart" });
  return what;
}

// A page load counts the minute it happened in; loads less than 5 minutes apart join one sitting.
// Self-reported minutes for a day replace the derived ones (the owner knows better).
function ownerMinutes(entries: Record<string, unknown>[], d: string): number | undefined {
  const mine = entries.filter((e) => day(e.at) === d);
  const told = mine.filter((e) => typeof e.minutes === "number");
  if (told.length) return told.reduce((s, e) => s + (e.minutes as number), 0);
  const t = mine.filter((e) => e.minutes === undefined).map((e) => Date.parse(String(e.at))).filter(Number.isFinite).sort((a, b) => a - b);
  if (!t.length) return undefined;
  let ms = 60_000;
  for (let i = 1; i < t.length; i++) { const gap = t[i] - t[i - 1]; ms += gap < 5 * 60_000 ? gap : 60_000; }
  return Math.round(ms / 60_000);
}

export interface DayMeasures {
  date: string;
  reexplain: number; reexplainBy: Record<string, number>;
  reads: Record<string, number>;            // context_pack, search and read calls per agent
  served: { due: number; stale: number; disputed: number };
  ownerMinutes?: number;
  inbox: number;                            // writes that went to the owner's inbox
  leaks: number;                            // tripwire and hub alerts
  forged: number;                           // rules commits by agents, forged-signature alerts
  duplicates: number;                       // possible-duplicate findings in upkeep reports
  texts: { sent: number; urgent: number; quietHeld: number };
  reach?: { ok: number; checks: number };   // the text channel's server check
  forgetUndone: number;                     // facts brought back with `undo --run sleep-…`
  drill?: boolean;
  fixes: number; fixesWhat: string[];       // hand fixes logged with `pocketbrain fix`
  hubDown: number; hubDownWhat: string[];   // the health probe's checks that turned to failing
  gardener: GardenerDay;                    // kept apart: its reads aren't use (G4)
  sources: SourcesDay;                      // pulls (src/pull.ts): what they read, caught and missed
}

// caught = notes turned due because a source moved: errors found before an agent repeated them.
export interface SourcesDay { read: number; confirmed: number; proposals: number; caught: number; failed: number }

export interface GardenerDay { runs: number; proposals: number; accepted: number; rejected: number; capHits: number; trips: number }

// Alerts that are Needs-you items, not leaks: they don't count toward the leak verdict.
const NOT_LEAKS = new Set(["write_conflict", "classify_review", "gardener_hours", "gardener_ant", "source_failed", "request_budget"]);
// The health probe (src/probe.ts) alerts as agent "hub" too; an outage isn't a forged commit.
const isProbe = (a: Record<string, unknown>) => String(a.check ?? "").startsWith("probe_");
// The daily self-check's warnings (probe_warn_<name>) are worth a look, not an outage.
const isWarn = (a: Record<string, unknown>) => String(a.check ?? "").startsWith("probe_warn_");

export function measures(root: string, dates: string[]): DayMeasures[] {
  const rules = loadRules(root);
  const outside = new Set(Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall).map(([n]) => n));
  const tidier = new Set(gardeners(rules));
  const gRuns = jsonl(join(root, "log", "gardener.jsonl")).filter((e) => e.op === "upkeep_run" && tidier.has(String(e.agent)));
  const decidedDir = join(root, "inbox", "decided");
  const decided = existsSync(decidedDir) ? readdirSync(decidedDir).filter((f) => f.endsWith(".yaml")).map((f) => { try { return YAML.parse(readFileSync(join(decidedDir, f), "utf8")) as { decided?: string; decision?: string; request?: { agent?: string } }; } catch { return {}; } }).filter((p) => tidier.has(String(p.request?.agent))) : [];
  const re = jsonl(join(root, "log", "reexplain.jsonl"));
  const reads = jsonl(join(root, "log", "reads.jsonl"));
  const writes = jsonl(join(root, "log", "writes.jsonl"));
  const alerts = jsonl(join(root, "log", "alerts.jsonl"));
  const time = jsonl(join(root, "log", "owner-time.jsonl"));
  const drills = jsonl(join(root, "log", "drills.jsonl"));
  const fixes = allFixes(root, dates[0]);
  const texts = jsonl(join(root, "textline", "log.jsonl"));
  const pulls = jsonl(join(root, "log", "sources", "runs.jsonl"));
  const reflect = join(root, "inbox", "reflect");
  const reports = existsSync(reflect) ? readdirSync(reflect).filter((f) => f.endsWith(".md")).map((f) => ({ f, text: readFileSync(join(reflect, f), "utf8") })) : [];
  const since = dates[0];
  const rulesCommits = git(root, ["log", `--since=${since}T00:00:00Z`, "--format=%ad %an", "--date=short", "--", "rules"]).split("\n").filter(Boolean);
  const undos = git(root, ["log", `--since=${since}T00:00:00Z`, "--format=%ad %s", "--date=short", "-E", "--grep", "^undo sleep-"]).split("\n").filter(Boolean);

  return dates.map((d) => {
    const reD = re.filter((e) => day(e.at) === d);
    const by: Record<string, number> = {};
    for (const e of reD) by[String(e.agent)] = (by[String(e.agent)] ?? 0) + 1;
    const readsBy: Record<string, number> = {};
    const served = { due: 0, stale: 0, disputed: 0 };
    for (const e of reads.filter((x) => day(x.at) === d)) {
      if (tidier.has(String(e.agent))) continue;
      if (["context_pack", "search", "read"].includes(String(e.op))) readsBy[String(e.agent)] = (readsBy[String(e.agent)] ?? 0) + 1;
      const f = e.fresh as Partial<typeof served> | undefined;
      if (f) { served.due += f.due ?? 0; served.stale += f.stale ?? 0; served.disputed += f.disputed ?? 0; }
    }
    const tD = texts.filter((e) => day(e.at) === d);
    const quiet = new Set<string>();
    for (const e of tD) for (const k of (e.quiet_held as string[] | undefined) ?? []) quiet.add(k);
    const checks = tD.filter((e) => e.health === "server");
    const drillD = drills.filter((e) => day(e.at) === d);
    const fixD = fixes.filter((e) => day(e.at) === d);
    const downD = alerts.filter((a) => day(a.at) === d && a.agent === "hub" && isProbe(a) && !isWarn(a));
    return {
      date: d,
      reexplain: reD.length, reexplainBy: by,
      reads: readsBy, served,
      ownerMinutes: ownerMinutes(time, d),
      inbox: writes.filter((w) => day(w.at) === d && w.outcome === "inbox").length,
      leaks: alerts.filter((a) => day(a.at) === d && a.agent !== "hub" && !NOT_LEAKS.has(String(a.check))).length,
      forged: rulesCommits.filter((l) => l.startsWith(d) && outside.has(l.split(" ")[1])).length + alerts.filter((a) => day(a.at) === d && a.agent === "hub" && !isProbe(a)).length,
      duplicates: reports.filter((r) => r.f.includes(d)).reduce((s, r) => s + (r.text.match(/possible-duplicate/g) ?? []).length, 0),
      texts: {
        sent: tD.filter((e) => e.sent && e.ok && e.kind !== "ack").length,
        urgent: tD.filter((e) => e.batch && Number(e.urgent) > 0).length,
        quietHeld: quiet.size,
      },
      ...(checks.length ? { reach: { ok: checks.filter((e) => e.ok).length, checks: checks.length } } : {}),
      forgetUndone: undos.filter((l) => l.startsWith(d)).reduce((s, l) => s + Number(l.match(/reverted (\d+)/)?.[1] ?? 1), 0),
      ...(drillD.length ? { drill: drillD.every((e) => e.ok) } : {}),
      fixes: fixD.length, fixesWhat: fixD.map((e) => String(e.what)),
      hubDown: downD.length, hubDownWhat: downD.map((a) => String(a.check)),
      gardener: {
        runs: gRuns.filter((e) => day(e.at) === d).length,
        proposals: writes.filter((w) => day(w.at) === d && tidier.has(String(w.agent)) && w.outcome === "inbox").length,
        accepted: decided.filter((p) => p.decided === d && p.decision === "accept").length,
        rejected: decided.filter((p) => p.decided === d && p.decision === "reject").length,
        capHits: writes.filter((w) => day(w.at) === d && tidier.has(String(w.agent)) && ((w.checks as string[] | undefined) ?? []).includes("proposal_cap")).length,
        trips: alerts.filter((a) => day(a.at) === d && a.check === "gardener_hours").length,
      },
      sources: (() => {
        const pD = pulls.filter((e) => day(e.at) === d);
        const n = (k: string) => pD.reduce((s, e) => s + (Number(e[k]) || 0), 0);
        return { read: pD.reduce((s, e) => s + ((e.stored as unknown[] | undefined)?.length ?? 0), 0), confirmed: n("confirmed"), proposals: n("proposals"), caught: new Set(pD.flatMap((e) => (e.due as string[] | undefined) ?? [])).size, failed: pD.filter((e) => e.refused).length };
      })(),
    };
  });
}

export function lastDays(n: number, end = today()): string[] {
  const out: string[] = [];
  const t = Date.parse(`${end}T00:00:00Z`);
  for (let i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

// Hand tasks: things only the owner can do (a key into his password manager, a setting on
// GitHub). Numbered in the order added; the number stays the same until the task is done.
// A task can carry the exact command to run (the operator ledger, backlog 109), so the owner
// never has to work it out. Neither the task nor its command may hold a secret.
export interface OwnerTask { id: number; what: string; at: string; cmd?: string }
const taskLog = (root: string) => jsonl(join(root, "log", "owner-tasks.jsonl"));

export function addTask(root: string, what: string, via: string, cmd?: string): string {
  const w = what.trim().slice(0, 200);
  const c = cmd?.trim().slice(0, 300) || undefined;
  if (!w) throw new Error("say what the task is");
  const s = findSecret(`${w}\n${c ?? ""}`);
  if (s) throw new Error(`a hand task can't hold a secret (${s}); name where it lives instead`);
  const id = taskLog(root).filter((e) => e.ev === "add").length + 1;
  append(root, "owner-tasks.jsonl", { ev: "add", id, what: w, via, ...(c ? { cmd: c } : {}) });
  return `task ${id}: ${w}${c ? `\n   run: ${c}` : ""}`;
}

export function openTasks(root: string): OwnerTask[] {
  const open = new Map<number, OwnerTask>();
  for (const e of taskLog(root)) {
    if (e.ev === "add") open.set(Number(e.id), { id: Number(e.id), what: String(e.what), at: String(e.at), ...(e.cmd ? { cmd: String(e.cmd) } : {}) });
    else if (e.ev === "done") open.delete(Number(e.id));
  }
  return [...open.values()].sort((a, b) => a.id - b.id);
}

export function doneTask(root: string, id: number): string {
  const t = openTasks(root).find((x) => x.id === id);
  if (!t) throw new Error(`no open task ${id}`);
  append(root, "owner-tasks.jsonl", { ev: "done", id });
  return `done: ${t.what}`;
}

// The digest's extra "Numbers" lines for one day.
export function digestLines(root: string, d = today()): string[] {
  const [m] = measures(root, [d]);
  const reads = Object.entries(m.reads).map(([a, n]) => `${a} ${n}`).join(", ") || "none";
  return [
    `- Re-explained to an agent: ${m.reexplain}${m.reexplain ? ` (${Object.entries(m.reexplainBy).map(([a, n]) => `${a} ${n}`).join(", ")})` : ""}. Log one with \`pocketbrain reexplain <agent> "<what>"\` or text "re: <agent> <what>"`,
    `- Reads by agent: ${reads}; handed out ${m.served.stale} stale, ${m.served.due} due, ${m.served.disputed} disputed fact(s), each labelled`,
    `- Texts: ${m.texts.sent} sent (${m.texts.urgent} urgent), ${m.texts.quietHeld} held for quiet hours${m.reach ? `; hub answered ${pct(m.reach.ok, m.reach.checks)} of ${m.reach.checks} checks` : ""}`,
    ...(m.ownerMinutes !== undefined ? [`- Your time: about ${m.ownerMinutes} min`] : []),
    `- ${bar(root, d).text}`,
  ];
}

const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "n/a");
const median = (xs: number[]) => { if (!xs.length) return undefined; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export interface Verdict { measure: string; value: string; verdict: "continue" | "fix first" | "stop" | "no data" }

// first-week.md section 4, as code. A measure with nothing logged is "no data", never a pass.
export function judgeWeek(root: string, ms: DayMeasures[], baseline?: number): Verdict[] {
  const agents = Object.entries(loadRules(root).policy.agents).filter(([, a]) => !a.inside_wall && a.status !== "paused" && a.role !== "gardener").map(([n]) => n);
  const v: Verdict[] = [];
  const last3 = ms.slice(-3).reduce((s, m) => s + m.reexplain, 0);
  const anyRe = ms.some((m) => m.reexplain) || existsSync(join(root, "log", "reexplain.jsonl"));
  v.push({ measure: "Re-explanations, last 3 days", value: `${last3}${baseline !== undefined ? ` (baseline ${baseline}/day)` : ""}`,
    verdict: !anyRe ? "no data" : last3 <= 2 && (baseline === undefined || last3 / 3 < baseline) ? "continue" : baseline !== undefined && last3 / 3 >= baseline ? "stop" : "fix first" });
  for (const a of agents) {
    const days = ms.filter((m) => (m.reads[a] ?? 0) > 0).length;
    v.push({ measure: `${a} reads`, value: `${days} of ${ms.length} days`, verdict: days >= 5 ? "continue" : days >= 1 ? "fix first" : "no data" });
  }
  const mins = ms.map((m) => m.ownerMinutes).filter((x): x is number => x !== undefined);
  const med = median(mins);
  v.push({ measure: "Your time (median minutes/day)", value: med === undefined ? "not logged" : `${med}`, verdict: med === undefined ? "no data" : med <= 10 ? "continue" : mins.filter((x) => x > 20).length > ms.length / 2 ? "stop" : mins.filter((x) => x > 15).length >= 3 ? "fix first" : "continue" });
  const inboxAvg = ms.reduce((s, m) => s + m.inbox, 0) / ms.length;
  v.push({ measure: "Inbox items/day", value: inboxAvg.toFixed(1), verdict: inboxAvg <= 5 ? "continue" : "fix first" });
  const leaks = ms.reduce((s, m) => s + m.leaks, 0);
  v.push({ measure: "Leak alerts (tripwire)", value: `${leaks}`, verdict: leaks ? "stop" : "continue" });
  const forged = ms.reduce((s, m) => s + m.forged, 0);
  v.push({ measure: "Forged or wrong-author commits", value: `${forged}`, verdict: forged ? "stop" : "continue" });
  const dups = ms.reduce((s, m) => s + m.duplicates, 0);
  v.push({ measure: "Possible duplicates flagged by upkeep", value: `${dups}`, verdict: dups ? "fix first" : "continue" });
  const busy = ms.filter((m) => m.texts.sent - m.texts.urgent > 3).length;
  v.push({ measure: "Days with more than 3 non-urgent texts", value: `${busy}`, verdict: busy ? "fix first" : "continue" });
  const undone = ms.reduce((s, m) => s + m.forgetUndone, 0);
  v.push({ measure: "Forgotten facts you brought back", value: `${undone}`, verdict: undone >= 2 ? "fix first" : "continue" });
  const ok = ms.reduce((s, m) => s + (m.reach?.ok ?? 0), 0), n = ms.reduce((s, m) => s + (m.reach?.checks ?? 0), 0);
  v.push({ measure: "Hub reachable", value: n ? `${pct(ok, n)} of ${n} checks` : "no checks logged", verdict: !n ? "no data" : ok / n >= 0.95 ? "continue" : "fix first" });
  const served = ms.reduce((s, m) => ({ stale: s.stale + m.served.stale, due: s.due + m.served.due, disputed: s.disputed + m.served.disputed }), { stale: 0, due: 0, disputed: 0 });
  // Every one went out with its label (freshness.ts), so this is a count to watch, not a failure.
  v.push({ measure: "Stale or due facts handed out (labelled)", value: `${served.stale} stale, ${served.due} due, ${served.disputed} disputed`, verdict: "continue" });
  const broke = ms.reduce((s, m) => s + m.fixes + m.hubDown, 0);
  v.push({ measure: "Hand fixes and hub failures", value: `${broke}`, verdict: broke ? "fix first" : "continue" });
  const drills = ms.filter((m) => m.drill !== undefined);
  v.push({ measure: "Backup drills", value: drills.length ? drills.map((m) => `${m.date} ${m.drill ? "clean" : "FAILED"}`).join(", ") : "none run", verdict: !drills.length ? "no data" : drills.every((m) => m.drill) ? "continue" : "fix first" });
  return v;
}

// pocketbrain week: the scorecard, one column per day, then section 4's verdicts.
export function week(root: string, end = today(), baseline?: number): { file: string; text: string; verdicts: Verdict[] } {
  const dates = lastDays(7, end);
  const ms = measures(root, dates);
  const agents = [...new Set(ms.flatMap((m) => Object.keys(m.reads)))].sort();
  const row = (label: string, f: (m: DayMeasures) => string | number | undefined) => `| ${label} | ${ms.map((m) => f(m) ?? "–").join(" | ")} |`;
  const verdicts = judgeWeek(root, ms, baseline);
  const text = [
    `# pocketBrain week, ${dates[0]} to ${end}`, "",
    `| | ${dates.map((d) => d.slice(5)).join(" | ")} |`, `|---|${dates.map(() => "---").join("|")}|`,
    row("Re-explained", (m) => m.reexplain),
    ...agents.map((a) => row(`${a} reads`, (m) => m.reads[a] ?? 0)),
    row("Stale / due / disputed handed out", (m) => `${m.served.stale}/${m.served.due}/${m.served.disputed}`),
    row("Sources: read / confirmed / proposed", (m) => `${m.sources.read}/${m.sources.confirmed}/${m.sources.proposals}`),
    row("Sources: errors caught / pulls failed", (m) => `${m.sources.caught}/${m.sources.failed}`),
    row("Your minutes", (m) => m.ownerMinutes),
    row("Inbox items", (m) => m.inbox),
    row("Texts (urgent)", (m) => `${m.texts.sent} (${m.texts.urgent})`),
    row("Held for quiet hours", (m) => m.texts.quietHeld),
    row("Hub reachable", (m) => (m.reach ? pct(m.reach.ok, m.reach.checks) : undefined)),
    row("Leak alerts", (m) => m.leaks),
    row("Forged / wrong author", (m) => m.forged),
    row("Possible duplicates", (m) => m.duplicates),
    row("Forgetting undone", (m) => m.forgetUndone),
    row("Backup drill", (m) => (m.drill === undefined ? undefined : m.drill ? "clean" : "FAILED")),
    row("Hand fixes", (m) => m.fixes),
    row("Hub failures", (m) => m.hubDown), "",
    bar(root, end).text, "",
    ...gardenerLine(root, ms),
    ...fillQualityLines(fillQuality(root, 7, end)),
    "## Verdicts", "",
    "| Measure | Value | Verdict |", "|---|---|---|",
    ...verdicts.map((x) => `| ${x.measure} | ${x.value} | ${x.verdict === "stop" ? "**stop**" : x.verdict} |`), "",
    `Overall: ${verdicts.some((x) => x.verdict === "stop") ? "**stop and fix** before anything else" : verdicts.some((x) => x.verdict === "fix first") ? "fix first, then restart the week" : verdicts.some((x) => x.verdict === "no data") ? "continue, but some measures have no data yet" : "continue the month"}.`, "",
  ].join("\n");
  mkdirSync(join(root, "digest"), { recursive: true });
  const file = join(root, "digest", `week-${end}.md`);
  writeFileSync(file, text);
  return { file, text, verdicts };
}

// The gardener's own line, outside the agents' numbers: runs, proposals and what became of them,
// cap hits, tripwire trips. Open = its proposals still waiting in the inbox.
function gardenerLine(root: string, ms: DayMeasures[]): string[] {
  const g = gardeners(loadRules(root));
  if (!g.length) return [];
  const sum = (k: keyof GardenerDay) => ms.reduce((s, m) => s + m.gardener[k], 0);
  const inbox = join(root, "inbox");
  const open = existsSync(inbox) ? readdirSync(inbox).filter((f) => f.endsWith(".yaml")).filter((f) => { try { return g.includes(String(YAML.parse(readFileSync(join(inbox, f), "utf8"))?.request?.agent)); } catch { return false; } }).length : 0;
  return [`${g.join(", ")}: ${sum("runs")} runs, ${sum("proposals")} proposals (${sum("accepted")} accepted, ${sum("rejected")} rejected, ${open} open), ${sum("capHits")} cap hits, ${sum("trips")} tripwire trips`, ""];
}

// The real-use bar (Louis, 2026-10-14): 14 days in a row of daily use with no hand fix, plus one
// clean restore drill. A day counts when a live agent (not the gardener) read the brain and nothing
// had to be fixed: no `pocketbrain fix`, no health-probe failure, no failed drill. Today counts
// once it has a read; until then it neither counts nor breaks the streak.
export interface Bar { days: number; target: number; lastBreak?: { date: string; why: string }; sinceFix?: { days: number; date: string; what: string }; restore?: { date: string; ok: boolean }; open: string[]; met: boolean; text: string }

// The first day the brain existed: its first commit or its earliest log line, whichever is first.
// Days before it neither count nor break the streak.
function brainStart(root: string): string | undefined {
  const firsts = [git(root, ["log", "--max-parents=0", "--format=%cs", "HEAD"]).split("\n").at(-1) ?? ""];
  const logs = join(root, "log");
  if (existsSync(logs)) for (const f of readdirSync(logs)) if (f.endsWith(".jsonl")) firsts.push(day(jsonl(join(logs, f))[0]?.at));
  return firsts.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()[0];
}

export function bar(root: string, end = today(), target = 14): Bar {
  const start = brainStart(root);
  const dates = lastDays(Math.max(60, target + 1), end).filter((d) => !start || d >= start);
  const ms = measures(root, dates);
  let days = 0;
  let lastBreak: Bar["lastBreak"];
  for (let i = ms.length - 1; i >= 0 && !lastBreak; i--) {
    const m = ms[i];
    const read = Object.values(m.reads).some((n) => n > 0);
    const why = m.fixes ? `hand fix: ${m.fixesWhat.join("; ")}` : m.hubDown ? `hub check failed: ${m.hubDownWhat.join(", ")}` : m.drill === false ? "restore drill failed" : !read && m.date !== end ? "no agent read the brain" : undefined;
    if (why) lastBreak = { date: m.date, why };
    else if (read) days++;
  }
  const fix = allFixes(root).filter((f) => day(f.at) <= end).at(-1);
  const sinceFix = fix ? { days: Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${day(fix.at)}T00:00:00Z`)) / 86_400_000), date: day(fix.at), what: String(fix.what) } : undefined;
  const drills = jsonl(join(root, "log", "drills.jsonl")).filter((e) => day(e.at) <= end);
  const last = drills.at(-1);
  const restore = last ? { date: day(last.at), ok: last.ok === true } : undefined;
  const lb = lastBackup(root);
  const backup = lb ? `last backup ${lb.at.slice(0, 10)}` : "no backup yet";
  const open = failingNow(root);
  const met = days >= target && restore?.ok === true && !open.length;
  const text = [
    `Real-use bar: day ${Math.min(days, target)} of ${target} with daily use and no hand fix`,
    sinceFix ? `${sinceFix.days} day${sinceFix.days === 1 ? "" : "s"} since the last hand fix (${sinceFix.date}, ${sinceFix.what.slice(0, 80)})` : "no hand fix yet",
    lastBreak && !(sinceFix?.date === lastBreak.date && lastBreak.why.startsWith("hand fix")) ? `last break ${lastBreak.date} (${lastBreak.why.slice(0, 120)})` : undefined,
    `restore drill: ${restore ? `${restore.ok ? "clean" : "FAILED"} ${restore.date}` : "not yet"}`,
    backup,
    open.length ? `open problem: ${open.join(", ")}` : undefined,
  ].filter(Boolean).join("; ") + (met ? ". Bar met." : ".");
  return { days, target, lastBreak, sinceFix, restore, open, met, text };
}
