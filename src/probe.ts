// SPDX-License-Identifier: AGPL-3.0-only
// Health probe, run by `start` every couple of hours: the things that broke silently before
// (tunnel down, the MCP door answering in a way Town turns into an OAuth flow, the OAuth door
// gone). Each check is ok or failing; a check that turns from ok to failing raises one alert
// (log/alerts.jsonl, so the digest, dashboard and text channel surface it), and one that
// recovers is noted in log/probe.json. No new outward channel.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadHub } from "./hub";
import { alert, readJsonl, appendJsonl } from "./util";
import { loadBackupConfig, lastBackup, due } from "./backup";
import { modelConfigFor, KEY_ENV } from "./model";
import { keysDir } from "./secrets";
import { silentSources } from "./fill";
import { loadBrain } from "./brain";
import { loadRules, gardeners, type Rules } from "./rules";
import { carve, grantFor } from "./carve";
import { buildIndex, rank, terms } from "./retrieve";
import { missedWindows, nightMode, gardenerConfig } from "./gardener";
import { freeDiskMb } from "./textline/items";

// warn: an early warning (alert check probe_warn_<name>): it reaches the owner like any alert but
// isn't a hub failure, so it doesn't break the real-use streak (src/measure.ts).
export interface Check { name: string; ok: boolean; detail: string; warn?: boolean }
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

async function get(f: Fetch, url: string, init: RequestInit = {}): Promise<Response | undefined> {
  try { return await f(url, { redirect: "manual", signal: AbortSignal.timeout(8000), ...init }); } catch { return undefined; }
}

export async function runChecks(root: string, localUrl: string, f: Fetch = fetch): Promise<Check[]> {
  const out: Check[] = [];
  const local = await get(f, `${localUrl}/health`);
  out.push({ name: "local", ok: local?.status === 200, detail: local ? `hub /health answered ${local.status}` : "hub /health did not answer" });
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
  const prev: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
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
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
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
  // night and digest are daily; searchable and housekeeping run after night; pull every few minutes.
  for (const job of ["night", "digest", "searchable", "housekeeping", "pull"]) {
    if (!s[job] && !s[`${job}_at`] && !s[`${job}_error`]) continue;
    const at = s[`${job}_at`] ?? `${s[job]}T12:00:00Z`;
    const hours = (now.getTime() - Date.parse(at)) / 3_600_000;
    out.push(s[`${job}_error`] ? { name: job, ok: false, detail: `${job} failed: ${s[`${job}_error`]}` }
      : hours > STALE_HOURS ? { name: job, ok: false, detail: `${job} last ran ${at.slice(0, 16)}, over ${STALE_HOURS}h ago; is the hub running start?` }
      : { name: job, ok: true, detail: `${job} ran ${at.slice(0, 16)}` });
  }
  // The gardener's Anthropic jobs (start.ts tendOnce): only a failure or a success is known, no schedule to be late on.
  for (const job of ["gardener_jobs", "gardener_cleanup", "gardener_rotate"]) {
    if (s[`${job}_error`]) out.push({ name: job, ok: false, detail: `${job} failed: ${s[`${job}_error`]}` });
    else if (s[`${job}_at`] && job !== "gardener_jobs") out.push({ name: job, ok: true, detail: `${job} ran ${s[`${job}_at`].slice(0, 16)}` });
  }
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
  // has been watched that long.
  const quiet = silentSources(root, now);
  if (quiet?.watched.length) out.push(quiet.silent.length
    ? { name: "fill", ok: false, detail: `no proposal and nothing re-confirmed from ${quiet.silent.map((x) => `${x.source} for ${x.hours}h (${x.last ? `last ${x.last}` : "never"})`).join(", ")}; a pull that stopped looks like a quiet week. Run pocketbrain sources pull <name> and pocketbrain fill; a channel quiet by nature takes silent_after_hours in rules/sources.yaml` }
    : { name: "fill", ok: true, detail: `${quiet.watched.length} source(s) producing` });
  const d = deployCheck(now);
  if (d) out.push(d);
  out.push(...selfChecks(root, now));
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
  const starts = readJsonl<{ at?: string }>(join(logDir, "starts.jsonl"));
  if (starts.length) {
    const recent = starts.filter((s) => s.at && hoursSince(s.at) <= RESTART_HOURS).length;
    out.push(recent >= RESTARTS
      ? { name: "restarts", ok: false, detail: `the hub started ${recent} times in ${RESTART_HOURS}h; it may be crashing and restarting (see ~/Library/Logs or the start log)` }
      : { name: "restarts", ok: true, detail: `${recent} start(s) in ${RESTART_HOURS}h` });
  }
  const d = deployState();
  if (d && "unreleased_since" in d) out.push(d.unreleased_since && hoursSince(d.unreleased_since) > UNRELEASED_DAYS * 24
    ? { name: "release", ok: false, warn: true, detail: `main has changes not on the release branch since ${d.unreleased_since.slice(0, 10)}, over ${UNRELEASED_DAYS} days; the Mac runs an old version until a release is cut` }
    : { name: "release", ok: true, detail: d.unreleased_since ? `unreleased changes since ${d.unreleased_since.slice(0, 10)}` : "release branch is level with main" });
  return out;
}

// Each `start` leaves a line, so a hub that keeps crashing and coming back shows as a loop.
export function recordStart(root: string, now = new Date()) { appendJsonl(join(root, "log", "starts.jsonl"), { at: now.toISOString(), pid: process.pid }); }

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
  const notes = loadBrain(root);
  for (const n of notes) if (n.path !== `${n.fm.id}.md`) out.push(`${n.path}: its id is ${n.fm.id}, so reads by id miss it`);
  const rules = loadRules(root);
  for (const [agent, a] of Object.entries(rules.policy.agents)) {
    if (a.inside_wall || a.status === "paused") continue;
    const res = carve(notes, rules, grantFor(rules, agent));
    const idx = buildIndex(res, rules);
    const indexed = new Set(idx.docs.map((d) => d.id));
    for (const id of res.visible.keys()) {
      const title = res.visible.get(id)!.note.fm.title ?? "";
      if (!indexed.has(id)) out.push(`${id}: in ${agent}'s view but not in its search index`);
      else if (terms(title).length && !rank(idx, title, 50, { synonyms: false }).some((h) => h.id === id)) out.push(`${id}: ${agent}'s search for its title doesn't find it`);
    }
  }
  return out;
}

// Auto-update (scripts/deploy.ts, the launchd job com.pocketbrain.update) leaves deploy.json in the
// config folder. Only checked once it exists: a rollback, a block, a fetch that keeps failing, or a
// pass that stopped running (over 3 hours) is a failing check, so it reaches the owner as an alert.
interface DeployFile { status?: string; detail?: string; checked_at?: string; unreleased_since?: string | null }
const deployState = (): DeployFile | undefined => { try { return JSON.parse(readFileSync(join(dirname(keysDir()), "deploy.json"), "utf8")); } catch { return undefined; } };
export function deployCheck(now = new Date()): Check | undefined {
  const s = deployState();
  if (!s) return undefined;
  const hours = (now.getTime() - Date.parse(s.checked_at ?? "")) / 3_600_000;
  if (!(hours <= 3)) return { name: "update", ok: false, detail: `auto-update last ran ${s.checked_at?.slice(0, 16) ?? "never"}, over 3h ago; is com.pocketbrain.update loaded?` };
  const ok = ["deployed", "current", "held"].includes(s.status ?? "");
  return { name: "update", ok, detail: `auto-update ${s.status}: ${s.detail ?? ""}`.trim() };
}

// The checks failing right now (log/probe.json), for the digest and the real-use bar.
export function failingChecks(root: string): { name: string; detail: string; since: string }[] {
  try { return Object.entries(JSON.parse(readFileSync(join(root, "log", "probe.json"), "utf8")) as State).filter(([, v]) => !v.ok).map(([name, v]) => ({ name, detail: v.detail, since: v.since })); } catch { return []; }
}
export const failingNow = (root: string): string[] => failingChecks(root).map((c) => c.name);

export async function probeOnce(root: string, localUrl: string, f: Fetch = fetch): Promise<Check[]> {
  return record(root, [...await runChecks(root, localUrl, f), ...jobChecks(root)]);
}
