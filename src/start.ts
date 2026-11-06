// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain start`: everything the hub runs, in one process, so one launchd (or systemd)
// entry keeps the brain alive: the agents' server, the owner dashboard, the text channel, the
// relay (when its key is set), and the nightly pass (upkeep, then sleep) and morning digest
// (with the memory exam on Sundays).
// `serve` keeps working for those who want the pieces separately.
import { catchUpDiary } from "./diary-catchup";
import { unfreezeHeld, reopenLostAccepts, rankOldTaps } from "./write";
import { renderTouchedPages, backfillNameKeys } from "./wiki";
import type { StartKind } from "./measure";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { upkeep, PAGE_TEXT_HOURS } from "./upkeep";
import { sleep, STEP as SLEEP_STEP } from "./sleep";
import { digest } from "./digest";
import { makeModel, modelConfigFor, KEY_ENV, type Model } from "./model";
import { serial, serialRoot } from "./server";
import { runAuto } from "./filing";
import { watch } from "./textline/poll";
import { modelFor as meteredModelFor } from "./usage";
import { relayTick, agentMailTransport, loadRelayConfig } from "./relay";
import { drainAftercheck, requeueMissed } from "./aftercheck";
import { resumeCorrections } from "./memsync";
import { settleLeftovers } from "./handoff";
import { nightPlan, dueGardenerJobs, cleanup, rotate } from "./gardener";
import { housekeeping } from "./growth";
import { probeOnce, unsearchable, recordStart, northStarAfterStart, northStarLine } from "./probe";
import { pullAll, pullsDue, recheckDue, keepSourceWords } from "./pull";
import { nightBackfill, nightBackfillLine } from "./backfill";
import { trustReport, recordTrust, trustLine } from "./trust";
import { examDue, examRun } from "./exam";
import { auditCarve } from "./audit";
import { loadRules } from "./rules";
import { ownerClock } from "./clock";
import { adoptHandEdits } from "./wiki";
import { beat } from "./heartbeat";
import { loadBackupConfig } from "./backup";

export interface Schedule { night_hour: number; digest_hour: number }
export const DEFAULT_SCHEDULE: Schedule = { night_hour: 3, digest_hour: 7 };

// A model for a step only when its key is there; without one the step runs its rule-only part.
function modelIfKeyed(root: string, step: string): Model | undefined {
  const cfg = modelConfigFor(root, step);
  const env = cfg.api_key_env ?? KEY_ENV[cfg.provider];
  // Metered like every hub model call (log/usage.jsonl, backlog 272).
  return cfg.provider === "openai-compatible" || (env && process.env[env]) ? meteredModelFor(root, step) : undefined;
}

const stateFile = (root: string) => join(root, "log", "start-state.json");
export function lastRuns(root: string): Record<string, string> {
  try { return JSON.parse(readFileSync(stateFile(root), "utf8")); } catch { return {}; }
}
function markRun(root: string, job: string, day: string) {
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(stateFile(root), JSON.stringify({ ...lastRuns(root), [job]: day }));
}

// How a daily job ended: <job>_at on success, <job>_error until the next success. The probe's job
// checks (src/probe.ts) read these, so a nightly pass that throws or stops running isn't silent.
// Each one is also a heartbeat (src/heartbeat.ts), the one ledger the home and doctor read, except
// the Sunday drill's runner: its child beats restore_drill itself, with the reason it failed.
const BEATS_ELSEWHERE = new Set(["drill"]);
export function recordJob(root: string, job: string, err: Error | undefined, now = new Date(), ms?: number) {
  if (!BEATS_ELSEWHERE.has(job)) beat(root, job, { ok: !err, error: err?.message, ms, now });
  mkdirSync(join(root, "log"), { recursive: true });
  const s: Record<string, string> = { ...lastRuns(root) };
  if (err) s[`${job}_error`] = err.message.slice(0, 200);
  else { s[`${job}_at`] = now.toISOString(); delete s[`${job}_error`]; }
  writeFileSync(stateFile(root), JSON.stringify(s));
}

// A job that hangs would otherwise show as nothing at all: past its time it is recorded as failed
// (the probe alerts on it) while it keeps running. runJob still waits for it, so the hub's write
// queue stays held until serial()'s own limit for the daily jobs (5 minutes more) lets it go
// (backlog 404): past that, a job cut loose may write alongside the agents. A late finish doesn't
// clear the alarm; the next run on time does.
export const JOB_MINUTES = Number(process.env.PB_JOB_MINUTES ?? 45);
export async function runJob(root: string, job: string, fn: () => Promise<unknown> | unknown, ms = JOB_MINUTES * 60_000): Promise<string> {
  const limit = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms}ms`;
  let late = false;
  const t0 = Date.now();
  const timer = setTimeout(() => { late = true; recordJob(root, job, new Error(`timed out after ${limit}; still running`)); }, ms);
  try {
    const r = await Promise.resolve().then(fn);
    if (late) { recordJob(root, job, new Error(`timed out after ${limit}; ended late`), new Date(), Date.now() - t0); return `${job} failed: timed out after ${limit} (ended late)`; }
    recordJob(root, job, undefined, new Date(), Date.now() - t0);
    return typeof r === "string" ? r : "ok";
  } catch (e) {
    recordJob(root, job, e as Error, new Date(), Date.now() - t0);
    return `${job} failed: ${late ? `timed out after ${limit}, then ` : ""}${(e as Error).message}`;
  } finally { clearTimeout(timer); }
}

// The gardener's Anthropic jobs, checked every minute. A throw is recorded like a daily job's
// (gardener_cleanup, gardener_rotate, or gardener_jobs when rules/gardener.yaml itself is broken),
// so the probe and the digest show it instead of a line in a log file.
export function tendOnce(root: string, log: (s: string) => void, now = new Date()) {
  const stamp = () => now.toISOString().slice(0, 16);
  let jobs: ("cleanup" | "rotate")[];
  try { jobs = dueGardenerJobs(root, now, { retryRotate: !!lastRuns(root).gardener_rotate_error }); if (lastRuns(root).gardener_jobs_error) recordJob(root, "gardener_jobs", undefined, now); }
  catch (e) { recordJob(root, "gardener_jobs", e as Error, now); log(`${stamp()} gardener jobs failed: ${(e as Error).message}`); return; }
  for (const job of jobs) {
    try {
      const r = job === "cleanup" ? cleanup(root, now) : rotate(root, { scheduled: true });
      log(`${stamp()} ${r.message}`);
      recordJob(root, `gardener_${job}`, r.ok ? undefined : new Error(r.message), now);
    }
    catch (e) { recordJob(root, `gardener_${job}`, e as Error, now); log(`${stamp()} gardener ${job} failed: ${(e as Error).message}`); }
  }
}

// Which jobs are due at `now` (local time), each at most once per local day: the nightly pass and
// the digest every day, the carve audit (src/audit.ts) and, once backups are set up, the restore
// test (src/restore-drill.ts) on Sundays after the nightly pass.
type Job = "night" | "audit" | "drill" | "digest";
export function dueJobs(root: string, now: Date, s: Schedule = DEFAULT_SCHEDULE): Job[] {
  // The owner's day and hour (owner.timezone), not this machine's: a hub in another zone, or a
  // container on UTC, still runs the night at 03:00 the owner's time, once (src/clock.ts).
  let c: ReturnType<typeof ownerClock>;
  try { c = ownerClock(loadRules(root), now); } catch { c = { day: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`, hour: now.getHours(), dow: now.getDay() }; }
  const { day, hour, dow } = c;
  const done = lastRuns(root);
  const out: Job[] = [];
  if (hour >= s.night_hour && done.night !== day) out.push("night");
  if (dow === 0 && hour >= s.night_hour && done.audit !== day) out.push("audit");
  if (dow === 0 && hour >= s.night_hour && done.drill !== day && loadBackupConfig(root)) out.push("drill");
  if (hour >= s.digest_hour && done.digest !== day) out.push("digest");
  return out.map((j) => { markRun(root, j, day); return j; });
}

// The night's page text when upkeep didn't run here (a managed Gardener does upkeep; the page
// writer stays the hub's). Undefined when upkeep ran, which writes it as step 1d.
export function nightPageText(root: string, upkeepRan: boolean) {
  return upkeepRan ? undefined : renderTouchedPages(root, new Date(Date.now() - PAGE_TEXT_HOURS * 3_600_000).toISOString());
}

export function startJobs(root: string, opts: { log?: (s: string) => void; schedule?: Schedule; localUrl?: string; startKind?: StartKind } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const stamp = () => new Date().toISOString().slice(0, 16);
  recordStart(root, new Date(), opts.startKind); // the self-check's restart-loop count (src/probe.ts selfChecks)
  serialRoot(root); // a write-queue job past its limit is logged and alerted here
  // Notes edited by hand while the hub was down become the owner's commits (docs/wiki.md).
  const handEdits = () => { const h = adoptHandEdits(root); if (h.adopted.length || h.held.length) log(`${stamp()} hand edits: ${h.adopted.length} committed, ${h.held.length} held`); };
  void serial(async () => handEdits()).catch((e) => log(`${stamp()} hand edits: ${(e as Error).message}`));
  // Facts an older hub froze while a conflict waited for the Gardener get their live value back (G425).
  void serial(async () => { const n = unfreezeHeld(root); if (n.length) log(`${stamp()} conflicts: ${n.length} frozen fact(s) given their live value back`); }).catch((e) => log(`${stamp()} conflicts: ${(e as Error).message}`));
  // Yes taps from before G424 rank as their source, not as the owner's word (G424).
  void serial(async () => { const n = rankOldTaps(root); if (n.length) log(`${stamp()} taps: ${n.length} fact(s) approved before G424 now rank as their source`); }).catch((e) => log(`${stamp()} taps: ${(e as Error).message}`));
  // Captures an older hub answered accepted with nothing saved go back to the inbox (G431).
  void serial(async () => { const n = reopenLostAccepts(root); if (n.length) log(`${stamp()} inbox: ${n.length} accepted capture(s) with nothing saved back in the inbox`); }).catch((e) => log(`${stamp()} inbox: ${(e as Error).message}`));
  // Handoffs a restart left mid request check get their verdict now (src/handoff.ts).
  void settleLeftovers(root, { lock: serial }).then((n) => { if (n) log(`${stamp()} handoffs: settled ${n} left checking by a restart`); }).catch((e) => log(`${stamp()} handoffs: ${(e as Error).message}`));
  // Daily jobs: checked every minute; a hub that was asleep at 3:00 runs them when it wakes.
  const daily = () => serial(async function dailyJobs() {
    for (const job of dueJobs(root, new Date(), opts.schedule)) {
      const r = await runJob(root, job, async () => {
        if (job === "night") {
          // night: managed leaves upkeep and forgetting to the gardener unless it has been silent
          // 36 hours; journal consolidation always stays here (journals never leave the hub).
          handEdits();
          const plan = nightPlan(root);
          // Name keys for a few sources read before they were kept, so tonight's page text links them.
          await backfillNameKeys(root, new Date(Date.now() - PAGE_TEXT_HOURS * 3_600_000).toISOString());
          const u = plan.full ? upkeep(root) : undefined;
          // Page text runs every night: with a managed Gardener upkeep is its job, but the page
          // writer is the hub's (src/wiki.ts; upkeep step 1d runs it when upkeep runs here).
          const pages = nightPageText(root, plan.full);
          if (pages?.written.length) log(`${stamp()} page text: ${pages.written.length} page(s)`);
          // Due and stale facts rechecked at their cited source (no model; the gardener's upkeep_run does the same).
          const rc = plan.full ? await recheckDue(root) : undefined;
          // Every night, as the page text: a few cited items read for the words a fact came from,
          // so a page shows what its sources said (the hub's job, a managed Gardener or not).
          const words = await keepSourceWords(root);
          if (words) log(`${stamp()} source words: read ${words} cited item(s)`);
          const r = await sleep(root, plan.full
            ? { model: modelIfKeyed(root, SLEEP_STEP), judge: modelIfKeyed(root, "upkeep.duplicates") }
            : { model: modelIfKeyed(root, SLEEP_STEP), steps: { forget: false, consolidate: true } });
          // Checks after writes that a down or capped model left pending get another try.
          requeueMissed(root); // a check a restart cut off between a write and its queue line
          const a = await drainAftercheck(root);
          // Memory corrections a restart left between two steps are finished or handed to the owner.
          for (const line of resumeCorrections(root)) log(`${stamp()} memsync: ${line}`);
          await settleLeftovers(root);
          if (plan.why !== "night: local") log(`${stamp()} ${plan.why}`);
          log(`${stamp()} night: ${u ? `${u.findings.length} upkeep finding(s)` : "upkeep left to the gardener"}${rc?.checked || rc?.sampled ? `; rechecked ${rc.checked} source item(s) and checked ${rc.sampled} more still exist: ${rc.confirmed.length} confirmed, ${rc.due.length} due` : ""}; ${r.run}${a.checked.length + a.errors.length ? `; ${a.checked.length} write check(s), ${a.errors.length} still failing` : ""}`);
        } else if (job === "audit") log(`${stamp()} ${auditCarve(root).text.split("\n")[0]}`);
        else if (job === "drill") log(`${stamp()} ${await drillApart(root)}`);
        else {
          // The weekly memory exam goes first, so the digest carries its grades.
          if (examDue(root)) log(`${stamp()} memory exam: ${examRun(root).rows.map((r) => `${r.agent} ${r.grade}`).join(", ")}`);
          log(`${stamp()} digest: ${digest(root).needsLouis} item(s) need you`);
        }
      });
      if (r !== "ok") log(`${stamp()} ${r}`);
      // Always, even when the pass failed or timed out: can every note still be found?
      if (job === "night") {
        const s = await runJob(root, "searchable", () => { const p = unsearchable(root); if (p.length) throw new Error(`${p.length} note(s) can't be found: ${p.slice(0, 3).join("; ")}`); });
        if (s !== "ok") log(`${stamp()} ${s}`);
        // Facts with no live source get the mail that states them (src/backfill.ts; report-only
        // until the owner's `pocketbrain backfill on`), then the day's trust numbers are kept for the week-on-week line (src/trust.ts). No model.
        log(`${stamp()} ${await runJob(root, "backfill", async () => nightBackfillLine(await nightBackfill(root)))}`);
        log(`${stamp()} ${await runJob(root, "trust", () => { const t = trustReport(root); recordTrust(root, t); return `trust: ${t.facts} facts, ${trustLine(t)}`; })}`);
        // Hub logs rotated, git packed, .git against its budget (src/growth.ts).
        log(`${stamp()} ${await runJob(root, "housekeeping", () => housekeeping(root))}`);
      }
    }
  }, { limitMs: (JOB_MINUTES + 5) * 60_000 });
  setInterval(daily, 60_000);
  void daily();
  // The gardener's Anthropic side (rules/gardener.yaml): ended sessions deleted, token rotated.
  const tend = () => serial(() => tendOnce(root, log), { name: "gardener tend", limitMs: 10 * 60_000 });
  setInterval(tend, 60_000);
  // Health probe (src/probe.ts): local hub, public door, plain-401 MCP door, OAuth door. A check
  // that starts failing becomes one alert, which the digest, dashboard and text channel surface.
  if (opts.localUrl) {
    // Not under serial(): network waits must not hold up writes; it only writes log/probe.json.
    let busy = false;
    const probe = async () => {
      if (busy) return;
      busy = true;
      try { for (const c of await probeOnce(root, opts.localUrl!)) log(`${stamp()} probe ${c.name} FAILING: ${c.detail}`); }
      catch (e) { log(`${stamp()} probe: ${(e as Error).message}`); }
      finally { busy = false; }
    };
    setTimeout(probe, 60_000);
    setInterval(probe, Number(process.env.PB_PROBE_MINUTES ?? 120) * 60_000);
  }
  // The north star on this brain, once per code version (so after every deploy), report-only.
  // The Mac's `deploy go` usually ran it already for this code; then this finds the record and skips.
  setTimeout(() => void northStarAfterStart(root).then((r) => { if (r) log(`${stamp()} ${northStarLine(r)}`); }, (e) => log(`${stamp()} north star: ${(e as Error).message}`)), 5 * 60_000);
  // Source pulls (rules/sources.yaml), every poll_minutes. A failing source is a digest alert.
  setInterval(() => void pullTick(root, log), 60_000);
  // Facts file themselves on the hub's own tick, whether or not the text channel is set up (G422).
  setInterval(() => void fileTick(root, log), 60_000);
  // The owner's diary catches up with fact changes that came without a line (src/diary-catchup.ts).
  void diaryTick(root, log);
  setInterval(() => void diaryTick(root, log), 60_000);
  // The text channel, when the owner set it up.
  if (existsSync(join(root, "rules", "escalation.yaml"))) { watch(root, { log, lock: serial }); log("text channel: on"); }
  else log("text channel: off (pocketbrain textline init to set it up)");
  // The relay, when its inbox-scoped key is in the environment.
  const key = process.env.AGENTMAIL_RELAY_KEY;
  if (key) {
    const t = agentMailTransport(loadRelayConfig(root), key);
    let relaying = false; // one tick at a time; a slow model call skips the next tick, never queues it
    setInterval(async () => {
      if (relaying) return;
      relaying = true;
      try { for (const v of await relayTick(root, t, { lock: serial })) log(`${stamp()} relay ${v.id}: ${v.deliver ? "delivered" : "HELD"}`); } catch (e) { log(`${stamp()} relay: ${(e as Error).message}`); } finally { relaying = false; }
    }, 60_000);
    log("relay: on (AgentMail)");
  } else log("relay: off (set AGENTMAIL_RELAY_KEY to turn it on)");
}

// The Sunday restore test in a child process (`pocketbrain drill --weekly`), stopped after 30
// minutes: it reads the synced folder and boots a hub on a scratch copy, neither of which may hold
// this process. The child writes its own result and heartbeat; a child that dies or is stopped
// leaves a failed heartbeat here instead.
export const DRILL_MINUTES = 30;
type DrillChild = { exited: Promise<number>; kill: (signal?: string) => void };
export async function drillApart(root: string, o: { spawn?: (cmd: string[]) => DrillChild; timeoutMs?: number } = {}): Promise<string> {
  const cmd = [process.execPath, join(import.meta.dir, "cli.ts"), "drill", "--weekly", "--brain", root];
  const child = (o.spawn ?? ((c) => Bun.spawn(c, { stdout: "inherit", stderr: "inherit" }) as unknown as DrillChild))(cmd);
  const ms = o.timeoutMs ?? DRILL_MINUTES * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const code = await Promise.race([child.exited, new Promise<"late">((done) => { timer = setTimeout(() => done("late"), ms); })]);
  if (timer) clearTimeout(timer);
  if (code === "late") {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    beat(root, "restore_drill", { ok: false, error: `the restore test didn't finish in ${Math.round(ms / 60_000) || 1} min and was stopped` });
    throw new Error(`restore test stopped after ${Math.round(ms / 60_000) || 1} min`);
  }
  if (code !== 0 && code !== 1) beat(root, "restore_drill", { ok: false, error: `the restore test exited ${code}` });
  return code === 0 ? "restore test: passed" : `restore test: FAILED (exit ${code}; see pocketbrain doctor)`;
}

// The minute tick for source pulls. Reading sources.yaml is inside the try: a file mid-edit is
// logged and kept in log/start-state.json as `pull_error`, which the probe turns into one alert
// (bug hunt #147; tendOnce does the same for gardener.yaml). It never rejects, so a bad file
// can't take `start` down.
const tickStamp = () => new Date().toISOString().slice(0, 16);
// What captures, pulls and assistants proposed files itself (src/filing.ts runAuto): once a minute,
// in the write queue, so it never commits between another write's steps.
export function fileTick(root: string, log: (s: string) => void): Promise<void> {
  return serial(async function file() {
    // Without the text channel only filing runs here; expiry and source saves are the channel's.
    const done = runAuto(root, new Date(), new Set(), { filingOnly: !existsSync(join(root, "rules", "escalation.yaml")) });
    if (done.length) log(`${tickStamp()} filed ${done.length} for you`);
  }, { limitMs: 5 * 60_000 }).then(() => undefined, (e) => log(`${tickStamp()} filing: ${(e as Error).message}`));
}

export function diaryTick(root: string, log: (s: string) => void): Promise<void> {
  return serial(async function diary() {
    const r = catchUpDiary(root, new Date());
    if (r.unsaved) log(`${tickStamp()} diary catch-up not saved: ${r.unsaved}`);
    else if (r.rows) log(`${tickStamp()} diary: ${r.rows} line(s) caught up from ${r.commits} commit(s)`);
  }, { limitMs: 5 * 60_000 }).then(() => undefined, (e) => log(`${tickStamp()} diary: ${(e as Error).message}`));
}

export function pullTick(root: string, log: (s: string) => void): Promise<void> {
  return serial(async function pull() {
    let due: boolean;
    try { due = pullsDue(root); }
    catch (e) { log(`${tickStamp()} pull failed: ${(e as Error).message}`); recordJob(root, "pull", e as Error); return; }
    if (!due) { clearJobError(root, "pull"); return; }
    const r = await runJob(root, "pull", async () => { for (const r of await pullAll(root)) log(`${tickStamp()} pull ${r.source}: ${r.refused ?? `${r.stored.length} read, ${r.confirmed ?? 0} confirmed, ${r.proposals ?? 0} proposed, ${r.due.length} due${r.capped ? ", daily cap reached" : ""}`}`); }, Math.min(JOB_MINUTES, 15) * 60_000);
    if (r !== "ok") log(`${tickStamp()} ${r}`);
  }, { limitMs: 20 * 60_000 }).then(() => undefined, () => undefined);
}
// A tick that has nothing to do clears a config error once the file parses again; it doesn't
// stamp <job>_at, which would read as a run.
function clearJobError(root: string, job: string) {
  const s = lastRuns(root);
  if (!s[`${job}_error`]) return;
  delete s[`${job}_error`];
  writeFileSync(stateFile(root), JSON.stringify(s));
}

// launchd plists for a Mac hub: one for `start`, one for the Cloudflare tunnel. The tunnel gets
// its config path explicitly (the ingress from `hub tunnel-config`), so it never falls back to
// forwarding every path.
// `interval`: run every that many seconds (a check), instead of kept running (the hub, the tunnel).
export function launchdPlist(o: { label: string; args: string[]; cwd: string; env?: Record<string, string>; logDir: string; interval?: number }): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(o.label)}</string>
  <key>ProgramArguments</key>
  <array>
${o.args.map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${esc(o.cwd)}</string>
${o.env && Object.keys(o.env).length ? `  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(o.env).map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`).join("\n")}
  </dict>
` : ""}${o.interval ? `  <key>StartInterval</key><integer>${o.interval}</integer>` : `  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>`}
  <key>StandardOutPath</key><string>${esc(join(o.logDir, `${o.label}.log`))}</string>
  <key>StandardErrorPath</key><string>${esc(join(o.logDir, `${o.label}.log`))}</string>
</dict>
</plist>
`;
}

export function hubPlists(root: string, o: { bun: string; app: string; home: string; tunnel?: string; cloudflared?: string; tunnelConfig?: string }) {
  const logDir = join(o.home, "Library", "Logs");
  const brain = resolve(root);
  const out = [{ file: "com.pocketbrain.start.plist", text: launchdPlist({ label: "com.pocketbrain.start", args: [o.bun, join(o.app, "src", "cli.ts"), "start", "--brain", brain], cwd: o.app, env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }, logDir }) }];
  if (o.tunnel) out.push({ file: "com.pocketbrain.tunnel.plist", text: launchdPlist({ label: "com.pocketbrain.tunnel", args: [o.cloudflared ?? "/opt/homebrew/bin/cloudflared", "tunnel", "--config", o.tunnelConfig ?? join(o.home, ".cloudflared", "config.yml"), "run", o.tunnel], cwd: o.home, logDir }) });
  // The watchdog (src/watchdog.ts): its own job, so a hub that hangs can't freeze it too.
  out.push({ file: "com.pocketbrain.watchdog.plist", text: launchdPlist({ label: "com.pocketbrain.watchdog", args: [o.bun, join(o.app, "src", "cli.ts"), "watchdog", "--brain", brain], cwd: o.app, env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }, logDir, interval: 300 }) });
  return out;
}
