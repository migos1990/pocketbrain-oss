// SPDX-License-Identifier: AGPL-3.0-only
// pocketbrain doctor: one screen on the state of the hub, its replicas, the public door and the
// agents' fallback snapshots. Read-only; each line is ok, warn or FAIL with what to do. A line with
// a safe, known repair names it in `fix`; `pocketbrain doctor --fix` runs them (src/doctor-fix.ts).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { missingOwnerValues } from "./ownerset";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import YAML from "yaml";
import { today } from "./brain";
import { loadRules, gardeners } from "./rules";
import { gardenerConfig, withinHours, tokenAgeDays, lastUpkeep, nightMode, SILENT_HOURS, ant, runs } from "./gardener";
import { backupFindings } from "./backup";
import { readJsonl } from "./util";
import { tokenInfo } from "./auth";
import { STALE_LOCK_MS } from "./git";
import { run, hasSshKeygen, hubRole, verifyNew, verifyWriteLog, signingRequired, replicaName, parseHub, AGENT_INGRESS_PATH, type HubConfig } from "./hub";

const TOKEN_MAX_DAYS = 90;

export type Level = "ok" | "warn" | "FAIL";
export interface Finding { area: string; level: Level; text: string; fix?: string }

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
function doorKind(host: string): { level: Level; text: string } {
  if (/\.ts\.net$/.test(host)) return { level: "warn", text: `${host} is a Tailscale Funnel address: fine as a stopgap, but it changes with the machine; move agents to a named Cloudflare tunnel on your domain` };
  if (/\.trycloudflare\.com$/.test(host)) return { level: "FAIL", text: `${host} is a quick tunnel: a new address on every restart breaks every agent's config` };
  if (/\.(fly\.dev|onrender\.com|herokuapp\.com|vercel\.app|ngrok(-free)?\.(app|io|dev)|railway\.app)$/.test(host)) return { level: "warn", text: `${host} is a vendor subdomain; agents should hold a URL on your own domain so a hub move is one DNS change` };
  if (/^(127\.|localhost$|\[::1\])/.test(host)) return { level: "warn", text: `${host} is this machine only; agents can't reach it` };
  return { level: "ok", text: `agents use ${host}` };
}

// Every non-loopback IPv4 address of this machine.
function outsideAddresses(): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
}

export async function doctor(root: string, opts: { offline?: boolean } = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (area: string, level: Level, text: string, fix?: string) => out.push({ area, level, text, ...(fix ? { fix } : {}) });
  const role = hubRole(root);

  // A lock left by a killed git command stops every commit until someone removes it.
  try {
    const age = Date.now() - statSync(join(root, ".git", "index.lock")).mtimeMs;
    if (age > STALE_LOCK_MS) add("git", "FAIL", `.git/index.lock is ${Math.round(age / 60_000)} min old, left by a git command that was killed; nothing can commit until it's gone`, "lock");
  } catch { /* no lock */ }

  // Role and identity.
  if (role.mode === "single") add("hub", "ok", "single machine (a second machine needs pocketbrain hub init; see docs/hub.md)");
  else if (role.mode === "unnamed") add("hub", "FAIL", `this clone has no replica name, so it can't commit; run pocketbrain hub init --name <machine> (hub is ${role.cfg.hub})`);
  else add("hub", "ok", `${role.name} is ${role.mode === "hub" ? "the hub" : `a replica; the hub is ${role.cfg.hub}`} (epoch ${role.cfg.epoch}${role.cfg.since ? `, since ${role.cfg.since}` : ""})`);
  const cfg: HubConfig | undefined = role.mode === "single" ? undefined : role.cfg;
  const me = replicaName(root);

  // Signing.
  if (cfg) {
    const key = git(root, ["config", "--get", "user.signingkey"]).out;
    const on = git(root, ["config", "--get", "commit.gpgsign"]).out === "true";
    const listed = me ? cfg.replicas[me]?.signing_key : undefined;
    if (signingRequired(cfg) && !hasSshKeygen()) add("signing", "FAIL", "ssh-keygen isn't installed, so commits can't be signed or verified; install openssh-client");
    else if (!signingRequired(cfg)) add("signing", "warn", "rules/hub.yaml doesn't require signed commits, so a promoted hub can't tell forged history from real");
    else if (!on || !key) add("signing", "FAIL", `${me ?? "this clone"} doesn't sign commits; run pocketbrain hub init --name ${me ?? "<machine>"} --key <private key>`);
    else if (!existsSync(key.replace(/^~/, process.env.HOME ?? ""))) add("signing", "FAIL", `signing key ${key} is missing`);
    else if (!listed) add("signing", "FAIL", `${me}'s key isn't in rules/hub.yaml; on the hub run pocketbrain hub add-replica ${me} --pub "<public key>"`);
    else add("signing", "ok", `${me} signs with ${key}`);
  }

  // History and write log.
  if (cfg) {
    const v = verifyNew(root);
    if (v.problems.length) add("history", "FAIL", `${v.problems.length} commit(s) don't check out: ${v.problems.slice(0, 3).join("; ")}`);
    else add("history", "ok", `${v.checked} new commit(s) verified against rules/hub.yaml`);
  }
  const log = verifyWriteLog(root);
  if (log.problems.length) add("write log", "FAIL", `log/writes.jsonl chain broken: ${log.problems.slice(0, 3).join("; ")}`);
  else if (log.entries) add("write log", "ok", `log/writes.jsonl chain intact (${log.entries} entries)`);

  // Ops waiting.
  const opsDir = join(root, "ops");
  const waiting: Record<string, string[]> = {};
  if (existsSync(opsDir)) for (const r of readdirSync(opsDir, { withFileTypes: true }))
    if (r.isDirectory() && r.name !== "applied") waiting[r.name] = readdirSync(join(opsDir, r.name)).filter((f) => f.endsWith(".json")).sort();
  const total = Object.values(waiting).reduce((n, l) => n + l.length, 0);
  const inbound = git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads/inbound/"]).out.split("\n").filter(Boolean);
  if (role.mode === "hub") {
    if (inbound.length) add("ops", "warn", `inbound from ${inbound.map((r) => r.split("/").pop()).join(", ")} not ingested yet; pocketbrain hub sync (the server does it every ${cfg!.tick_minutes ?? 5} min)`);
    if (total) add("ops", "warn", `${total} op(s) not applied yet: ${Object.entries(waiting).filter(([, l]) => l.length).map(([k, l]) => `${k} ${l.length}`).join(", ")}`);
    if (!inbound.length && !total) add("ops", "ok", "no ops waiting");
  } else if (role.mode === "replica") {
    const n = waiting[me!]?.length ?? 0;
    if (!n) add("ops", "ok", "nothing queued here");
    else {
      const oldest = waiting[me!][0];
      const t = decodeTime(oldest.slice(0, 10));
      const age = t ? Math.round((Date.now() - t) / 3600000) : 0;
      add("ops", age > 24 ? "warn" : "ok", `${n} write(s) queued for ${cfg!.hub}, oldest ${age}h ago; pocketbrain hub sync sends them`);
    }
  }
  // Alerts the hub raised about replicas.
  const hubAlerts = readJsonl<{ agent?: string; at?: string; check?: string; from?: string }>(join(root, "log", "alerts.jsonl")).filter((a) => a.agent === "hub" && String(a.at ?? "").slice(0, 10) >= addDays(today(), -7));
  if (hubAlerts.length) add("ops", "FAIL", `${hubAlerts.length} hub alert(s) this week, latest: ${hubAlerts[hubAlerts.length - 1].check}: ${hubAlerts[hubAlerts.length - 1].from}`);

  // Peers: who is reachable, and does anyone know a newer epoch (split brain).
  if (cfg && !opts.offline) {
    for (const [n, r] of Object.entries(cfg.replicas)) {
      if (n === me) continue;
      if (!r.git) { add("replicas", "warn", `${n}: no git address in rules/hub.yaml, so nobody can sync with it`); continue; }
      const f = git(root, ["fetch", "-q", r.git, `+refs/heads/main:refs/pocketbrain/peers/${n}`], 15000);
      if (f.code !== 0) { add("replicas", n === cfg.hub ? "FAIL" : "warn", `${n} unreachable at ${r.git}${n === cfg.hub ? "; agents fall back to their snapshots, writes here queue. If it stays down: pocketbrain hub promote <this machine>" : ""}`); continue; }
      const theirs = parseHub(git(root, ["show", `refs/pocketbrain/peers/${n}:rules/hub.yaml`]).out);
      if (theirs && theirs.epoch > cfg.epoch) add("replicas", "FAIL", `${n} knows epoch ${theirs.epoch} naming ${theirs.hub}; this clone is behind. Run pocketbrain hub sync`);
      else if (theirs && theirs.epoch === cfg.epoch && theirs.hub !== cfg.hub) add("replicas", "FAIL", `split brain: ${n} says ${theirs.hub} is hub at epoch ${cfg.epoch}, this clone says ${cfg.hub}`);
      else {
        const behind = Number(git(root, ["rev-list", "--count", `refs/pocketbrain/peers/${n}..HEAD`]).out || 0);
        add("replicas", "ok", `${n} reachable${theirs && theirs.epoch < cfg.epoch ? ` (still on epoch ${theirs.epoch}; it steps down at its next sync)` : ""}${role.mode === "hub" && behind ? `, ${behind} commit(s) behind` : ""}`);
      }
    }
  }

  // Backups: commits not yet on origin (as of the last fetch).
  if (git(root, ["remote", "get-url", "origin"]).code === 0 && role.mode !== "replica") {
    const n = Number(git(root, ["rev-list", "--count", "origin/main..HEAD"]).out || 0);
    add("backup", n > 50 ? "warn" : "ok", n ? `${n} commit(s) not on origin yet` : "origin has everything");
  }

  // Encrypted backups (src/backup.ts): configured, recent, still in the folder.
  if (role.mode !== "replica") out.push(...backupFindings(root));
  // Values the owner was told to set by hand, each with the command that sets it (src/ownerset.ts).
  const hostKnown = !!doorHost(cfg);
  for (const m of missingOwnerValues(root)) add("setup", "warn", m.text, m.key === "public_url" ? (hostKnown ? "public-url" : undefined) : m.key === "gardener" ? "gardener-config" : undefined);

  // The live server and the public door (hub only; replicas don't serve agents).
  if (role.mode === "hub" || role.mode === "single") {
    const port = cfg?.port ?? 8787;
    if (!opts.offline) {
      const local = await answers(`http://127.0.0.1:${port}/health`);
      add("server", local === 200 ? "ok" : "warn", local === 200 ? `agent server answers on 127.0.0.1:${port}` : `nothing answers on 127.0.0.1:${port}; start it with pocketbrain serve`);
    }
    if (cfg?.public_url) {
      const host = new URL(cfg.public_url).host;
      const k = doorKind(host);
      add("door", k.level, k.text);
      if (!opts.offline) {
        const pub = await answers(new URL("/health", cfg.public_url).toString(), 8000);
        add("door", pub === 200 ? "ok" : "FAIL", pub === 200 ? `${cfg.public_url}/health answers` : `${cfg.public_url}/health doesn't answer${pub ? ` (HTTP ${pub})` : ""}; check the tunnel on ${cfg.hub}`);
      }
    } else if (cfg) add("door", "warn", "no public_url in rules/hub.yaml: agents have no address to hold", hostKnown ? "public-url" : undefined);
    // cloudflared ingress: only the agent API, never the dashboard. http_status:404 is the catch-all, not a forward.
    const tf = tunnelFile(cfg);
    if (tf) {
      const ing = tunnelIngress(tf);
      const dport = String(cfg?.dashboard_port ?? 8788);
      const fix = hostKnown ? "tunnel" : undefined;
      if (ing.some((r) => r.service?.includes(`:${dport}`))) add("door", "FAIL", `${tf} routes to the dashboard port ${dport}; remove that rule`, fix);
      else if (ing.some((r) => /^https?:\/\//.test(r.service ?? "") && !r.path)) add("door", "warn", `${tf} forwards every path; limit it to /mcp, /v1, /health, /openapi.json (pocketbrain hub tunnel-config)`, fix);
      else add("door", "ok", `${tf} forwards only the agent API`);
      // A config written by an older version lacks newer routes (the browser door's /b): the door
      // answers, but those routes 404 until the ingress is replaced by hand.
      const api = ing.find((r) => r.path && r.service?.startsWith("http") && !r.service.includes(`:${dport}`));
      if (api && api.path !== AGENT_INGRESS_PATH) add("door", "warn", `${tf}'s agent rule is older than this version (it should forward ${AGENT_INGRESS_PATH}, which includes the browser door's /b); replace its ingress with what \`pocketbrain hub tunnel-config\` prints, then restart the tunnel`, fix);
      if (ing.length && ing[ing.length - 1].service !== "http_status:404") add("door", "warn", `${tf}: end the ingress with "- service: http_status:404"`, fix);
    } else if (cfg?.tunnel?.config) add("door", "warn", `tunnel config ${cfg.tunnel.config} not found on this machine`);
    // The dashboard must answer on loopback only.
    if (!opts.offline) {
      const dport = cfg?.dashboard_port ?? 8788;
      const exposed: string[] = [];
      for (const ip of outsideAddresses()) if ((await answers(`http://${ip}:${dport}/`, 1500)) !== undefined) exposed.push(ip);
      if (exposed.length) add("dashboard", "FAIL", `the dashboard port ${dport} answers on ${exposed.join(", ")}; it must listen on 127.0.0.1 only`);
      else add("dashboard", "ok", `port ${dport} isn't reachable from outside this machine`);
    }
  }

  // Snapshots: what each live agent falls back to while the hub sleeps (7.4).
  const rules = loadRules(root);
  // act blocks loadRules dropped because they didn't validate (docs/act.md): that agent has no actions.
  for (const p of rules.actProblems ?? []) add("act", "warn", `${p}; no actions until it is fixed in rules/policy.yaml`);
  const live = Object.entries(rules.policy.agents).filter(([, a]) => !a.inside_wall && a.transport !== "paste" && a.status !== "paused" && a.role !== "gardener").map(([k]) => k);
  const snapDir = join(root, "views", "snapshots");
  const dates = existsSync(snapDir) ? readdirSync(snapDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  for (const a of live) {
    const last = [...dates].reverse().find((d) => existsSync(join(snapDir, d, `${a}.md`)));
    if (!last) add("snapshots", "warn", `${a} has no snapshot to fall back on; run pocketbrain build --all and paste it`);
    else {
      const age = days(last, today());
      add("snapshots", age > 7 ? "warn" : "ok", `${a}: snapshot from ${last}${age ? ` (${age} day${age > 1 ? "s" : ""} old)` : " (today)"}`);
    }
  }

  // Pasted tokens older than 90 days: one rotate with an overlap, no break (docs/add-an-agent.md#rotating-a-token).
  // The gardener's token has its own weekly rotation, below.
  const tokens = tokenInfo(root);
  for (const [agent, list] of Object.entries(tokens)) {
    const a = Object.hasOwn(rules.policy.agents, agent) ? rules.policy.agents[agent] : undefined;
    if (!a || a.inside_wall || a.role === "gardener" || !Array.isArray(list)) continue;
    const old = list.filter((e) => typeof e.issued === "string" && !e.expires && days(e.issued, today()) > TOKEN_MAX_DAYS);
    for (const r of new Set(old.map((e) => e.role ?? ""))) add("tokens", "warn", `${agent} has a ${r ? `${r} ` : ""}token older than ${TOKEN_MAX_DAYS} days; rotate it: pocketbrain token rotate ${agent}${r ? ` --role ${r}` : ""} (the old one keeps working for 24 h)`);
  }

  // The gardener: paused or in its hours, its token's age, the ant CLI, the last cleanup.
  const gcfg = gardenerConfig(root);
  for (const g of gardeners(rules)) {
    const a = rules.policy.agents[g];
    if (a.status === "paused") add("gardener", "warn", `${g} is paused${readJsonl<{ check?: string; agent?: string }>(join(root, "log", "alerts.jsonl")).some((x) => x.check === "gardener_hours" && x.agent === g) ? " (its token was used outside its hours; see Needs you)" : ""}; unpause it in the dashboard`);
    else add("gardener", "ok", `${g} is ${a.windows?.length ? (withinHours(root, rules, g) ? "inside its hours now" : `outside its hours now (${a.windows.join(", ")})`) : "allowed at any hour (no windows set)"}`);
    const age = tokenAgeDays(root, g);
    const limit = (gcfg?.rotate_days ?? 7) + 1;
    add("gardener", age === undefined ? "warn" : age > limit ? "warn" : "ok", age === undefined ? `${g} has no token yet` : `${g}'s token is ${age} day(s) old${age > limit ? `; rotate it: pocketbrain gardener rotate` : ""}`);
    const last = lastUpkeep(root);
    if (nightMode(root) === "managed") add("gardener", !last || Date.now() - Date.parse(last.at) > SILENT_HOURS * 3_600_000 ? "warn" : "ok", last ? `last upkeep_run ${last.at.slice(0, 16)}Z (night: managed; the hub steps in after ${SILENT_HOURS}h)` : `no upkeep_run yet (night: managed; the hub runs the night itself until it does)`);
  }
  if (!gcfg && gardeners(rules).length && nightMode(root) === "managed")
    add("gardener", "warn", "no rules/gardener.yaml: session cleanup and token rotation never run for the managed gardener; add it (one line is enough: ant_profile: pocketbrain; see docs/gardener.md)", "gardener-config");
  if (gcfg) {
    if (!opts.offline) {
      const st = ant(gcfg, ["auth", "status"]);
      add("gardener", st.code === 0 ? "ok" : "FAIL", st.code === 0 ? `ant CLI signed in (profile ${gcfg.ant_profile})` : st.code === 127 ? "the ant CLI isn't installed; cleanup and rotation can't run" : `ant profile ${gcfg.ant_profile} isn't signed in: ant auth login --profile ${gcfg.ant_profile}`);
    }
    const c = runs(root).filter((e) => e.op === "cleanup").at(-1);
    add("gardener", !gcfg.delete_sessions ? "warn" : c && Date.now() - Date.parse(c.at) < 2 * 86_400_000 ? "ok" : "warn", !gcfg.delete_sessions ? "session cleanup is off: ended sessions keep a copy of what the gardener read" : c ? `last session cleanup ${c.at.slice(0, 16)}Z (${c.deleted} deleted)` : "no session cleanup yet (pocketbrain gardener cleanup)");
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
