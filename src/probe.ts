// SPDX-License-Identifier: AGPL-3.0-only
// Health probe, run by `start` every couple of hours: the things that broke silently before
// (tunnel down, the MCP door answering in a way Town turns into an OAuth flow, the OAuth door
// gone). Each check is ok or failing; a check that turns from ok to failing raises one alert
// (log/alerts.jsonl, so the digest, dashboard and text channel surface it), and one that
// recovers is noted in log/probe.json. No new outward channel.
import { FILING_CODE } from "./filing";
import type { StartKind } from "./measure";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadHub } from "./hub";
import { alert, readJsonl, appendJsonl, codeVersion, codeAtStart } from "./util";
import { loadBackupConfig, lastBackup, lastPush, due } from "./backup";
import { modelConfigFor, KEY_ENV } from "./model";
import { keysDir } from "./secrets";
import { silentSources } from "./fill";
import { loadBrain } from "./brain";
import { loadRules, gardeners, type Rules } from "./rules";
import { carve, grantFor } from "./carve";
import { scoringIndex, foundBy, terms } from "./retrieve";
import { missedWindows, nightMode, gardenerConfig, ANT_SIGN_IN } from "./gardener";
import { freeDiskMb } from "./textline/items";
import { offsiteCheck } from "./offsite";
import { drillCheck } from "./restore-drill";
import { beat } from "./heartbeat";
import { loadUpcoming, seriesId } from "./upcoming";
import YAML from "yaml";
import { tailnetSettings, serveDoorProblem } from "./dashboard/tailnet";
import { filedWithoutLine } from "./diary";
const readYamlFile = (f: string): { sources?: Record<string, unknown> } | undefined => existsSync(f) ? YAML.parse(readFileSync(f, "utf8")) : undefined;

// warn: an early warning (alert check probe_warn_<name>): it reaches the owner like any alert but
// isn't a hub failure, so it doesn't break the real-use streak (src/measure.ts).
export interface Check { name: string; ok: boolean; detail: string; warn?: boolean }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function get(f: Fetch, url: string, init: RequestInit = {}): Promise<Response | undefined> {
  try { return await f(url, { redirect: "manual", signal: AbortSignal.timeout(8000), ...init }); } catch { return undefined; }
}

export async function runChecks(root: string, localUrl: string, f: Fetch = fetch, serveStatus?: Parameters<typeof serveDoorProblem>[1]): Promise<Check[]> {
  const out: Check[] = [];
  const local = await get(f, `${localUrl}/health`);
  out.push({ name: "local", ok: local?.status === 200, detail: local ? `hub /health answered ${local.status}` : "hub /health did not answer" });
  // The phone app's https door (G629): `tailscale serve` on 8443, needed once the owner's login is set.
  const tn = tailnetSettings(root);
  if (tn.dashboard_tailnet && tn.dashboard_tailnet_login) {
    const problem = serveDoorProblem(tn, serveStatus);
    out.push({ name: "phone_door", ok: !problem, detail: problem ?? "tailscale serve answers https on 8443 for the dashboard" });
  }
  const pub = loadHub(root)?.public_url?.replace(/\/+$/, "");
  if (!pub) return out;
  const door = await get(f, `${pub}/health`);
  out.push({ name: "door", ok: door?.status === 200, detail: door ? `${pub}/health answered ${door.status}` : `${pub}/health did not answer; check the tunnel` });
  // Town treats a 401 with WWW-Authenticate as "start OAuth", so the bearer door must stay plain.
  const mcp = await get(f, `${pub}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const plain = mcp?.status === 401 && !mcp.headers.get("www-authenticate");
  out.push({ name: "mcp", ok: plain, detail: mcp ? `${pub}/mcp without a token answered ${mcp.status}${mcp.headers.get("www-authenticate") ? " with WWW-Authenticate" : ""}; expected a plain 401` : `${pub}/mcp did not answer` });
  if (existsSync(join(root, "rules", "oauth.yaml"))) {
    const meta = await get(f, `${pub}/.well-known/oauth-protected-resource/mcp/oauth`);
    out.push({ name: "oauth", ok: meta?.status === 200, detail: meta ? `OAuth door metadata answered ${meta.status}` : "OAuth door metadata did not answer" });
  }
  return out;
}

interface State { [name: string]: { ok: boolean; since: string; detail: string } }

// Records results and alerts on ok -> failing (and on a first run that fails). Returns the new failures.
export function record(root: string, checks: Check[], now = new Date()): Check[] {
  const file = join(root, "log", "probe.json");
  // A torn file (the hub died mid-write) starts over: every failing check alerts again, rather
  // than this throwing before any alert on every run after (bug hunt #134).
  let prev: State = {};
  try { if (existsSync(file)) prev = JSON.parse(readFileSync(file, "utf8")); } catch { /* torn: start over */ }
  const next: State = {};
  const fresh: Check[] = [];
  for (const c of checks) {
    const was = prev[c.name];
    next[c.name] = was && was.ok === c.ok ? { ...was, detail: c.detail } : { ok: c.ok, since: now.toISOString(), detail: c.detail };
    if (!c.ok && (!was || was.ok)) {
      fresh.push(c);
      alert(root, { agent: "hub", check: `probe_${c.warn ? "warn_" : ""}${c.name}`, from: c.detail });
    }
  }
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(next, null, 2) + "\n");
  renameSync(file + ".tmp", file);
  return fresh;
}

// Checks that need no network: the jobs `start` runs on its own. Each appears only once the
// thing it watches exists (the hub ran `start`, backups are set up, a text was sent), so a new
// brain has none. A job that throws, or stops running, is otherwise only a line in a log file.
const STALE_HOURS = 36;
export function jobChecks(root: string, now = new Date()): Check[] {
  const out: Check[] = [];
  let s: Record<string, string> = {};
  try { s = JSON.parse(readFileSync(join(root, "log", "start-state.json"), "utf8")); } catch { /* the hub never ran start */ }
  // night and digest are daily; searchable, backfill, trust and housekeeping run after night; pull every few minutes.
  for (const job of ["night", "digest", "searchable", "backfill", "trust", "housekeeping", "pull"]) {
    if (!s[job] && !s[`${job}_at`] && !s[`${job}_error`]) continue;
    const at = s[`${job}_at`] ?? `${s[job]}T12:00:00Z`;
    const hours = (now.getTime() - Date.parse(at)) / 3_600_000;
    out.push(s[`${job}_error`] ? { name: job, ok: false, detail: `${job} failed: ${s[`${job}_error`]}` }
      : hours > STALE_HOURS ? { name: job, ok: false, detail: `${job} last ran ${at.slice(0, 16)}, over ${STALE_HOURS}h ago; is the hub running start?` }
      : { name: job, ok: true, detail: `${job} ran ${at.slice(0, 16)}` });
  }
  // The gardener's Anthropic jobs (start.ts tendOnce): only a failure or a success is known, no schedule to be late on.
  // A lost ant login fails cleanup and rotation alike: one line, the hand step, not one per job (G745).
  const gjobs = ["gardener_jobs", "gardener_cleanup", "gardener_rotate"];
  const signin = gjobs.filter((job) => s[`${job}_error`]?.includes(ANT_SIGN_IN));
  for (const job of gjobs) {
    if (signin.includes(job)) continue;
    if (s[`${job}_error`]) out.push({ name: job, ok: false, detail: `${job} failed: ${s[`${job}_error`]}` });
    else if (s[`${job}_at`] && job !== "gardener_jobs") out.push({ name: job, ok: true, detail: `${job} ran ${s[`${job}_at`].slice(0, 16)}` });
  }
  if (signin.length) out.push({ name: "gardener_signin", ok: false, detail: `the gardener's ${signin.map((j) => j.replace("gardener_", "")).join(" and ")} can't reach Anthropic: ${s[`${signin[0]}_error`]!.replace(/^gardener \w+: /, "")}` });
  else if (gjobs.some((job) => s[`${job}_at`])) out.push({ name: "gardener_signin", ok: true, detail: "the ant CLI's login works" });
  // The gardener's runs: each hours window's latest occurrence should show it connecting. The weekly
  // run calls no upkeep_run, so without this a weekly run that stops is silent.
  let rules: Rules | undefined;
  try { rules = loadRules(root); } catch { /* a broken policy is the doctor's to report */ }
  // A gardener on Anthropic needs rules/gardener.yaml for its session cleanup and token rotation;
  // without it neither is ever scheduled, and nothing else would say so.
  if (rules && gardeners(rules).length && nightMode(root) === "managed" && !gardenerConfig(root))
    out.push({ name: "gardener_setup", ok: false, detail: `no rules/gardener.yaml: the gardener's ended sessions are never cleaned up and its token is never rotated; the owner adds the file (docs/gardener.md)` });
  for (const g of rules ? gardeners(rules) : []) {
    if (rules!.policy.agents[g]?.status === "paused") continue;
    const missed = missedWindows(root, rules!, g, now);
    if (!missed) continue;
    out.push(missed.length ? { name: "gardener_runs", ok: false, detail: `${g} didn't connect in its ${missed.join(", ")} window${missed.length > 1 ? "s" : ""}; check its deployments (pocketbrain doctor)` }
      : { name: "gardener_runs", ok: true, detail: `${g} connected in each of its latest windows` });
  }
  const last = loadBackupConfig(root) ? lastBackup(root) : undefined;
  if (last) {
    const hours = (now.getTime() - Date.parse(last.at)) / 3_600_000;
    const stale = hours > 48 && due(root, now).due;
    out.push({ name: "backup", ok: !stale, detail: stale ? `last backup ${last.at.slice(0, 10)} and the brain moved since; the backup job isn't running` : `last backup ${last.at.slice(0, 16)}` });
  }
  // The hourly push to origin (src/backup.ts pushOriginApart): one failure can be a network blip,
  // two in a row mean main is piling up on this disk only.
  const push = loadBackupConfig(root)?.push_origin ? lastPush(root) : undefined;
  if (push) out.push(push.fails >= 2 ? { name: "origin", ok: false, detail: `the last ${push.fails} pushes of the brain to origin failed (${push.error}); new commits are only on this disk. Run git push origin main in the brain folder to see why` }
    : { name: "origin", ok: true, detail: push.ok_at ? `brain pushed to origin ${push.ok_at.slice(0, 16)}` : "brain push to origin failed once; trying again within the hour" });
  // The model steps (the write-time conflict check, the sleep pass) quietly run rule-only without
  // their key. Only checked once the owner put that key in the keys folder: then a hub that didn't
  // load it (readable by others, empty, an old process) is a failure, not a choice.
  const envs = [...new Set(["write.conflicts", "sleep.consolidate"].map((step) => { const c = modelConfigFor(root, step); return c.api_key_env ?? KEY_ENV[c.provider]; }).filter((e): e is string => !!e))];
  const set = envs.filter((e) => existsSync(join(keysDir(), e)));
  const missing = set.filter((e) => !process.env[e]);
  if (set.length) out.push(missing.length
    ? { name: "model", ok: false, detail: `${missing.join(", ")} is in ${keysDir()} but the hub didn't load it (check it's chmod 600 and one line, then restart); the conflict check and model sleep steps are being skipped` }
    : { name: "model", ok: true, detail: `${set.join(", ")} loaded; model steps run` });
  // A source that quietly stopped (docs/sources-pull.md, "Silent sources"): no proposal and nothing
  // re-confirmed for 72h (per source: silent_after_hours) after the consent line. Only once a source
  // has been watched that long. A sources.yaml that doesn't parse is the `pull` check's to report;
  // throwing here would take every other job check down with it.
  let quiet: ReturnType<typeof silentSources>;
  try { quiet = silentSources(root, now); } catch { quiet = undefined; }
  if (quiet?.watched.length) out.push(quiet.silent.length
    ? { name: "fill", ok: false, detail: `no proposal and nothing re-confirmed from ${quiet.silent.map((x) => `${x.source} for ${x.hours}h (${x.last ? `last ${x.last}` : "never"})`).join(", ")}; a pull that stopped looks like a quiet week. Run pocketbrain sources pull <name> and pocketbrain fill; a channel quiet by nature takes silent_after_hours in rules/sources.yaml` }
    : { name: "fill", ok: true, detail: `${quiet.watched.length} source(s) producing` });
  const d = deployCheck(now);
  if (d) out.push(d);
  out.push(...selfChecks(root, now));
  const off = offsiteCheck(root, now);
  if (off) out.push(off);
  const dr = drillCheck(root, now);
  if (dr) out.push(dr);
  const sends = readJsonl(join(root, "textline", "log.jsonl")).filter((e) => e.sent !== undefined).slice(-3);
  if (sends.length) {
    const failing = sends.length === 3 && sends.every((e) => e.ok === false);
    out.push({ name: "texts", ok: !failing, detail: failing ? `the last 3 texts didn't go out (${String(sends[2].via)}: ${String(sends[2].detail ?? "no detail")})` : "texts going out" });
  }
  return out;
}

// The daily self-check (docs/real-use-bar.md): what would otherwise need a hand fix before the
// owner notices. Like the job checks, each appears once the thing it watches exists; disk and log
// size once the hub has run `start`. They go through record(), so a failure alerts once and the digest lists it.
const WATCHDOG_MINUTES = 15;
const QUIET_HOURS = 72, LOOKBACK_DAYS = 14, MIN_FREE_MB = 1024, RESTARTS = 5, RESTART_HOURS = 6, UNRELEASED_DAYS = 7;
export function selfChecks(root: string, now = new Date()): Check[] {
  const out: Check[] = [];
  const hoursSince = (at: string) => (now.getTime() - Date.parse(at)) / 3_600_000;
  const rules = loadRules(root);
  // A gardener's missed night is jobChecks' gardener_runs (per hours window), not repeated here.
  // An assistant that used the brain in the last two weeks and has been silent 3 days: most
  // often a token or OAuth connection that stopped working without telling anyone.
  const lastRead = new Map<string, string>();
  for (const r of readJsonl<{ at?: string; agent?: string }>(join(root, "log", "reads.jsonl"))) if (r.agent && r.at && r.at > (lastRead.get(r.agent) ?? "")) lastRead.set(r.agent, r.at);
  const live = Object.entries(rules.policy.agents).filter(([n, a]) => a.role !== "gardener" && !a.inside_wall && (a.status ?? "active") !== "paused" && lastRead.has(n) && hoursSince(lastRead.get(n)!) <= LOOKBACK_DAYS * 24).map(([n]) => n);
  if (live.length) {
    const quiet = live.filter((n) => hoursSince(lastRead.get(n)!) > QUIET_HOURS);
    out.push(quiet.length
      ? { name: "connections", ok: false, warn: true, detail: `${quiet.map((n) => `${n} (last read ${lastRead.get(n)!.slice(0, 10)})`).join(", ")} stopped reading the brain ${QUIET_HOURS / 24}+ days ago; its token or connection may need a reconnect` }
      : { name: "connections", ok: true, detail: `${live.length} assistant(s) reading` });
  }
  const logDir = join(root, "log");
  const hubRan = existsSync(join(logDir, "starts.jsonl")) || existsSync(join(logDir, "start-state.json"));
  const mb = hubRan ? freeDiskMb(root) : undefined;
  if (mb !== undefined) out.push({ name: "disk", ok: mb >= MIN_FREE_MB, detail: `${Math.round(mb)} MB free on the brain's disk${mb < MIN_FREE_MB ? `, under ${MIN_FREE_MB} MB` : ""}` });
  const sizes = existsSync(logDir) ? readdirSync(logDir).filter((f) => /\.jsonl?$/.test(f)).map((f) => ({ f, mb: statSync(join(logDir, f)).size / 1_048_576 })).sort((a, b) => b.mb - a.mb) : [];
  const total = sizes.reduce((n, x) => n + x.mb, 0), cap = Number(process.env.PB_LOG_MAX_MB ?? 500);
  if (hubRan) out.push(total > cap
    ? { name: "logs", ok: false, warn: true, detail: `log/ is ${total.toFixed(1)} MB, over ${cap} MB; biggest: ${sizes.slice(0, 3).map((x) => `${x.f} ${x.mb.toFixed(1)} MB`).join(", ")}` }
    : { name: "logs", ok: true, detail: `log/ is ${total.toFixed(1)} MB` });
  // A planned start (an update, a reboot, the watchdog's kickstart: src/measure.ts startKind) isn't a crash.
  const starts = readJsonl<{ at?: string; kind?: string }>(join(logDir, "starts.jsonl"));
  if (starts.length) {
    const recent = starts.filter((s) => s.at && hoursSince(s.at) <= RESTART_HOURS && s.kind !== "planned" && s.kind !== "first").length;
    out.push(recent >= RESTARTS
      ? { name: "restarts", ok: false, detail: `the hub started ${recent} times in ${RESTART_HOURS}h, none of them planned; it may be crashing and restarting (see ~/Library/Logs or the start log)` }
      : { name: "restarts", ok: true, detail: `${recent} start(s) in ${RESTART_HOURS}h` });
  }
  // The watchdog (src/watchdog.ts) leaves its time on every run, every 5 minutes; once it has run,
  // a heartbeat older than 15 minutes means nothing is watching the hub from outside any more.
  let wd: { last?: string } | undefined;
  try { wd = JSON.parse(readFileSync(join(logDir, "watchdog.json"), "utf8")); } catch { /* no watchdog on this machine */ }
  if (wd?.last) out.push(hoursSince(wd.last) * 60 > WATCHDOG_MINUTES
    ? { name: "watchdog", ok: false, detail: `the watchdog hasn't run since ${wd.last.slice(0, 16)}; check its launchd job (launchctl print gui/$(id -u)/com.pocketbrain.watchdog)` }
    : { name: "watchdog", ok: true, detail: `the watchdog ran ${wd.last.slice(0, 16)}` });
  const d = deployState();
  if (d && "unreleased_since" in d) out.push(d.unreleased_since && hoursSince(d.unreleased_since) > UNRELEASED_DAYS * 24
    ? { name: "release", ok: false, warn: true, detail: `main has changes not on the release branch since ${d.unreleased_since.slice(0, 10)}, over ${UNRELEASED_DAYS} days; the Mac runs an old version until a release is cut` }
    : { name: "release", ok: true, detail: d.unreleased_since ? `unreleased changes since ${d.unreleased_since.slice(0, 10)}` : "release branch is level with main" });
  out.push(...silentFailureChecks(root, now));
  return out;
}

// Failures that were only a line in a log (outside review 2026-10-25, G421). Counts, source names
// and refusal check names only: never a value, a title or a message id.
const CALENDAR_QUIET_HOURS = 72;
export function silentFailureChecks(root: string, now = new Date()): Check[] {
  const out: Check[] = [];
  const since = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();
  // A fact the hub planned to file whose save was refused waits for the owner (src/filing.ts decideNow).
  const errFile = join(root, "log", "auto-decisions-errors.jsonl");
  if (existsSync(errFile)) {
    const all = readJsonl<{ at?: string; key?: string; error?: string; code?: string }>(errFile);
    const checkOf = (e: { error?: string }) => /^([a-z][a-z_]*)[:\s]/.exec(String(e.error ?? ""))?.[1] ?? "other";
    const day = all.filter((e) => String(e.at ?? "") >= since(24));
    const keys = new Set(day.map((e) => e.key));
    const checks = [...new Set(day.map(checkOf))].sort();
    // Refused twice under this code, a save is parked until other code runs (src/filing.ts, G519):
    // no new line comes, so it counts for as long as its proposal is open, not one day (G538).
    const twice = new Map<string, number>();
    for (const e of all) if (e.code === FILING_CODE && e.key) twice.set(e.key, (twice.get(e.key) ?? 0) + 1);
    const open = (k: string) => k.startsWith("proposal:") && existsSync(join(root, "inbox", k.slice("proposal:".length).replace(/^inbox\//, "")));
    const parked = all.filter((e) => e.code === FILING_CODE && e.key && !keys.has(e.key) && twice.get(e.key)! >= 2 && open(e.key));
    const parkedKeys = new Set(parked.map((e) => e.key));
    const parkedChecks = [...new Set(parked.map(checkOf))].sort();
    const parts = [
      ...(keys.size ? [`${keys.size} fact${keys.size === 1 ? "" : "s"} couldn't file themselves in the last day (refused by ${checks.join(", ")}); they wait as cards and are tried again tomorrow`] : []),
      ...(parkedKeys.size ? [`${parkedKeys.size} fact${parkedKeys.size === 1 ? "" : "s"} parked: refused twice under this code (${parkedChecks.join(", ")}), ${parkedKeys.size === 1 ? "it waits" : "they wait"} as a card until you answer or new code runs`] : []),
    ];
    out.push(parts.length
      ? { name: "auto_saves", ok: false, warn: true, detail: parts.join("; ") }
      : { name: "auto_saves", ok: true, detail: "every planned save in the last day went through, and none is parked" });
  }
  // Every filing by the hub leaves a diary line the owner's home shows, with Undo (G524).
  if (existsSync(join(root, "log", "auto-decisions.jsonl"))) {
    const silent = filedWithoutLine(root, now);
    out.push(silent.length
      ? { name: "filed_lines", ok: false, warn: true, detail: `${silent.length} filing${silent.length === 1 ? "" : "s"} by the hub in the last day left no line on the home` }
      : { name: "filed_lines", ok: true, detail: "every filing in the last day has its line on the home" });
  }
  const runs = readJsonl<{ at?: string; source?: string; fetched?: number; capped?: boolean; deferred?: number }>(join(root, "log", "sources", "runs.jsonl"));
  // A source over its max_per_day: the rest is read tomorrow, which nobody saw outside the CLI.
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if (r.source && r.at && r.at >= since(24) && r.at > String(latest.get(r.source)?.at ?? "")) latest.set(r.source, r);
  if (latest.size) {
    const capped = [...latest.values()].filter((r) => r.capped);
    out.push(capped.length
      ? { name: "source_cap", ok: false, warn: true, detail: `${capped.map((r) => `${r.source} reached its daily limit (${r.deferred ?? 0} waiting)`).join(", ")}; the rest are read tomorrow. Raise max_per_day in rules/sources.yaml if this keeps happening` }
      : { name: "source_cap", ok: true, detail: "no source at its daily limit" });
  }
  // A calendar pull that read nothing for days while the calendar's coming events include ones it
  // never saw: its sync is broken, not quiet (Mac 2026-10-25: 299 of 300 runs read 0).
  let cal: [string, unknown][] = [];
  try { cal = Object.entries(readYamlFile(join(root, "rules", "sources.yaml"))?.sources ?? {}).filter(([, c]) => (c as { kind?: string }).kind === "gcal"); } catch { /* a broken sources.yaml is the pull check's */ }
  const coming = cal.length ? loadUpcoming(root, now.toISOString().slice(0, 10)) : [];
  for (const [name] of cal) {
    const mine = runs.filter((r) => r.source === name && r.at);
    const lastRead = mine.filter((r) => (r.fetched ?? 0) > 0).at(-1)?.at;
    const zeros = mine.filter((r) => !lastRead || String(r.at) > lastRead);
    if (!zeros.length || String(zeros[0].at) > since(CALENDAR_QUIET_HOURS)) continue;
    let seen: Record<string, string> = {};
    try { seen = JSON.parse(readFileSync(join(root, "log", "sources", `${name}.json`), "utf8")).seen ?? {}; } catch { /* never pulled */ }
    const missed = new Set(coming.filter((e) => e.source === name).map((e) => seriesId(e.id)).filter((id) => !(id in seen)));
    out.push(missed.size
      ? { name: "calendar_pull", ok: false, detail: `the ${name} calendar pull read nothing since ${(lastRead ?? String(zeros[0].at)).slice(0, 10)}, but ${missed.size} coming events on that calendar were never read: the pull is broken, not quiet. Run pocketbrain sources pull ${name} and pocketbrain doctor` }
      : { name: "calendar_pull", ok: true, detail: `the ${name} calendar is quiet: every coming event was read` });
  }
  return out;
}

// Each `start` leaves a line, so a hub that keeps crashing and coming back shows as a loop.
export function recordStart(root: string, now = new Date(), kind?: StartKind) { appendJsonl(join(root, "log", "starts.jsonl"), { at: now.toISOString(), pid: process.pid, ...(kind ? { kind } : {}) }); }

// The one digest line: how many of the hub's checks pass, from the probe's last record.
export function selfCheckLine(root: string): string | undefined {
  let s: State;
  try { s = JSON.parse(readFileSync(join(root, "log", "probe.json"), "utf8")); } catch { return undefined; }
  const all = Object.entries(s), bad = all.filter(([, v]) => !v.ok).map(([n]) => n);
  return bad.length ? `- Self-check: ${bad.length} of ${all.length} failing (${bad.join(", ")}); see Needs you` : `- Self-check: all ${all.length} ok`;
}

// The post-condition after the nightly pass: every note can still be found. A note whose file
// path doesn't match its id is unreadable by id; a note an agent's carve shows but its search
// index lacks, or that a search for its own title doesn't return, is invisible to that agent
// with no error anywhere. Returns one line per problem (paths and ids only, no values).
export function unsearchable(root: string): string[] {
  const out: string[] = [];
  const notes = loadBrain(root, { shared: true });
  for (const n of notes) if (n.path !== `${n.fm.id}.md`) out.push(`${n.path}: its id is ${n.fm.id}, so reads by id miss it`);
  const rules = loadRules(root);
  for (const [agent, a] of Object.entries(rules.policy.agents)) {
    if (a.inside_wall || a.status === "paused") continue;
    const res = carve(notes, rules, grantFor(rules, agent));
    const idx = scoringIndex(res, rules);
    const indexed = new Set(idx.docs.map((d) => d.id));
    for (const id of res.visible.keys()) {
      const title = res.visible.get(id)!.note.fm.title ?? "";
      if (!indexed.has(id)) out.push(`${id}: in ${agent}'s view but not in its search index`);
      else if (terms(title).length && !foundBy(idx, title, id, 50, { synonyms: false })) out.push(`${id}: ${agent}'s search for its title doesn't find it`);
    }
  }
  return out;
}

// Auto-update (scripts/deploy.ts) leaves deploy.json in the config folder. Only checked once it
// exists: a rollback, a block, a fetch that keeps failing, or a release follower (the launchd job
// com.pocketbrain.update) that stopped running (over 3 hours) is a failing check, so it reaches the
// owner as an alert. A `deploy go` record (mode go) is a one-off by hand and never goes stale; its
// line carries the north star's counts, report-only (never what makes the check fail).
interface DeployFile { status?: string; detail?: string; checked_at?: string; mode?: string; unreleased_since?: string | null; north_star?: Pick<NorthStarRecord, "code" | "counts" | "error"> }
const deployState = (): DeployFile | undefined => { try { return JSON.parse(readFileSync(join(dirname(keysDir()), "deploy.json"), "utf8")); } catch { return undefined; } };
export function deployCheck(now = new Date()): Check | undefined {
  const s = deployState();
  if (!s) return undefined;
  const hours = (now.getTime() - Date.parse(s.checked_at ?? "")) / 3_600_000;
  if (s.mode !== "go" && !(hours <= 3)) return { name: "update", ok: false, detail: `auto-update last ran ${s.checked_at?.slice(0, 16) ?? "never"}, over 3h ago; is com.pocketbrain.update loaded?` };
  const ok = ["deployed", "current", "held"].includes(s.status ?? "");
  const ns = s.north_star ? `; ${northStarLine(s.north_star).replace(/ \(real brain, code \w+\):/, "")}` : "";
  return { name: "update", ok, detail: `${s.mode === "go" ? "deploy go" : "auto-update"} ${s.status}: ${s.detail ?? ""}${ns}`.trim() };
}

// The checks failing right now (log/probe.json), for the digest and the real-use bar. A probe
// file that can't be read is itself failing: "nothing failing" must mean the probe said so.
export function failingChecks(root: string): { name: string; detail: string; since: string }[] {
  const file = join(root, "log", "probe.json");
  if (!existsSync(file)) return [];
  try { return Object.entries(JSON.parse(readFileSync(file, "utf8")) as State).filter(([, v]) => !v.ok).map(([name, v]) => ({ name, detail: v.detail, since: v.since })); }
  catch { return [{ name: "probe", detail: "log/probe.json can't be read; the next probe run rewrites it", since: statSync(file).mtime.toISOString() }]; }
}
export const failingNow = (root: string): string[] => failingChecks(root).map((c) => c.name);

export async function probeOnce(root: string, localUrl: string, f: Fetch = fetch): Promise<Check[]> {
  const t0 = Date.now();
  try {
    const fresh = record(root, [...await runChecks(root, localUrl, f), ...jobChecks(root)]);
    beat(root, "probe", { ok: true, ms: Date.now() - t0 });
    return fresh;
  } catch (e) { beat(root, "probe", { ok: false, error: (e as Error).message, ms: Date.now() - t0 }); throw e; }
}

// The north star on the real brain after every deploy (audit v4: `--brain` only ran with an env var
// set). Once per code version: a start on new code runs scripts/north-star.ts --brain --json in the
// background and keeps its counts in log/north-star.json. Report-only: no alert, nothing asked; the
// Mac's `bun scripts/deploy.ts go` runs it first (northStarFor), so the hub's own run then finds the
// record for its code and skips. Returns the record when it ran.
export interface NorthStarRecord { code: string; at: string; exit: number; counts?: Record<string, unknown>; error?: string }
type Spawn = (cmd: string[]) => Promise<{ exit: number; out: string; err: string }>;
const spawnAsync: Spawn = async (cmd) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { exit, out, err };
};
const CODE_DIR = join(import.meta.dir, "..");
export { codeVersion };
export async function northStarAfterStart(root: string, o: { code?: string; spawn?: Spawn; now?: Date } = {}): Promise<NorthStarRecord | undefined> {
  const code = o.code ?? codeAtStart();
  if (!code) return undefined;
  const file = join(root, "log", "north-star.json");
  try { if ((JSON.parse(readFileSync(file, "utf8")) as NorthStarRecord).code === code) return undefined; } catch { /* none yet */ }
  const r = await (o.spawn ?? spawnAsync)(["bun", join(CODE_DIR, "scripts", "north-star.ts"), "--brain", root, "--json"]);
  let counts: Record<string, unknown> | undefined;
  try { counts = JSON.parse(r.out.trim().split("\n").at(-1) ?? ""); } catch { /* no line: kept as an error */ }
  const rec: NorthStarRecord = { code, at: (o.now ?? new Date()).toISOString(), exit: r.exit, ...(counts ? { counts } : { error: (r.err.trim().split("\n").at(-1) ?? "no output").slice(0, 200) }) };
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(rec) + "\n");
  renameSync(file + ".tmp", file);
  return rec;
}

// The record for this code: run once, or the one already kept (deploy go reports it either way).
export async function northStarFor(root: string, code: string, o: { spawn?: Spawn; now?: Date } = {}): Promise<NorthStarRecord | undefined> {
  const ran = await northStarAfterStart(root, { ...o, code });
  if (ran) return ran;
  try { const r = JSON.parse(readFileSync(join(root, "log", "north-star.json"), "utf8")) as NorthStarRecord; return r.code === code ? r : undefined; } catch { return undefined; }
}
// One line of counts, never a page name: the hub log, deploy go's output and the update check.
export function northStarLine(r: Pick<NorthStarRecord, "code" | "counts" | "error">): string {
  const c = r.counts;
  if (!c) return `north star (real brain, code ${r.code.slice(0, 7)}): didn't run: ${r.error ?? "no counts"}`;
  const pages = typeof c.pages === "number" ? `, ${c.pages_ok}/${c.pages} pages ok` : "";
  return `north star (real brain, code ${r.code.slice(0, 7)}): ${c.pass ? "PASS" : "FAIL"}, ${c.asks} asks, ${c.not_conflict} not about a contradiction, ${c.home_asks} on the home${pages}`;
}
