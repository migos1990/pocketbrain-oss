// SPDX-License-Identifier: AGPL-3.0-only
// The gardener (docs/gardener.md): an outside agent, flagged `role: gardener` in policy.yaml, that
// reads the whole brain and only proposes. What the hub enforces around it, all in code:
//   - its hours: `windows` on the agent. A token used outside them is refused with a plain 401,
//     the agent is paused (a commit by hub) and the owner gets a Needs-you item. `gardener open`
//     lets one manual run through.
//   - the proposal cap: `max_proposals_per_day` inbox proposals in 24 hours (write.ts asks here).
//   - its run record (log/gardener.jsonl): every upkeep_run, sleep_run, cleanup and rotation.
//   - `night: managed`: the hub's own nightly pass steps in only when the gardener has been silent
//     36 hours; journal consolidation stays on the hub, since journals never leave it.
//   - the Anthropic side, through the `ant` CLI signed in under its own profile: deleting ended
//     sessions (each holds a copy of what the gardener read) and rotating its token in the vault.
//     pocketBrain stores no Anthropic key; the token goes to `ant` on stdin only.
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { loadRules, readYaml, gardeners, type Rules } from "./rules";
import { loadHub } from "./hub";
import { git } from "./git";
import { alert, readJsonl, appendJsonl, sha256 } from "./util";
import { issueToken, retainTokens, tokenInfo } from "./auth";
import { spendRotateCode } from "./invite";
import { gitSide } from "./quotes";

export const SILENT_HOURS = 36;
// The hub's clock and the owner's timezone live in src/clock.ts (one clock for every per-day rule).
import { clock, timezoneOf } from "./clock";
export { clock, timezoneOf };

const runLog = (root: string) => join(root, "log", "gardener.jsonl");
export interface RunEntry { at: string; agent: string; op: "upkeep_run" | "sleep_run" | "cleanup" | "rotate"; run?: string; [k: string]: unknown }
export function recordRun(root: string, e: Omit<RunEntry, "at">) { appendJsonl(runLog(root), { at: clock().toISOString(), ...e }); }
export const runs = (root: string) => readJsonl<RunEntry>(runLog(root));

// ---------- hours ----------

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export interface Window { days: number[]; from: number; to: number }

// "daily 03:25-05:00", "sun 09:55-12:00", "mon-fri 08:00-09:00", "sat,sun 10:00-11:00".
// A window whose end is before its start runs past midnight.
export function parseWindow(s: string): Window | undefined {
  const m = s.trim().toLowerCase().match(/^([a-z,-]+)\s+(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return undefined;
  const days = new Set<number>();
  for (const part of m[1].split(",")) {
    if (part === "daily") DAYS.forEach((_, i) => days.add(i));
    else if (part === "weekdays") [1, 2, 3, 4, 5].forEach((i) => days.add(i));
    else if (part === "weekends") [0, 6].forEach((i) => days.add(i));
    else {
      const [a, b] = part.split("-").map((d) => DAYS.indexOf(d.slice(0, 3)));
      if (a < 0 || (b !== undefined && b < 0)) return undefined;
      for (let i = a; ; i = (i + 1) % 7) { days.add(i); if (b === undefined || i === b) break; }
    }
  }
  const from = Number(m[2]) * 60 + Number(m[3]), to = Number(m[4]) * 60 + Number(m[5]);
  if (from >= 24 * 60 || to > 24 * 60) return undefined;
  return { days: [...days].sort(), from, to };
}

export function localTime(now: Date, tz: string): { dow: number; minutes: number; label: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  return {
    dow: DAYS.indexOf(String(parts.weekday).toLowerCase().slice(0, 3)),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    label: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${tz})`,
  };
}

export function inWindows(windows: string[], now: Date, tz: string): boolean {
  const t = localTime(now, tz);
  return windows.map(parseWindow).some((w) => !!w && (w.from <= w.to
    ? w.days.includes(t.dow) && t.minutes >= w.from && t.minutes < w.to
    : (w.days.includes(t.dow) && t.minutes >= w.from) || (w.days.includes((t.dow + 6) % 7) && t.minutes < w.to)));
}

// The latest occurrence of window `w` that ended before `now`, found by walking back in 5-minute
// steps over 8 days (so a weekly window is found too). Precise to the step, which is enough.
const STEP = 5 * 60_000, LOOKBACK = 8 * 86_400_000;
export function lastEnded(w: string, now: Date, tz: string): { start: Date; end: Date } | undefined {
  const inside = (ms: number) => inWindows([w], new Date(ms), tz);
  const floor = now.getTime() - LOOKBACK;
  let t = now.getTime();
  while (t > floor && inside(t)) t -= STEP; // the occurrence still open now hasn't ended
  while (t > floor && !inside(t)) t -= STEP;
  if (t <= floor) return undefined;
  const end = t + STEP;
  while (t - STEP > floor && inside(t - STEP)) t -= STEP;
  return { start: new Date(t), end: new Date(end) };
}

// Each of the agent's windows whose latest ended occurrence shows no call from it, as
// "<window> on <local date>". Undefined when it has no hours or never connected (nothing set up yet).
export function missedWindows(root: string, rules: Rules, agent: string, now = clock()): string[] | undefined {
  const windows = rules.policy.agents[agent]?.windows ?? [];
  if (!windows.length) return undefined;
  const since = new Date(now.getTime() - LOOKBACK - 86_400_000).toISOString();
  const all = readJsonl<{ at: string; agent: string }>(join(root, "log", "reads.jsonl")).filter((e) => e.agent === agent);
  if (!all.length) return undefined;
  const ats = all.filter((e) => e.at >= since).map((e) => Date.parse(e.at));
  const tz = timezoneOf(rules);
  return windows.flatMap((w) => {
    const occ = lastEnded(w, now, tz);
    if (!occ || ats.some((t) => t >= occ.start.getTime() - STEP && t <= occ.end.getTime() + 2 * STEP)) return [];
    return [`${w} on ${localTime(occ.start, tz).label.slice(0, 10)}`];
  });
}

const openLog = (root: string) => join(root, "log", "gardener-open.jsonl");

// `pocketbrain gardener open [minutes]`: the owner lets a manual run through.
export function openWindow(root: string, agent: string, minutes = 60, now = clock()): string {
  const a = loadRules(root).policy.agents[agent];
  if (!a || a.inside_wall) throw new Error(`${agent} isn't an outside agent in policy.yaml`);
  if (!(minutes > 0 && minutes <= 24 * 60)) throw new Error("minutes is 1 to 1440");
  const until = new Date(now.getTime() + minutes * 60_000);
  appendJsonl(openLog(root), { at: now.toISOString(), agent, until: until.toISOString() });
  return `${agent} may connect until ${until.toISOString().slice(0, 16)}Z (${minutes} min)${a.windows?.length ? "" : "; it has no hours set, so it may connect any time anyway"}`;
}

// The end of the latest owner-opened window covering now, if any (ISO), so orientation can say so.
export function openUntil(root: string, agent: string, now = clock()): string | undefined {
  const t = now.toISOString();
  return readJsonl<{ agent: string; at: string; until: string }>(openLog(root))
    .filter((o) => o.agent === agent && o.at <= t && t < o.until).map((o) => o.until).sort().pop();
}

export function withinHours(root: string, rules: Rules, agent: string, now = clock()): boolean {
  const w = rules.policy.agents[agent]?.windows;
  if (!w?.length) return true;
  if (inWindows(w, now, timezoneOf(rules))) return true;
  return !!openUntil(root, agent, now);
}

// Called by the server right after a token checks out, before anything is read. True means:
// refuse with a plain 401. The agent is now paused and the owner has a Needs-you item.
export function hoursTripwire(root: string, agent: string, now = clock()): boolean {
  const rules = loadRules(root);
  const a = rules.policy.agents[agent];
  if (!a?.windows?.length || a.status === "paused" || withinHours(root, rules, agent, now)) return false;
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["agents", agent, "status"], "paused");
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  git(root, ["add", "rules/policy.yaml"]);
  git(root, ["commit", "-q", "-m", `hub: ${agent} paused (tripwire: token used outside its hours)\n\nKind: tripwire`, "--", "rules/policy.yaml"], "hub");
  const when = localTime(now, timezoneOf(rules)).label;
  alert(root, { agent, check: "gardener_hours", from: when, detail: `The ${agent}'s token was used at ${when}, outside its hours. Paused. If that was you running it by hand, unpause it in the dashboard; otherwise revoke it: \`pocketbrain token --revoke ${agent}\`.` });
  return true;
}

// ---------- the proposal cap ----------

export function proposalsLastDay(root: string, agent: string, now = clock()): number {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  return readJsonl<{ at: string; agent: string; outcome: string }>(join(root, "log", "writes.jsonl")).filter((w) => w.agent === agent && w.outcome === "inbox" && w.at >= since).length;
}

// The refusal when the agent's next proposal would pass its cap, else undefined.
export function proposalCap(root: string, rules: Rules, agent: string): string | undefined {
  const cap = rules.policy.agents[agent]?.max_proposals_per_day;
  if (cap === undefined || cap === null) return undefined;
  return proposalsLastDay(root, agent) >= cap ? `proposal cap reached (${cap} a day); try again tomorrow` : undefined;
}

// ---------- night: local | managed ----------

export function nightMode(root: string): "local" | "managed" {
  return (loadHub(root)?.night ?? loadRules(root).policy.night) === "managed" ? "managed" : "local";
}

// When any gardener last ran upkeep, if ever.
export function lastUpkeep(root: string): RunEntry | undefined {
  const g = new Set(gardeners(loadRules(root)));
  return runs(root).filter((e) => e.op === "upkeep_run" && g.has(e.agent)).at(-1);
}

// What tonight's pass on the hub does: everything (local, or the gardener silent 36h+), or only
// the journal consolidation (the gardener ran upkeep and forgetting itself).
export function nightPlan(root: string, now = clock()): { full: boolean; why: string } {
  if (nightMode(root) === "local") return { full: true, why: "night: local" };
  const last = lastUpkeep(root);
  if (!last || now.getTime() - Date.parse(last.at) > SILENT_HOURS * 3_600_000) return { full: true, why: `night: gardener silent ${SILENT_HOURS}h+, ran locally` };
  return { full: false, why: `night: gardener ran ${last.at.slice(0, 16)}Z; journals only` };
}

// ---------- the Anthropic side (rules/gardener.yaml, the ant CLI) ----------

export interface GardenerConfig {
  ant_profile: string;
  lock_file: string;       // `ant apply`'s lock file: the vault and deployment ids
  delete_sessions: boolean;
  rotate_days: number;
  mcp_url?: string;        // the door the vault credential is for (default: hub.yaml public_url + /mcp)
  agent?: string;          // which gardener (default: the only one)
  ant?: string;            // the ant binary (default: ant on PATH)
}

export function gardenerConfig(root: string): GardenerConfig | undefined {
  const f = join(root, "rules", "gardener.yaml");
  if (!existsSync(f)) return undefined;
  const c = readYaml<Partial<GardenerConfig>>(f, {});
  return { ant_profile: c.ant_profile || "pocketbrain", lock_file: c.lock_file || "~/pocketbrain-agents/claude-lock.json", delete_sessions: c.delete_sessions !== false, rotate_days: Number(c.rotate_days ?? 7), mcp_url: c.mcp_url, agent: c.agent, ant: c.ant };
}

const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export interface AntRun { code: number; out: string; err: string }

// Every ant call runs without ANTHROPIC_API_KEY, which would otherwise override the profile and
// send the call to whatever workspace that key belongs to. stdin carries anything secret. It runs
// in the lock file's folder, where `ant apply` reads its files and writes the lock.
export function ant(cfg: GardenerConfig, args: string[], stdin?: string): AntRun {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const dir = dirname(expandHome(cfg.lock_file));
  try {
    const r = Bun.spawnSync([cfg.ant || "ant", "--profile", cfg.ant_profile, ...args], { env, cwd: existsSync(dir) ? dir : undefined, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), timeout: 60_000 });
    return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
  } catch (e) { return { code: 127, out: "", err: (e as Error).message }; }
}

export function lockIds(cfg: GardenerConfig): { vault?: string; deployments: string[] } | undefined {
  const f = expandHome(cfg.lock_file);
  if (!existsSync(f)) return undefined;
  const res = (JSON.parse(readFileSync(f, "utf8")).resources ?? {}) as Record<string, { id?: string }>;
  const ids = (re: RegExp) => Object.entries(res).filter(([k, v]) => re.test(k) && v?.id).map(([, v]) => v.id!);
  return { vault: ids(/vault[^/]*\.ya?ml$/)[0], deployments: ids(/deployment[^/]*\.ya?ml$/) };
}

export const jsonLines = (s: string): Record<string, unknown>[] => {
  const t = s.trim();
  if (!t) return [];
  if (t.startsWith("[")) { try { return JSON.parse(t); } catch { return []; } }
  const out: Record<string, unknown>[] = [];
  for (const l of t.split("\n")) { try { out.push(JSON.parse(l)); } catch { /* not JSON */ } }
  const data = out.length === 1 && Array.isArray((out[0] as { data?: unknown }).data) ? (out[0] as { data: Record<string, unknown>[] }).data : undefined;
  return data ?? out;
};

function gardenerAgent(root: string, cfg: GardenerConfig): string {
  const g = gardeners(loadRules(root));
  const name = cfg.agent ?? (g.length === 1 ? g[0] : undefined);
  if (!name || !g.includes(name)) throw new Error(g.length ? `several gardeners (${g.join(", ")}): set agent: in rules/gardener.yaml` : "no agent has role: gardener in policy.yaml");
  return name;
}

// The CLI signed in? A missing CLI or an expired profile becomes a Needs-you item, never silence.
function antReady(root: string, cfg: GardenerConfig, job: string): string | undefined {
  const s = ant(cfg, ["auth", "status"]);
  if (s.code === 0) return undefined;
  const why = s.code === 127 ? "the ant CLI isn't installed on the hub (brew install anthropics/tap/ant)" : `sign the ant CLI in again: \`ant auth login --profile ${cfg.ant_profile}\``;
  alert(root, { agent: "gardener", check: "gardener_ant", from: job, detail: `gardener ${job} didn't run: ${why}` });
  return why;
}

// `pocketbrain gardener cleanup`: delete the gardener's ended sessions older than an hour. Each
// session holds a copy of what it read; the deployment's run records stay. ok is false when it
// couldn't run (no deployments, ant missing or signed out, failed calls), so the hub's job check
// fails instead of counting a cleanup that never happened.
export function cleanup(root: string, now = clock()): { ok: boolean; message: string } {
  const cfg = gardenerConfig(root);
  if (!cfg) return { ok: true, message: "gardener cleanup: no rules/gardener.yaml" };
  if (!cfg.delete_sessions) return { ok: true, message: "gardener cleanup: off (delete_sessions: false)" };
  const ids = lockIds(cfg);
  if (!ids?.deployments.length) {
    alert(root, { agent: "gardener", check: "gardener_ant", from: "cleanup", detail: `gardener cleanup didn't run: no deployments in ${cfg.lock_file}` });
    return { ok: false, message: `gardener cleanup: no deployments in ${cfg.lock_file}` };
  }
  const notReady = antReady(root, cfg, "cleanup");
  if (notReady) return { ok: false, message: `gardener cleanup: ${notReady}` };
  let deleted = 0, failed = 0;
  const seen = new Set<string>();
  for (const dep of ids.deployments) {
    const list = ant(cfg, ["beta:deployment-runs", "list", "--deployment-id", dep, "--format", "jsonl"]);
    if (list.code !== 0) { failed++; continue; }
    for (const r of jsonLines(list.out)) {
      const sid = String((r.session_id ?? (r.session as { id?: string } | undefined)?.id) ?? "");
      if (!/^[A-Za-z0-9_-]+$/.test(sid) || seen.has(sid)) continue;
      seen.add(sid);
      const got = ant(cfg, ["beta:sessions", "retrieve", "--session-id", sid, "--format", "json"]);
      if (got.code !== 0) continue; // already gone
      const s = jsonLines(got.out)[0] ?? {};
      const stop = s.stop_reason as { type?: string } | string | undefined;
      const ended = s.status === "terminated" || (s.status === "idle" && (typeof stop === "string" ? stop : stop?.type) === "end_turn");
      const at = Date.parse(String(s.ended_at ?? s.updated_at ?? s.created_at ?? ""));
      if (!ended || !Number.isFinite(at) || now.getTime() - at < 3_600_000) continue;
      if (ant(cfg, ["beta:sessions", "delete", "--session-id", sid]).code === 0) deleted++; else failed++;
    }
  }
  recordRun(root, { agent: gardenerAgentOr(root, cfg), op: "cleanup", deleted, failed });
  if (failed) alert(root, { agent: "gardener", check: "gardener_ant", from: "cleanup", detail: `gardener cleanup: ${failed} call(s) to ant failed; sessions may still hold copies of the brain` });
  return { ok: !failed, message: `gardener cleanup: ${deleted} session(s) deleted${failed ? `, ${failed} failed` : ""}` };
}

function gardenerAgentOr(root: string, cfg: GardenerConfig): string {
  try { return gardenerAgent(root, cfg); } catch { return "gardener"; }
}

// G240: the ant binary a rotation hands the gardener's token to, as one absolute file and its
// sha256. The owner pins it with a rotation made with their one-time code (or the hub's first
// scheduled rotation pins it); the pin lives outside git (.git/pb-gardener-ant.json).
interface AntPin { path: string; sha: string }
export function antBinary(cfg: GardenerConfig): AntPin | undefined {
  const name = cfg.ant || "ant";
  const found = name.includes("/") ? (isAbsolute(expandHome(name)) ? expandHome(name) : undefined) : Bun.which(name, { PATH: process.env.PATH ?? "" }) ?? undefined;
  if (!found || !existsSync(found)) return undefined;
  const path = realpathSync(found);
  return { path, sha: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
const pinFile = (root: string) => gitSide(root, "pb-gardener-ant.json");
function antPin(root: string): AntPin | undefined {
  try { const p = JSON.parse(readFileSync(pinFile(root), "utf8")); return typeof p?.path === "string" && typeof p?.sha === "string" ? p : undefined; } catch { return undefined; }
}
const savePin = (root: string, p: AntPin) => writeFileSync(pinFile(root), JSON.stringify(p), { mode: 0o600 });

// `pocketbrain gardener rotate`: a new token, into the vault's credential for the door on stdin
// (made if the vault has none), every older token revoked. If the vault doesn't take the new one, the new token is
// revoked and the old one keeps working. G240: any program with a shell can run it, and the token
// goes to whatever `ant` it finds, so from a terminal it needs the owner's one-time code (made on
// the gardener's dashboard page, for rotation only), which also pins that ant. The hub's weekly
// rotation (`scheduled`) sends the token only to the pinned ant; another file is refused with an
// alert. Every rotation is a token_minted alert naming the ant.
export function rotate(root: string, o: { code?: string; scheduled?: boolean } = {}): { ok: boolean; message: string } {
  const cfg0 = gardenerConfig(root);
  if (!cfg0) return { ok: false, message: "gardener rotate: no rules/gardener.yaml" };
  const agent = gardenerAgent(root, cfg0);
  if (!o.scheduled && o.code === undefined) return { ok: false, message: `gardener rotate: from a terminal this needs your yes. On the dashboard, open ${agent}'s page and press "Rotation code", then run: pocketbrain gardener rotate --code <code>` };
  const url = cfg0.mcp_url ?? (loadHub(root)?.public_url ? `${loadHub(root)!.public_url!.replace(/\/+$/, "")}/mcp` : undefined);
  if (!url) return { ok: false, message: "gardener rotate: set mcp_url in rules/gardener.yaml (or public_url in hub.yaml)" };
  const vault = lockIds(cfg0)?.vault;
  if (!vault) return { ok: false, message: `gardener rotate: no vault in ${cfg0.lock_file}` };
  const bin = antBinary(cfg0);
  if (!bin) return fail(root, `ant (${cfg0.ant || "ant"}) isn't an installed file; give its absolute path as ant: in rules/gardener.yaml`);
  const cfg = { ...cfg0, ant: bin.path };
  const pin = antPin(root);
  if (o.code !== undefined) {
    const bad = spendRotateCode(root, o.code, agent);
    if (bad) return { ok: false, message: `gardener rotate: ${bad} (a rotation code is made on ${agent}'s dashboard page and works once)` };
    savePin(root, bin);
  } else if (!pin) {
    savePin(root, bin);
    // A record, not a problem (alertOpen's INFO): the owner's home page counted it (2026-10-25).
    alert(root, { agent, check: "gardener_ant_pinned", from: "rotate", detail: `gardener rotate: pinned ${bin.path} (sha256 ${bin.sha.slice(0, 12)}) as the ant that gets the gardener's token; from now on another one is refused` });
  } else if (pin.path !== bin.path || pin.sha !== bin.sha) {
    return fail(root, `ant changed since you last approved it (was ${pin.path}, sha256 ${pin.sha.slice(0, 12)}; now ${bin.path}, sha256 ${bin.sha.slice(0, 12)}), so no token was sent. If you updated ant yourself, open ${agent}'s dashboard page, press "Rotation code", then run: pocketbrain gardener rotate --code <code>`);
  }
  const notReady = antReady(root, cfg, "rotate");
  if (notReady) return { ok: false, message: `gardener rotate: ${notReady}` };
  const listed = ant(cfg, ["beta:vaults:credentials", "list", "--vault-id", vault, "--format", "jsonl"]);
  if (listed.code !== 0) return fail(root, `couldn't list the vault's credentials (${listed.err.slice(0, 200)}); nothing changed`);
  // A vault holds one active credential per MCP server URL (a second create is a 409), matched as
  // the vault matches it: scheme and host lowercased, default port and trailing slash dropped (G413).
  const old = jsonLines(listed.out).filter((c) => !c.archived_at && sameMcpUrl((c.auth as { mcp_server_url?: string } | undefined)?.mcp_server_url, url)).map((c) => String(c.id));

  const token = issueToken(root, agent);
  const mine = sha256(token);
  // The door's credential, if the vault has one, takes the new token in place; otherwise one is made.
  const [keep, ...extra] = old;
  const made = keep
    ? ant(cfg, ["beta:vaults:credentials", "update", "--vault-id", vault, "--credential-id", keep, "--transform", "id", "-r"], JSON.stringify({ auth: { type: "static_bearer", token } }))
    : ant(cfg, ["beta:vaults:credentials", "create", "--vault-id", vault, "--transform", "id", "-r"],
      JSON.stringify({ display_name: `pocketBrain ${agent}`, auth: { type: "static_bearer", mcp_server_url: url, token } }));
  const id = made.out.trim().split("\n").at(-1)?.replace(/^"|"$/g, "") ?? "";
  if (made.code !== 0 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    retainTokens(root, agent, (h) => h !== mine);
    return fail(root, `the vault didn't take the new token (${made.err.replaceAll(token, "[token]").replace(/pb_[A-Za-z0-9-]+_[A-Za-z0-9_-]{8,}/g, "[token]").slice(0, 200)}); new token revoked, the old one still works`);
  }
  // Only a key the vault took is news: one it refused was revoked above (a failing daily retry
  // raised a token_minted each time, 2026-10-25).
  alert(root, { agent, check: "token_minted", from: `gardener rotate${o.code !== undefined ? " with your one-time code" : " (the hub's weekly rotation)"} sent the gardener's new token to ${bin.path} (sha256 ${bin.sha.slice(0, 12)}). If that wasn't you: pocketbrain token --revoke ${agent}` });
  let archived = 0;
  const left: string[] = [];
  for (const c of extra) (ant(cfg, ["beta:vaults:credentials", "archive", "--vault-id", vault, "--credential-id", c]).code === 0 ? archived++ : left.push(c));
  const revoked = retainTokens(root, agent, (h) => h === mine);
  recordRun(root, { agent, op: "rotate", credential: id, archived, revoked });
  if (left.length) alert(root, { agent, check: "gardener_ant", from: "rotate", detail: `gardener rotate: archive ${left.join(", ")} by hand (its token is already revoked)` });
  return { ok: true, message: `gardener rotate: ${keep ? `credential ${id} has the new token` : `new credential ${id}`}; ${archived ? `${archived} old credential(s) archived, ` : ""}${revoked} old token(s) revoked` };
}

function sameMcpUrl(a: string | undefined, b: string): boolean {
  const norm = (u: string) => { try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, "")}${x.search}`; } catch { return u.replace(/\/+$/, ""); } };
  return !!a && norm(a) === norm(b);
}

function fail(root: string, why: string) {
  alert(root, { agent: "gardener", check: "gardener_ant", from: "rotate", detail: `gardener rotate: ${why}` });
  return { ok: false, message: `gardener rotate: ${why}` };
}

// The newest token's age in days, for doctor and the scheduler.
export function tokenAgeDays(root: string, agent: string, now = clock()): number | undefined {
  const dates = (tokenInfo(root)[agent] ?? []).map((t) => t.issued).sort();
  return dates.length ? Math.floor((now.getTime() - Date.parse(`${dates.at(-1)}T00:00:00Z`)) / 86_400_000) : undefined;
}

// The hub's gardener jobs, checked every minute by `start` (machine local time, like the nightly
// pass): cleanup at 05:15 daily and 12:15 on Sundays, rotation on Sundays at 13:00 once the
// token is rotate_days old.
const jobState = (root: string) => join(root, "log", "gardener-jobs.json");
export function dueGardenerJobs(root: string, now = new Date(), o: { retryRotate?: boolean } = {}): ("cleanup" | "rotate")[] {
  const cfg = gardenerConfig(root);
  if (!cfg) return [];
  let done: Record<string, string> = {};
  try { done = JSON.parse(readFileSync(jobState(root), "utf8")); } catch { /* first run */ }
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const hm = now.getHours() * 60 + now.getMinutes();
  const out: ("cleanup" | "rotate")[] = [];
  let changed = false;
  const mark = (k: string) => { done[k] = day; changed = true; };
  if (cfg.delete_sessions) {
    if (hm >= 5 * 60 + 15 && done.cleanup_am !== day) { out.push("cleanup"); mark("cleanup_am"); }
    if (now.getDay() === 0 && hm >= 12 * 60 + 15 && done.cleanup_noon !== day) { if (!out.includes("cleanup")) out.push("cleanup"); mark("cleanup_noon"); }
  }
  // A rotation that failed is tried again each day at 13:00 until one goes through, so fixing its
  // cause (mcp_url, the vault) closes the probe's gardener_rotate alert without a hand run.
  if ((now.getDay() === 0 || o.retryRotate) && hm >= 13 * 60 && done.rotate !== day) {
    const age = tokenAgeDays(root, gardenerAgentOr(root, cfg), now);
    if (o.retryRotate || age === undefined || age >= cfg.rotate_days - 1) out.push("rotate");
    mark("rotate");
  }
  if (changed) { mkdirSync(join(root, "log"), { recursive: true }); writeFileSync(jobState(root), JSON.stringify(done)); }
  return out;
}
