// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain start`: everything the hub runs, in one process, so one launchd (or systemd)
// entry keeps the brain alive: the agents' server, the owner dashboard, the text channel, the
// relay (when its key is set), and the nightly pass (upkeep, then sleep) and morning digest
// (with the memory exam on Sundays).
// `serve` keeps working for those who want the pieces separately.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { upkeep } from "./upkeep";
import { sleep, STEP as SLEEP_STEP } from "./sleep";
import { digest } from "./digest";
import { makeModel, modelConfigFor, KEY_ENV, type Model } from "./model";
import { serial } from "./server";
import { watch } from "./textline/poll";
import { relayTick, agentMailTransport, loadRelayConfig } from "./relay";
import { drainAftercheck, requeueMissed } from "./aftercheck";
import { resumeCorrections } from "./memsync";
import { settleLeftovers } from "./handoff";
import { nightPlan, dueGardenerJobs, cleanup, rotate } from "./gardener";
import { housekeeping } from "./growth";
import { probeOnce, unsearchable, recordStart } from "./probe";
import { pullAll, pullsDue, recheckDue } from "./pull";
import { examDue, examRun } from "./exam";
import { auditCarve } from "./audit";

export interface Schedule { night_hour: number; digest_hour: number }
export const DEFAULT_SCHEDULE: Schedule = { night_hour: 3, digest_hour: 7 };

// A model for a step only when its key is there; without one the step runs its rule-only part.
function modelIfKeyed(root: string, step: string): Model | undefined {
  const cfg = modelConfigFor(root, step);
  const env = cfg.api_key_env ?? KEY_ENV[cfg.provider];
  return cfg.provider === "openai-compatible" || (env && process.env[env]) ? makeModel(cfg) : undefined;
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
export function recordJob(root: string, job: string, err: Error | undefined, now = new Date()) {
  mkdirSync(join(root, "log"), { recursive: true });
  const s: Record<string, string> = { ...lastRuns(root) };
  if (err) s[`${job}_error`] = err.message.slice(0, 200);
  else { s[`${job}_at`] = now.toISOString(); delete s[`${job}_error`]; }
  writeFileSync(stateFile(root), JSON.stringify(s));
}

// A job that hangs would otherwise show as nothing at all: past its time it is recorded as failed
// (the probe alerts on it) while it keeps running. runJob still waits for it, so the hub's write
// queue stays held: a job cut loose could write alongside the agents. A late finish doesn't clear
// the alarm; the next run on time does.
export const JOB_MINUTES = Number(process.env.PB_JOB_MINUTES ?? 45);
export async function runJob(root: string, job: string, fn: () => Promise<unknown> | unknown, ms = JOB_MINUTES * 60_000): Promise<string> {
  const limit = ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms}ms`;
  let late = false;
  const timer = setTimeout(() => { late = true; recordJob(root, job, new Error(`timed out after ${limit}; still running`)); }, ms);
  try {
    const r = await Promise.resolve().then(fn);
    if (late) { recordJob(root, job, new Error(`timed out after ${limit}; ended late`)); return `${job} failed: timed out after ${limit} (ended late)`; }
    recordJob(root, job, undefined);
    return typeof r === "string" ? r : "ok";
  } catch (e) {
    recordJob(root, job, e as Error);
    return `${job} failed: ${late ? `timed out after ${limit}, then ` : ""}${(e as Error).message}`;
  } finally { clearTimeout(timer); }
}

// The gardener's Anthropic jobs, checked every minute. A throw is recorded like a daily job's
// (gardener_cleanup, gardener_rotate, or gardener_jobs when rules/gardener.yaml itself is broken),
// so the probe and the digest show it instead of a line in a log file.
export function tendOnce(root: string, log: (s: string) => void, now = new Date()) {
  const stamp = () => now.toISOString().slice(0, 16);
  let jobs: ("cleanup" | "rotate")[];
  try { jobs = dueGardenerJobs(root, now); if (lastRuns(root).gardener_jobs_error) recordJob(root, "gardener_jobs", undefined, now); }
  catch (e) { recordJob(root, "gardener_jobs", e as Error, now); log(`${stamp()} gardener jobs failed: ${(e as Error).message}`); return; }
  for (const job of jobs) {
    try {
      const r = job === "cleanup" ? cleanup(root, now) : rotate(root);
      log(`${stamp()} ${r.message}`);
      recordJob(root, `gardener_${job}`, r.ok ? undefined : new Error(r.message), now);
    }
    catch (e) { recordJob(root, `gardener_${job}`, e as Error, now); log(`${stamp()} gardener ${job} failed: ${(e as Error).message}`); }
  }
}

// Which jobs are due at `now` (local time), each at most once per local day: the nightly pass and
// the digest every day, the carve audit (src/audit.ts) on Sundays after the nightly pass.
type Job = "night" | "audit" | "digest";
export function dueJobs(root: string, now: Date, s: Schedule = DEFAULT_SCHEDULE): Job[] {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const done = lastRuns(root);
  const out: Job[] = [];
  if (now.getHours() >= s.night_hour && done.night !== day) out.push("night");
  if (now.getDay() === 0 && now.getHours() >= s.night_hour && done.audit !== day) out.push("audit");
  if (now.getHours() >= s.digest_hour && done.digest !== day) out.push("digest");
  return out.map((j) => { markRun(root, j, day); return j; });
}

export function startJobs(root: string, opts: { log?: (s: string) => void; schedule?: Schedule; localUrl?: string } = {}) {
  const log = opts.log ?? ((s: string) => console.log(s));
  const stamp = () => new Date().toISOString().slice(0, 16);
  recordStart(root); // the self-check's restart-loop count (src/probe.ts selfChecks)
  // Handoffs a restart left mid request check get their verdict now (src/handoff.ts).
  void settleLeftovers(root, { lock: serial }).then((n) => { if (n) log(`${stamp()} handoffs: settled ${n} left checking by a restart`); }).catch((e) => log(`${stamp()} handoffs: ${(e as Error).message}`));
  // Daily jobs: checked every minute; a hub that was asleep at 3:00 runs them when it wakes.
  const daily = () => serial(async () => {
    for (const job of dueJobs(root, new Date(), opts.schedule)) {
      const r = await runJob(root, job, async () => {
        if (job === "night") {
          // night: managed leaves upkeep and forgetting to the gardener unless it has been silent
          // 36 hours; journal consolidation always stays here (journals never leave the hub).
          const plan = nightPlan(root);
          const u = plan.full ? upkeep(root) : undefined;
          // Due and stale facts rechecked at their cited source (no model; the gardener's upkeep_run does the same).
          const rc = plan.full ? await recheckDue(root) : undefined;
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
          log(`${stamp()} night: ${u ? `${u.findings.length} upkeep finding(s)` : "upkeep left to the gardener"}${rc?.checked ? `; rechecked ${rc.checked} source item(s): ${rc.confirmed.length} confirmed, ${rc.due.length} due` : ""}; ${r.run}${a.checked.length + a.errors.length ? `; ${a.checked.length} write check(s), ${a.errors.length} still failing` : ""}`);
        } else if (job === "audit") log(`${stamp()} ${auditCarve(root).text.split("\n")[0]}`);
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
        // Hub logs rotated, git packed, .git against its budget (src/growth.ts).
        log(`${stamp()} ${await runJob(root, "housekeeping", () => housekeeping(root))}`);
      }
    }
  });
  setInterval(daily, 60_000);
  void daily();
  // The gardener's Anthropic side (rules/gardener.yaml): ended sessions deleted, token rotated.
  const tend = () => serial(() => tendOnce(root, log));
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
  // Source pulls (rules/sources.yaml), every poll_minutes. A failing source is a digest alert.
  const pull = () => serial(async () => {
    if (!pullsDue(root)) return;
    const r = await runJob(root, "pull", async () => { for (const r of await pullAll(root)) log(`${stamp()} pull ${r.source}: ${r.refused ?? `${r.stored.length} read, ${r.confirmed ?? 0} confirmed, ${r.proposals ?? 0} proposed, ${r.due.length} due${r.capped ? ", daily cap reached" : ""}`}`); }, Math.min(JOB_MINUTES, 15) * 60_000);
    if (r !== "ok") log(`${stamp()} ${r}`);
  });
  setInterval(pull, 60_000);
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

// launchd plists for a Mac hub: one for `start`, one for the Cloudflare tunnel. The tunnel gets
// its config path explicitly (the ingress from `hub tunnel-config`), so it never falls back to
// forwarding every path.
export function launchdPlist(o: { label: string; args: string[]; cwd: string; env?: Record<string, string>; logDir: string }): string {
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
` : ""}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
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
  return out;
}
