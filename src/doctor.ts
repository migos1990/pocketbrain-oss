// SPDX-License-Identifier: AGPL-3.0-only
// pocketbrain doctor: one screen on the state of the hub, its replicas, the public door and the
// agents' fallback snapshots. Read-only; each line is ok, warn or FAIL with what to do. A line with
// a safe, known repair names it in `fix`; `pocketbrain doctor --fix` runs them (src/doctor-fix.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { missingOwnerValues } from "./ownerset";
import { tailnetSelf, tailnetDoorChecks, tailnetSettings } from "./dashboard/tailnet";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import YAML from "yaml";
import { today } from "./brain";
import { loadRules, gardeners } from "./rules";
import { gardenerConfig, withinHours, tokenAgeDays, lastUpkeep, nightMode, SILENT_HOURS, ant, runs } from "./gardener";
import { backupFindings } from "./backup";
import { loadSources, consentGap, pullRuns } from "./pull";
import { tokenKey } from "./google";
import { keysDir } from "./secrets";
import { readJsonl } from "./util";
import { uncalled } from "./calls";
import { semanticState } from "./semantic";
import { tokenDates } from "./auth";
import { STALE_LOCK_MS } from "./git";
import { ownerError, type OwnerErrorId, type Vars } from "./owner-errors";
import { run, hasSshKeygen, hubRole, verifyNew, verifyWriteLog, signingRequired, replicaName, parseHub, AGENT_INGRESS_PATH, type HubConfig } from "./hub";
import { alertOpen } from "./textline/items";

const TOKEN_WARN_DAYS = 14;

export type Level = "ok" | "warn" | "FAIL";
export interface Finding { area: string; level: Level; text: string; id?: OwnerErrorId; fix?: string }

// A warning or a failure is always a catalog entry (src/owner-errors.ts): what happened, then its fix.
// repair: the key of a repair doctor --fix knows (src/doctor-fix.ts), when there is one.
export const finding = (area: string, level: "warn" | "FAIL", id: OwnerErrorId, vars: Vars = {}, repair?: string): Finding => ({ area, level, id, text: ownerError(id, vars), ...(repair ? { fix: repair } : {}) });

const git = (root: string, args: string[], timeoutMs?: number) => run(root, args, { timeoutMs });

// The cloudflared config named in rules/hub.yaml, and its ingress, when it's on this machine.
export type Ingress = { hostname?: string; path?: string; service?: string }[];
export function tunnelFile(cfg: HubConfig | undefined): string | undefined {
  const tf = cfg?.tunnel?.config?.replace(/^~/, process.env.HOME ?? "");
  return tf && existsSync(tf) ? tf : undefined;
}
export const tunnelIngress = (tf: string): Ingress => ((YAML.parse(readFileSync(tf, "utf8")) ?? {}).ingress ?? []) as Ingress;
// The door's hostname: public_url when set, else the first hostname the tunnel serves.
export function doorHost(cfg: HubConfig | undefined): string | undefined {
  if (cfg?.public_url) return new URL(cfg.public_url).host;
  const tf = tunnelFile(cfg);
  return tf ? tunnelIngress(tf).find((r) => r.hostname)?.hostname : undefined;
}

async function answers(url: string, ms = 4000): Promise<number | undefined> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: "manual" });
    return r.status;
  } catch { return undefined; }
}

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Hosts that tie agent configs to a vendor or a machine (portability 7.3, 7.9).
function doorKind(host: string): Finding {
  if (/\.ts\.net$/.test(host)) return finding("door", "warn", "doctor.door-funnel", { host });
  if (/\.trycloudflare\.com$/.test(host)) return finding("door", "FAIL", "doctor.door-quick", { host });
  if (/\.(fly\.dev|onrender\.com|herokuapp\.com|vercel\.app|ngrok(-free)?\.(app|io|dev)|railway\.app)$/.test(host)) return finding("door", "warn", "doctor.door-vendor", { host });
  if (/^(127\.|localhost$|\[::1\])/.test(host)) return finding("door", "warn", "doctor.door-local", { host });
  return { area: "door", level: "ok", text: `agents use ${host}` };
}

// Every non-loopback IPv4 address of this machine.
function outsideAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
}

export async function doctor(root: string, opts: { offline?: boolean } = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (area: string, level: "ok", text: string) => out.push({ area, level, text });
  const bad = (area: string, level: "warn" | "FAIL", id: OwnerErrorId, vars: Vars = {}, repair?: string) => out.push(finding(area, level, id, vars, repair));
  const role = hubRole(root);

  // A lock left by a killed git command stops every commit until someone removes it.
  try {
    const age = Date.now() - statSync(join(root, ".git", "index.lock")).mtimeMs;
    if (age > STALE_LOCK_MS) bad("git", "FAIL", "doctor.git-lock", { minutes: Math.round(age / 60_000) }, "lock");
  } catch { /* no lock */ }

  // Role and identity.
  if (role.mode === "single") add("hub", "ok", "single machine (a second machine needs pocketbrain hub init; see docs/hub.md)");
  else if (role.mode === "unnamed") bad("hub", "FAIL", "doctor.hub-unnamed", { hub: role.cfg.hub });
  else add("hub", "ok", `${role.name} is ${role.mode === "hub" ? "the hub" : `a replica; the hub is ${role.cfg.hub}`} (epoch ${role.cfg.epoch}${role.cfg.since ? `, since ${role.cfg.since}` : ""})`);
  const cfg: HubConfig | undefined = role.mode === "single" ? undefined : role.cfg;
  const me = replicaName(root);

  // Signing.
  if (cfg) {
    const key = git(root, ["config", "--get", "user.signingkey"]).out;
    const on = git(root, ["config", "--get", "commit.gpgsign"]).out === "true";
    const listed = me ? cfg.replicas[me]?.signing_key : undefined;
    if (signingRequired(cfg) && !hasSshKeygen()) bad("signing", "FAIL", "doctor.no-keygen");
    else if (!signingRequired(cfg)) bad("signing", "warn", "doctor.signing-optional");
    else if (!on || !key) bad("signing", "FAIL", "doctor.not-signing", { me: me ?? "<machine>" });
    else if (!existsSync(key.replace(/^~/, process.env.HOME ?? ""))) bad("signing", "FAIL", "doctor.key-missing", { key, me: me ?? "<machine>" });
    else if (!listed) bad("signing", "FAIL", "doctor.key-unlisted", { me: me! });
    else add("signing", "ok", `${me} signs with ${key}`);
  }

  // History and write log.
  if (cfg) {
    const v = verifyNew(root);
    if (v.problems.length) bad("history", "FAIL", "doctor.history", { n: v.problems.length, problems: v.problems.slice(0, 3).join("; ") });
    else add("history", "ok", `${v.checked} new commit(s) verified against rules/hub.yaml`);
  }
  const log = verifyWriteLog(root);
  if (log.problems.length) bad("write log", "FAIL", "doctor.write-log", { problems: log.problems.slice(0, 3).join("; ") });
  else if (log.entries) add("write log", "ok", `log/writes.jsonl chain intact (${log.entries} entries)`);

  // Ops waiting.
  const opsDir = join(root, "ops");
  const waiting: Record<string, string[]> = {};
  if (existsSync(opsDir)) for (const r of readdirSync(opsDir, { withFileTypes: true }))
    if (r.isDirectory() && r.name !== "applied") waiting[r.name] = readdirSync(join(opsDir, r.name)).filter((f) => f.endsWith(".json")).sort();
  const total = Object.values(waiting).reduce((n, l) => n + l.length, 0);
  const inbound = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/inbound/"]).out.split("\n").filter(Boolean);
  if (role.mode === "hub") {
    if (inbound.length) bad("ops", "warn", "doctor.inbound", { names: inbound.map((r) => r.split("/").pop()).join(", "), minutes: cfg!.tick_minutes ?? 5 });
    if (total) bad("ops", "warn", "doctor.ops-waiting", { n: total, list: Object.entries(waiting).filter(([, l]) => l.length).map(([k, l]) => `${k} ${l.length}`).join(", ") });
    if (!inbound.length && !total) add("ops", "ok", "no ops waiting");
  } else if (role.mode === "replica") {
    const n = waiting[me!]?.length ?? 0;
    if (!n) add("ops", "ok", "nothing queued here");
    else {
      const oldest = waiting[me!][0];
      const t = decodeTime(oldest.slice(0, 10));
      const age = t ? Math.round((Date.now() - t) / 3600000) : 0;
      if (age > 24) bad("ops", "warn", "doctor.ops-queued", { n, hub: cfg!.hub, age });
      else add("ops", "ok", `${n} write(s) queued for ${cfg!.hub}, oldest ${age}h ago; pocketbrain hub sync sends them`);
    }
  }
  // Alerts the hub raised this week that are still open: one whose check has passed since is closed
  // (src/textline/items.ts alertOpen), so it fails nothing (the Mac, 2026-10-24: "FAIL ops 12").
  const open = alertOpen(root);
  const hubAlerts = readJsonl<{ agent?: string; at?: string; check?: string; from?: string }>(join(root, "log", "alerts.jsonl")).filter((a) => a.agent === "hub" && String(a.at ?? "").slice(0, 10) >= addDays(today(), -7) && open(a));
  if (hubAlerts.length) bad("ops", "FAIL", "doctor.hub-alerts", { n: hubAlerts.length, check: hubAlerts[hubAlerts.length - 1].check ?? "", from: hubAlerts[hubAlerts.length - 1].from ?? "" });

  // Peers: who is reachable, and does anyone know a newer epoch (split brain).
  if (cfg && !opts.offline) {
    for (const [n, r] of Object.entries(cfg.replicas)) {
      if (n === me) continue;
      if (!r.git) { bad("replicas", "warn", "doctor.replica-no-git", { name: n }); continue; }
      const f = git(root, ["fetch", "-q", r.git, `+refs/heads/main:refs/pocketbrain/peers/${n}`], 15000);
      if (f.code !== 0) { if (n === cfg.hub) bad("replicas", "FAIL", "doctor.hub-down", { name: n, git: r.git }); else bad("replicas", "warn", "doctor.replica-down", { name: n, git: r.git }); continue; }
      const theirs = parseHub(git(root, ["show", `refs/pocketbrain/peers/${n}:rules/hub.yaml`]).out);
      if (theirs && theirs.epoch > cfg.epoch) bad("replicas", "FAIL", "doctor.behind", { name: n, epoch: theirs.epoch, hub: theirs.hub });
      else if (theirs && theirs.epoch === cfg.epoch && theirs.hub !== cfg.hub) bad("replicas", "FAIL", "doctor.split-brain", { name: n, theirs: theirs.hub, epoch: cfg.epoch, hub: cfg.hub });
      else {
        const behind = Number(git(root, ["rev-list", "--count", `refs/pocketbrain/peers/${n}..HEAD`]).out || 0);
        add("replicas", "ok", `${n} reachable${theirs && theirs.epoch < cfg.epoch ? ` (still on epoch ${theirs.epoch}; it steps down at its next sync)` : ""}${role.mode === "hub" && behind ? `, ${behind} commit(s) behind` : ""}`);
      }
    }
  }

  // Backups: commits not yet on origin (as of the last fetch).
  if (git(root, ["remote", "get-url", "origin"]).code === 0 && role.mode !== "replica") {
    const n = Number(git(root, ["rev-list", "--count", "origin/main..HEAD"]).out || 0);
    if (n > 50) bad("backup", "warn", "doctor.origin-behind", { n });
    else add("backup", "ok", n ? `${n} commit(s) not on origin yet` : "origin has everything");
  }

  // Encrypted backups (src/backup.ts): configured, recent, still in the folder.
  if (role.mode !== "replica") out.push(...backupFindings(root));
  // Values the owner was told to set by hand, each with the command that sets it (src/ownerset.ts).
  const hostKnown = !!doorHost(cfg);
  for (const m of missingOwnerValues(root)) bad("setup", "warn", m.id, m.vars, m.key === "public_url" ? (hostKnown ? "public-url" : undefined) : m.key === "gardener" ? "gardener-config" : undefined);

  // The live server and the public door (hub only; replicas don't serve agents).
  if (role.mode === "hub" || role.mode === "single") {
    const port = cfg?.port ?? 8787;
    if (!opts.offline) {
      const local = await answers(`http://127.0.0.1:${port}/health`);
      if (local === 200) add("server", "ok", `agent server answers on 127.0.0.1:${port}`);
      else bad("server", "warn", "doctor.server-down", { port });
    }
    if (cfg?.public_url) {
      const host = new URL(cfg.public_url).host;
      out.push(doorKind(host));
      if (!opts.offline) {
        const pub = await answers(new URL("/health", cfg.public_url).toString(), 8000);
        if (pub === 200) add("door", "ok", `${cfg.public_url}/health answers`);
        else bad("door", "FAIL", "doctor.door-down", { url: cfg.public_url, http: pub ? ` (HTTP ${pub})` : "", hub: cfg.hub });
      }
    } else if (cfg) bad("door", "warn", "doctor.door-unset", {}, hostKnown ? "public-url" : undefined);
    // cloudflared ingress: only the agent API, never the dashboard. http_status:404 is the catch-all, not a forward.
    const tf = tunnelFile(cfg);
    if (tf) {
      const ing = tunnelIngress(tf);
      const dport = String(cfg?.dashboard_port ?? 8788);
      const fix = hostKnown ? "tunnel" : undefined;
      if (ing.some((r) => r.service?.includes(`:${dport}`))) bad("door", "FAIL", "doctor.tunnel-dashboard", { file: tf, port: dport }, fix);
      else if (ing.some((r) => /^https?:\/\//.test(r.service ?? "") && !r.path)) bad("door", "warn", "doctor.tunnel-open", { file: tf }, fix);
      else add("door", "ok", `${tf} forwards only the agent API`);
      // A config written by an older version lacks newer routes (the browser door's /b): the door
      // answers, but those routes 404 until the ingress is replaced by hand.
      const api = ing.find((r) => r.path && r.service?.startsWith("http") && !r.service.includes(`:${dport}`));
      if (api && api.path !== AGENT_INGRESS_PATH) bad("door", "warn", "doctor.tunnel-old-rule", { file: tf, path: AGENT_INGRESS_PATH }, fix);
      if (ing.length && ing[ing.length - 1].service !== "http_status:404") bad("door", "warn", "doctor.tunnel-no-404", { file: tf }, fix);
    } else if (cfg?.tunnel?.config) bad("door", "warn", "doctor.tunnel-missing", { file: cfg.tunnel.config });
    // The dashboard must answer on loopback only.
    if (!opts.offline) {
      const dport = cfg?.dashboard_port ?? 8788;
      const exposed: string[] = [];
      const onTailnet: string[] = [];
      // Only the address Tailscale itself reports counts as the tailnet (100.64/10 is also CGNAT).
      const tset = tailnetSettings(root);
      const mine = tset.dashboard_tailnet ? tailnetSelf()?.address : undefined;
      for (const ip of outsideAddresses()) if ((await answers(`http://${ip}:${dport}/`, 1500)) !== undefined) (mine && ip === mine ? onTailnet : exposed).push(ip);
      if (exposed.length) bad("dashboard", "FAIL", "doctor.dashboard-exposed", { port: dport, addresses: exposed.join(", ") });
      else add("dashboard", "ok", onTailnet.length ? `port ${dport} answers on your tailnet (${onTailnet.join(", ")}, dashboard_tailnet) and nowhere else outside this machine` : `port ${dport} isn't reachable from outside this machine`);
      // The tailnet door (docs/dashboard-tailnet.md): no funnel or tunnel rule may reach it.
      { const ingTf = tf && existsSync(tf) ? ((YAML.parse(readFileSync(tf, "utf8")) ?? {}).ingress ?? []) : []; for (const f of tailnetDoorChecks({ ...tset, dashboard_port: dport }, ingTf)) f.level === "ok" ? add("dashboard", "ok", f.text) : bad("dashboard", f.level, f.id, f.vars); }
    }
  }

  // Sources (docs/sources-pull.md): the one missing step for each, then how its last pull went.
  // Only key names are checked, never their values; nothing is fetched (backlog 368).
  if (role.mode !== "replica") out.push(...sourceFindings(root));

  // Snapshots: what each live agent falls back to while the hub sleeps (7.4).
  const rules = loadRules(root);
  // act blocks loadRules dropped because they didn't validate (docs/act.md): that agent has no actions.
  for (const p of rules.actProblems ?? []) bad("act", "warn", "doctor.act", { problem: p });
  const live = Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall && a.transport !== "paste" && a.status !== "paused" && a.role !== "gardener").map(([k]) => k);
  const snapDir = join(root, "views", "snapshots");
  const dates = existsSync(snapDir) ? readdirSync(snapDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  for (const a of live) {
    const last = [...dates].reverse().find((d) => existsSync(join(snapDir, d, `${a}.md`)));
    if (!last) bad("snapshots", "warn", "doctor.snapshot-none", { agent: a });
    else {
      const age = days(last, today());
      if (age > 7) bad("snapshots", "warn", "doctor.snapshot-old", { agent: a, day: last, age });
      else add("snapshots", "ok", `${a}: snapshot from ${last}${age ? ` (${age} day${age > 1 ? "s" : ""} old)` : " (today)"}`);
    }
  }

  // A pasted token stops working 90 days after it was issued (src/auth.ts, G419). Doctor warns
  // 14 days ahead and names one that already stopped: one rotate with an overlap, no break
  // (docs/add-an-agent.md#rotating-a-token). The gardener's token has its own weekly rotation, below.
  const tokenDays = tokenDates(root), nowMs = process.env.PB_NOW ? Date.parse(process.env.PB_NOW) : Date.now();
  for (const [agent, list] of Object.entries(tokenDays)) {
    const a = Object.hasOwn(rules.policy.agents, agent) ? rules.policy.agents[agent] : undefined;
    if (!a || a.inside_wall || a.role === "gardener") continue;
    for (const r of new Set(list.map((e) => e.role ?? ""))) {
      const latest = Math.max(...list.filter((e) => (e.role ?? "") === r).map((e) => Number.isNaN(e.expires) ? 0 : e.expires));
      const left = Math.floor((latest - nowMs) / 86_400_000);
      const v = { agent, role: r ? `${r} ` : "", flag: r ? ` --role ${r}` : "" };
      if (latest <= nowMs) bad("tokens", "warn", "doctor.token-expired", { ...v, day: new Date(latest || nowMs).toISOString().slice(0, 10) });
      else if (left < TOKEN_WARN_DAYS) bad("tokens", "warn", "doctor.token-old", { ...v, days: left });
    }
  }

  // The gardener: paused or in its hours, its token's age, the ant CLI, the last cleanup.
  const gcfg = gardenerConfig(root);
  for (const g of gardeners(rules)) {
    const a = rules.policy.agents[g];
    if (a.status === "paused") bad("gardener", "warn", "doctor.gardener-paused", { agent: g, why: readJsonl<{ check?: string; agent?: string }>(join(root, "log", "alerts.jsonl")).some((x) => x.check === "gardener_hours" && x.agent === g) ? " (its token was used outside its hours; see Needs you)" : "" });
    else add("gardener", "ok", `${g} is ${a.windows?.length ? (withinHours(root, rules, g) ? "inside its hours now" : `outside its hours now (${a.windows.join(", ")})`) : "allowed at any hour (no windows set)"}`);
    const age = tokenAgeDays(root, g);
    const limit = (gcfg?.rotate_days ?? 7) + 1;
    if (age === undefined) bad("gardener", "warn", "doctor.gardener-no-token", { agent: g });
    else if (age > limit) bad("gardener", "warn", "doctor.gardener-token-old", { agent: g, age });
    else add("gardener", "ok", `${g}'s token is ${age} day(s) old`);
    const last = lastUpkeep(root);
    if (nightMode(root) === "managed") {
      if (!last) bad("gardener", "warn", "doctor.gardener-never");
      else if (Date.now() - Date.parse(last.at) > SILENT_HOURS * 3_600_000) bad("gardener", "warn", "doctor.gardener-silent", { at: last.at.slice(0, 16), hours: SILENT_HOURS });
      else add("gardener", "ok", `last upkeep_run ${last.at.slice(0, 16)}Z (night: managed; the hub steps in after ${SILENT_HOURS}h)`);
    }
  }
  // Every agent read comes through a door that logs a call (src/calls.ts); reads without one mean a door skipped it.
  const gap = uncalled(root, Date.now() - 86_400_000);
  if (gap.length) bad("call log", "warn", "doctor.calls-missing", { agents: gap.map((g) => `${g.agent} (${g.reads} reads)`).join(", ") });
  else add("call log", "ok", "every agent read in the last day has its call lines");
  if (!gcfg && gardeners(rules).length && nightMode(root) === "managed")
    bad("gardener", "warn", "doctor.gardener-no-config", {}, "gardener-config");
  if (gcfg) {
    if (!opts.offline) {
      const st = ant(gcfg, ["auth", "status"]);
      if (st.code === 0) add("gardener", "ok", `ant CLI signed in (profile ${gcfg.ant_profile})`);
      else if (st.code === 127) bad("gardener", "FAIL", "doctor.ant-missing");
      else bad("gardener", "FAIL", "doctor.ant-signed-out", { profile: gcfg.ant_profile });
    }
    const c = runs(root).filter((e) => e.op === "cleanup").at(-1);
    if (!gcfg.delete_sessions) bad("gardener", "warn", "doctor.cleanup-off");
    else if (c && Date.now() - Date.parse(c.at) < 2 * 86_400_000) add("gardener", "ok", `last session cleanup ${c.at.slice(0, 16)}Z (${c.deleted} deleted)`);
    else bad("gardener", "warn", "doctor.cleanup-none");
  }
  // Semantic search (docs/semantic-search.md): on or off, and why; off is not a problem.
  add("search", "ok", `semantic search ${semanticState().why}`);
  return out;
}

const GOOGLE_KINDS = new Set(["gmail", "gcal", "gdoc", "contacts"]);
// A contacts source with path: reads a vCard file, not Google.
const isGoogle = (c: { kind: string; path?: string }) => GOOGLE_KINDS.has(c.kind) && !(c.kind === "contacts" && c.path);
const hasKey = (name: string) => !!process.env[name] || existsSync(join(keysDir(), name));

export function sourceFindings(root: string): Finding[] {
  const out: Finding[] = [];
  const file = loadSources(root);
  const all = Object.entries(file.sources ?? {});
  if (!all.length) return [finding("sources", "warn", "doctor.sources-none")];
  const live = all.filter(([, c]) => !c.fixture);
  const gap = live.map(([n, c]) => consentGap(file, n, c)).find(Boolean);
  if (gap) return [finding("sources", "warn", "doctor.sources-consent", { problem: gap })];
  const google = live.filter(([, c]) => isGoogle(c));
  const client = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter((k) => !hasKey(k));
  if (google.length && client.length) return [finding("sources", "warn", "doctor.google-client-missing", { keys: client.join(" and ") })];
  const runs = pullRuns(root);
  for (const [name, c] of all) {
    if (!c.fixture && isGoogle(c) && !hasKey(tokenKey(c.account, c.kind as "gmail" | "gcal" | "gdoc" | "contacts"))) { out.push(finding("sources", "warn", "doctor.source-not-connected", { name })); continue; }
    const last = runs.filter((r) => r.source === name).at(-1);
    if (!last) out.push(finding("sources", "warn", "doctor.source-never-pulled", { name }));
    else if (last.refused) out.push(finding("sources", "warn", "doctor.source-refused", { name, at: last.at.slice(0, 16), why: last.refused }));
    else out.push({ area: "sources", level: "ok", text: `${name}: last pull ${last.at.slice(0, 16)}Z, ${last.fetched} fetched, ${last.stored.length} read` });
  }
  return out;
}

function addDays(d: string, n: number): string {
  return new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);
}

function decodeTime(s: string): number | undefined {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let t = 0;
  for (const c of s) { const v = A.indexOf(c); if (v < 0) return undefined; t = t * 32 + v; }
  return t;
}

export function renderDoctor(f: Finding[]): string {
  const w = Math.max(...f.map((x) => x.area.length));
  const lines = f.map((x) => `${x.level.padEnd(4)}  ${x.area.padEnd(w)}  ${x.text}`);
  const fails = f.filter((x) => x.level === "FAIL").length, warns = f.filter((x) => x.level === "warn").length;
  return `${lines.join("\n")}\n\n${fails ? `${fails} to fix` : "nothing to fix"}${warns ? `, ${warns} warning(s)` : ""}`;
}
