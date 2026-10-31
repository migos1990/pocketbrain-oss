// SPDX-License-Identifier: AGPL-3.0-only
// Hub operations (portability.md 7.2 to 7.4): one hub at a time, many full replicas.
//   rules/hub.yaml   names the hub, its epoch, and every replica's SSH signing key and git address.
//   ops/<replica>/   a replica never commits brain changes: write() queues each one as an op file.
//   hub ingest       the hub takes a replica's op files only from commits that replica signed.
//   hub replay       the hub applies op files through write(), then files them in ops/applied/.
//   hub sync         a replica sends its ops and moves to the hub's main (nothing to merge).
//   hub promote      any full clone becomes the hub: verify, bump the epoch, replay what's queued.
// Without rules/hub.yaml the brain is one machine and none of this applies.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tokenRole, withTokenRole, TOKEN_ROLES, type TokenRole } from "./tokenrole";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { sha256, alert } from "./util";
import YAML from "yaml";
import { today } from "./brain";
import type { WriteRequest } from "./checks";
import { write, applyInboxOp, type WriteResult } from "./write";
import { applyCaptureOp } from "./capture";
import { applyUpkeepOp } from "./upkeep";
import { git } from "./git";
import { OWNER } from "./owner";

export interface ReplicaSpec {
  signing_key?: string; // "ssh-ed25519 AAAA… comment": the public half of this machine's signing key
  git?: string; // where the other clones reach this one (an ssh:// address on the tailnet, or a path)
  can_be_hub?: boolean; // false for a phone or a storage-only copy
  may_write_as?: string[]; // agents this machine may queue writes for; unset = any agent in policy.yaml
}

export interface HubConfig {
  hub: string;
  epoch: number;
  since?: string;
  previous?: string;
  require_signed?: boolean; // default: true as soon as any replica lists a signing key
  replicas: Record<string, ReplicaSpec>;
  public_url?: string; // https://brain.<Louis's domain>: the one address agents hold (7.3)
  tunnel?: { kind?: "cloudflare" | "funnel" | "none"; name?: string; config?: string };
  port?: number; // the agent server's local port (default 8787)
  dashboard_port?: number; // default 8788
  dashboard_tailnet?: boolean; // also serve the dashboard on this machine's Tailscale address (docs/dashboard-tailnet.md)
  dashboard_tailnet_login?: string; // the owner's Tailscale login; only it gets in through `tailscale serve`
  dashboard_tailnet_devices?: string[]; // the tailnet addresses (100.x) of the owner's own devices that may open it; none listed, none can
  tick_minutes?: number; // how often a serving hub ingests and replays (default 5)
  night?: "local" | "managed"; // who runs the nightly pass (src/gardener.ts); default local
}

export class HubError extends Error {}

const HUB_FILE = "rules/hub.yaml";

// ---------- small git helpers (these need exit codes; src/git.ts only returns stdout) ----------

export interface Run { code: number; out: string; err: string }
export function run(root: string, args: string[], opts: { author?: string; timeoutMs?: number } = {}): Run {
  const env = { ...process.env };
  if (opts.author) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = opts.author;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${opts.author}@pocketbrain.local`;
  }
  // Stop git from asking for a password or a host key when a peer is unreachable.
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_SSH_COMMAND ??= "ssh -o BatchMode=yes -o ConnectTimeout=5";
  const r = Bun.spawnSync(["git", ...args], { cwd: root, env, timeout: opts.timeoutMs });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

// A commit that moves the hub or applies ops is made by the machine for Louis. While it runs,
// the gate in src/git.ts lets the hub.yaml change through (the rest of the gate still holds).
let promoting = false;
function asPromotion<T>(fn: () => T): T {
  promoting = true;
  try { return fn(); } finally { promoting = false; }
}

// ---------- config and identity ----------

export function parseHub(text: string | undefined): HubConfig | undefined {
  if (!text) return undefined;
  const c = YAML.parse(text) as HubConfig | null;
  if (!c?.hub) return undefined;
  return { ...c, epoch: Number(c.epoch ?? 1), replicas: c.replicas ?? {} };
}

export function loadHub(root: string): HubConfig | undefined {
  const f = join(root, HUB_FILE);
  return existsSync(f) ? parseHub(readFileSync(f, "utf8")) : undefined;
}

// hub.yaml as of a commit (undefined before hub mode started).
function hubAt(root: string, rev: string): HubConfig | undefined {
  const r = run(root, ["show", `${rev}:${HUB_FILE}`]);
  return r.code === 0 ? parseHub(r.out) : undefined;
}

// Which machine this clone is. Kept outside the repo (each clone has its own), in .git/config.
export function replicaName(root: string): string | undefined {
  return process.env.PB_REPLICA || run(root, ["config", "--local", "--get", "pocketbrain.replica"]).out || undefined;
}

export function signingRequired(cfg: HubConfig): boolean {
  return cfg.require_signed ?? Object.values(cfg.replicas).some((r) => r.signing_key);
}

export type Role = { mode: "single" } | { mode: "hub" | "replica" | "unnamed"; name?: string; cfg: HubConfig };
export function hubRole(root: string): Role {
  const cfg = loadHub(root);
  if (!cfg) return { mode: "single" };
  const name = replicaName(root);
  if (!name) return { mode: "unnamed", cfg };
  return { mode: name === cfg.hub ? "hub" : "replica", name, cfg };
}

function signingConfigured(root: string): boolean {
  return run(root, ["config", "--get", "commit.gpgsign"]).out === "true" && !!run(root, ["config", "--get", "user.signingkey"]).out;
}

// ---------- the gate: called by git() before anything that makes a commit ----------

export function hubGate(root: string, args: string[]) {
  if (!existsSync(join(root, HUB_FILE))) return;
  const role = hubRole(root);
  if (role.mode === "single") return;
  if (role.mode === "unnamed") throw new HubError(`this clone has no replica name, so it commits nothing (rules/hub.yaml is set). Run: pocketbrain hub init --name <this machine>`);
  const { cfg, name } = role;
  if (signingRequired(role.cfg) && !signingConfigured(root))
    throw new HubError(`rules/hub.yaml requires signed commits and ${name} has no signing key set. Run: pocketbrain hub init --name ${name} --key <private key file>`);
  if (role.mode === "hub" || promoting) return;
  const staged = lines(run(root, ["diff", "--cached", "--name-only"]).out);
  const dd = args.indexOf("--");
  const paths = [...staged, ...(dd >= 0 ? args.slice(dd + 1) : [])];
  if (args[0] === "commit" && paths.length && paths.every((p) => p.startsWith(`ops/${name}/`))) return;
  throw new HubError(`${name} is a replica; ${cfg.hub} is the hub (rules/hub.yaml, epoch ${cfg.epoch}). Only the hub commits brain changes: writes made here are queued in ops/${name}/ for it. Do this on ${cfg.hub}, or move the hub here with: pocketbrain hub promote ${name}`);
}

// ---------- ops: queue on a replica ----------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastUlid = { t: 0, r: "" };
// Sortable unique ids: 48-bit milliseconds then 80 random bits, monotonic within a millisecond.
export function ulid(now = Date.now()): string {
  let t = "";
  for (let i = 9, n = now; i >= 0; i--, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
  let r: string;
  if (now === lastUlid.t) {
    const chars = lastUlid.r.split("");
    for (let i = chars.length - 1; i >= 0; i--) {
      const v = CROCKFORD.indexOf(chars[i]);
      if (v < 31) { chars[i] = CROCKFORD[v + 1]; break; }
      chars[i] = "0";
    }
    r = chars.join("");
  } else {
    const b = randomBytes(16);
    r = [...b].map((x) => CROCKFORD[x % 32]).join("");
  }
  lastUlid = { t: now, r };
  return t + r;
}

export interface Op extends Omit<WriteRequest, "agent"> {
  request_id: string;
  replica: string;
  by: string;
  queued_at: string;
  // What the hub does with it. Unset: a write through write(), as before. The others are the
  // steps that used to be hub-only (docs/capture.md): a quick capture to store, Louis's answer
  // to an inbox item, and an upkeep run with the live rechecks this machine made.
  op?: "write" | OpKind;
  // The role of the token that made the write (G18), so the hub replays it under the same limits.
  token?: TokenRole;
  payload?: Record<string, unknown>;
}

export type OpKind = "capture" | "inbox" | "upkeep";

// How the hub applies each kind. Imported directly (only called at replay time, so the
// import cycle through write.ts is harmless).
function applyOp(kind: OpKind, root: string, by: string, payload: Record<string, unknown>): WriteResult {
  switch (kind) {
    case "capture": return applyCaptureOp(root, by, payload);
    case "inbox": return applyInboxOp(root, by, payload);
    case "upkeep": return applyUpkeepOp(root, by, payload);
  }
  return { outcome: "refused", message: `unknown op ${kind}` };
}

// What may queue an op from this clone; undefined when it may (or this isn't a replica).
function mayQueue(role: Role, by: string): string | undefined {
  if (role.mode === "single" || role.mode === "hub") return undefined;
  if (role.mode === "unnamed") return "this clone has no replica name; run pocketbrain hub init --name <machine>";
  const allowed = role.cfg.replicas[role.name!]?.may_write_as;
  return allowed && !allowed.includes(by) ? `${role.name} may queue writes only for ${allowed.join(", ")} (rules/hub.yaml)` : undefined;
}

// Saves one op as ops/<me>/<ulid>.json, committed (and signed) by this machine.
function saveOp(root: string, me: string, op: Omit<Op, "request_id" | "replica" | "queued_at">, label: string): string {
  const id = ulid();
  const rel = `ops/${me}/${id}.json`;
  const full = { request_id: id, replica: me, queued_at: new Date().toISOString(), ...op } as Op;
  mkdirSync(join(root, "ops", me), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify(full, null, 2) + "\n");
  run(root, ["add", rel]);
  // Through git() so the gate (only ops/<me>/, signed) applies here too.
  gitCommit(root, [`op(${me}): ${label}`], op.by, [rel]);
  return rel;
}

// write() calls this first. On a replica the request becomes ops/<me>/<ulid>.json, committed
// (and signed) by this machine; only the hub applies it. Returns undefined on the hub.
export function queueIfReplica(root: string, req: WriteRequest): WriteResult | undefined {
  const role = hubRole(root);
  if (role.mode === "single" || role.mode === "hub") return undefined;
  const no = mayQueue(role, req.agent);
  if (no) return { outcome: "refused", message: no };
  const me = role.name!;
  const { agent, ...rest } = req;
  const token = tokenRole(agent);
  const rel = saveOp(root, me, { by: agent, ...(token ? { token } : {}), ...rest }, `${agent} ${req.id ?? req.title ?? ""}#${req.attribute ?? req.kind ?? ""}`);
  return { outcome: "queued", message: `queued as ${rel}; ${role.cfg.hub} applies it when ${me} syncs`, file: rel };
}

// The same for a capture, an inbox decision or an upkeep run: undefined on the hub (do it
// here), else the queued (or refused) result.
export function queueOp(root: string, kind: OpKind, by: string, payload: Record<string, unknown>, label: string): WriteResult | undefined {
  const role = hubRole(root);
  if (role.mode === "single" || role.mode === "hub") return undefined;
  const no = mayQueue(role, by);
  if (no) return { outcome: "refused", message: no };
  const me = role.name!;
  const rel = saveOp(root, me, { by, op: kind, payload }, `${kind} by ${by}: ${label}`);
  return { outcome: "queued", message: `queued as ${rel}; ${role.cfg.hub} applies it when ${me} syncs`, file: rel };
}

// Ops this clone queued and the hub hasn't taken yet (for dedupe before queuing again).
export function pendingOps(root: string, kind?: OpKind): Op[] {
  const me = replicaName(root);
  if (!me) return [];
  return opFiles(root).filter((f) => f.replica === me).flatMap((f) => {
    try { const o = JSON.parse(readFileSync(join(root, f.rel), "utf8")) as Op; return !kind || o.op === kind ? [o] : []; } catch { return []; }
  });
}

// Through git(), so the gate applies to every commit made here too.
function gitCommit(root: string, message: string[], author: string, paths?: string[]) {
  git(root, ["commit", "-q", ...message.flatMap((m) => ["-m", m]), ...(paths ? ["--", ...paths] : [])], author);
}

// ---------- ops: replay on the hub ----------

export interface ReplayResult { applied: { op: string; outcome: string; message: string }[]; skipped: string[] }

function opFiles(root: string): { rel: string; replica: string; id: string }[] {
  const dir = join(root, "ops");
  if (!existsSync(dir)) return [];
  const out: { rel: string; replica: string; id: string }[] = [];
  for (const r of readdirSync(dir, { withFileTypes: true })) {
    if (!r.isDirectory() || r.name === "applied") continue;
    for (const f of readdirSync(join(dir, r.name))) {
      const m = f.match(/^([0-9A-HJKMNP-TV-Z]{26})\.json$/);
      if (m) out.push({ rel: `ops/${r.name}/${f}`, replica: r.name, id: m[1] });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function appliedIds(root: string): Set<string> {
  const dir = join(root, "ops", "applied");
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  for (const m of readdirSync(dir)) for (const f of readdirSync(join(dir, m))) ids.add(f.replace(/\.json$/, ""));
  return ids;
}

function hubAlert(root: string, check: string, from: string) {
  alert(root, { agent: "hub", check, from });
}

// Applies every queued op through write(). write() is idempotent (request hash,
// same value = no-op) and orders facts by as_of, so late, repeated or out-of-order ops land the
// same way. Each op then moves to ops/applied/<YYYY-MM>/<replica>-<ulid>.json with its outcome.
export function replay(root: string): ReplayResult {
  const role = hubRole(root);
  if (role.mode !== "hub" && role.mode !== "single") throw new HubError(`only the hub replays ops; ${role.mode === "replica" ? role.cfg.hub : "nobody"} is the hub`);
  const done = appliedIds(root);
  const res: ReplayResult = { applied: [], skipped: [] };
  const moved: string[] = [];
  const month = today().slice(0, 7);
  // Within a batch, oldest as_of first (then queue order), so a batch lands the same whatever
  // order it was queued in. An older value that arrives after a newer one went live is a
  // conflict for write() to settle or dispute, as it would be from any writer.
  const batch = opFiles(root).map((f) => ({ ...f, asOf: (() => { try { return String(JSON.parse(readFileSync(join(root, f.rel), "utf8")).as_of ?? ""); } catch { return ""; } })() }))
    .sort((a, b) => a.asOf.localeCompare(b.asOf) || a.id.localeCompare(b.id));
  for (const f of batch) {
    const dest = `ops/applied/${month}/${f.replica}-${f.id}.json`;
    let op: Op;
    try { op = JSON.parse(readFileSync(join(root, f.rel), "utf8")); } catch { res.skipped.push(`${f.rel}: not JSON`); continue; }
    let r: WriteResult;
    if (done.has(`${f.replica}-${f.id}`)) r = { outcome: "noop", message: "already applied" };
    else if (op.replica !== f.replica || op.request_id !== f.id) r = { outcome: "refused", message: `op says replica ${op.replica} / id ${op.request_id}, but sits in ${f.rel}` };
    else if (role.mode === "hub" && !role.cfg.replicas[f.replica]) r = { outcome: "refused", message: `${f.replica} isn't a replica in rules/hub.yaml` };
    else if (role.mode === "hub" && role.cfg.replicas[f.replica].may_write_as && !role.cfg.replicas[f.replica].may_write_as!.includes(op.by)) r = { outcome: "refused", message: `${f.replica} may not write as ${op.by}` };
    else {
      const { request_id: _id, replica: _r, by, queued_at: _q, op: kind, payload, token, ...req } = op;
      if (token !== undefined && !TOKEN_ROLES.includes(token)) r = { outcome: "refused", message: `unknown token role ${token}` };
      else if (!kind || kind === "write") r = withTokenRole(by, token, () => write(root, { ...(req as Omit<WriteRequest, "agent">), agent: by }));
      else {
        try { r = applyOp(kind, root, by, payload ?? {}); } catch (e) { r = { outcome: "refused", message: `${kind}: ${(e as Error).message}` }; }
      }
    }
    if (r.outcome === "refused" && /may not write as|isn't a replica|sits in/.test(r.message)) hubAlert(root, "op_refused", `${f.rel}: ${r.message}`);
    mkdirSync(join(root, dirname(dest)), { recursive: true });
    writeFileSync(join(root, dest), JSON.stringify({ ...op, applied: { at: new Date().toISOString(), by: role.mode === "hub" ? role.name : "hub", outcome: r.outcome, message: r.message, ...(r.fact_key ? { fact_key: r.fact_key } : {}) } }, null, 2) + "\n");
    rmSync(join(root, f.rel));
    moved.push(f.rel, dest);
    done.add(`${f.replica}-${f.id}`);
    res.applied.push({ op: f.rel, outcome: r.outcome, message: r.message });
  }
  if (moved.length) {
    run(root, ["add", "-A", "ops"]);
    gitCommit(root, [`hub: applied ${res.applied.length} op(s)`, res.applied.map((a) => `${a.op}: ${a.outcome}`).join("\n")], "hub");
  }
  return res;
}

// ---------- signatures and history ----------

function allowedSigners(cfg: HubConfig): string {
  const f = join(tmpdir(), `pb-signers-${process.pid}-${randomBytes(4).toString("hex")}`);
  writeFileSync(f, Object.entries(cfg.replicas).filter(([, r]) => r.signing_key).map(([n, r]) => `${n} namespaces="git" ${r.signing_key}`).join("\n") + "\n");
  return f;
}

// The replica whose key signed `rev`, by the keys in `cfg`; undefined if unsigned or unknown.
export function signerOf(root: string, rev: string, cfg: HubConfig): string | undefined {
  const f = allowedSigners(cfg);
  try {
    // Checked with ssh-keygen whatever program signs (1Password's op-ssh-sign makes the same format).
    const r = run(root, ["-c", "gpg.ssh.program=ssh-keygen", "-c", `gpg.ssh.allowedSignersFile=${f}`, "log", "-1", "--format=%G?%x09%GS", rev]);
    const [status, principal] = r.out.split("\t");
    return status === "G" && principal && cfg.replicas[principal] ? principal : undefined;
  } finally { rmSync(f, { force: true }); }
}

function changes(root: string, rev: string, parent?: string): { status: string; path: string }[] {
  const r = parent
    ? run(root, ["diff", "--name-status", "--no-renames", parent, rev])
    : run(root, ["show", "--name-status", "--no-renames", "--format=", rev]);
  return lines(r.out).map((l) => { const [status, ...p] = l.split("\t"); return { status, path: p.join("\t") }; });
}

// Checks every commit in from..to (from excluded) against the hub.yaml in force before it:
// signed by a listed replica; anything but the hub may only add its own op files, or promote
// itself with a hub.yaml change that bumps the epoch by one. The epoch never goes back.
export function verifyHistory(root: string, from: string | undefined, to = "HEAD"): { checked: number; problems: string[] } {
  const revs = lines(run(root, ["rev-list", "--reverse", "--topo-order", from ? `${from}..${to}` : to]).out);
  const problems: string[] = [];
  let checked = 0;
  for (const c of revs) {
    const parent = lines(run(root, ["rev-list", "--parents", "-n", "1", c]).out)[0]?.split(" ")[1];
    const before = parent ? hubAt(root, parent) : undefined;
    const after = hubAt(root, c);
    if (!before && !after) continue; // history from before hub mode
    checked++;
    const cfg = before ?? after!; // the commit that starts hub mode is checked against its own keys
    const short = c.slice(0, 8);
    if (before && after && after.epoch < before.epoch) problems.push(`${short}: epoch went back from ${before.epoch} to ${after.epoch}`);
    if (!signingRequired(cfg)) continue;
    const signer = signerOf(root, c, cfg);
    if (!signer) { problems.push(`${short}: not signed by any key in rules/hub.yaml`); continue; }
    if (signer === cfg.hub) continue;
    const ch = changes(root, c, parent);
    if (ch.length && ch.every((x) => x.status === "A" && x.path.startsWith(`ops/${signer}/`))) continue;
    const promotion = before && after && ch.length === 1 && ch[0].path === HUB_FILE && after.hub === signer && after.epoch === before.epoch + 1 && before.replicas[signer]?.can_be_hub !== false;
    if (promotion) continue;
    problems.push(`${short}: signed by ${signer}, which wasn't the hub (${cfg.hub}), and changes ${ch.map((x) => x.path).slice(0, 3).join(", ")}${ch.length > 3 ? "…" : ""}`);
  }
  return { checked, problems };
}

const MARK = (root: string) => join(root, ".git", "pocketbrain-verified");
function lastVerified(root: string): string | undefined {
  const m = existsSync(MARK(root)) ? readFileSync(MARK(root), "utf8").trim() : "";
  return m && run(root, ["cat-file", "-e", `${m}^{commit}`]).code === 0 && run(root, ["merge-base", "--is-ancestor", m, "HEAD"]).code === 0 ? m : undefined;
}
// Verifies what's new since the last good check, and moves the mark forward if clean.
export function verifyNew(root: string): { checked: number; problems: string[] } {
  const r = verifyHistory(root, lastVerified(root));
  if (!r.problems.length) writeFileSync(MARK(root), run(root, ["rev-parse", "HEAD"]).out + "\n");
  return r;
}

// log/writes.jsonl is hash-chained by logWrite(): each line's hash covers the line and the
// previous hash. Any edit or deletion breaks the chain from that line on.
export function verifyWriteLog(root: string): { entries: number; problems: string[] } {
  const f = join(root, "log", "writes.jsonl");
  if (!existsSync(f)) return { entries: 0, problems: [] };
  let prev = "0".repeat(64);
  const problems: string[] = [];
  const all = lines(readFileSync(f, "utf8"));
  all.forEach((l, i) => {
    let e: Record<string, unknown>;
    try { e = JSON.parse(l); } catch { problems.push(`line ${i + 1}: not JSON`); return; }
    const { hash, ...rest } = e;
    if (rest.prev !== prev) problems.push(`line ${i + 1}: previous hash doesn't match`);
    if (sha256(JSON.stringify(rest)) !== hash) problems.push(`line ${i + 1}: hash doesn't match its content`);
    prev = String(hash);
  });
  return { entries: all.length, problems };
}

// ---------- ingest: the hub takes signed ops from replicas ----------

// Replicas push their op commits to refs/heads/inbound/<replica> on the hub. Every commit there
// must be signed by that replica and only add files under ops/<replica>/; otherwise the whole
// branch is refused and Louis is alerted. Accepted op files are copied onto main by the hub.
export function ingest(root: string): { received: Record<string, number>; refused: Record<string, string> } {
  const role = hubRole(root);
  if (role.mode !== "hub") throw new HubError("only the hub ingests ops");
  const out = { received: {} as Record<string, number>, refused: {} as Record<string, string> };
  const have = new Set([...opFiles(root).map((f) => `${f.replica}-${f.id}`), ...appliedIds(root)]);
  const added: string[] = [];
  for (const ref of lines(run(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/inbound/"]).out)) {
    const [name, sha] = ref.split(" ");
    const r = name.slice("refs/heads/inbound/".length);
    const spec = role.cfg.replicas[r];
    const commits = lines(run(root, ["rev-list", "--reverse", `HEAD..${sha}`]).out);
    let why = !spec ? `${r} isn't a replica in rules/hub.yaml` : "";
    for (const c of why ? [] : commits) {
      const parent = lines(run(root, ["rev-list", "--parents", "-n", "1", c]).out)[0]?.split(" ")[1];
      if (signingRequired(role.cfg) && signerOf(root, c, role.cfg) !== r) { why = `${c.slice(0, 8)} isn't signed by ${r}'s key`; break; }
      const ch = changes(root, c, parent);
      const bad = ch.find((x) => x.status !== "A" || !x.path.startsWith(`ops/${r}/`));
      if (bad) { why = `${c.slice(0, 8)} touches ${bad.path}, outside ops/${r}/`; break; }
    }
    if (why) { out.refused[r] = why; hubAlert(root, "inbound_refused", `${r}: ${why}`); }
    else {
      let n = 0;
      for (const p of lines(run(root, ["ls-tree", "-r", "--name-only", sha, `ops/${r}/`]).out)) {
        const id = p.split("/").pop()!.replace(/\.json$/, "");
        if (have.has(`${r}-${id}`) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) continue;
        mkdirSync(join(root, "ops", r), { recursive: true });
        writeFileSync(join(root, p), run(root, ["show", `${sha}:${p}`]).out + "\n");
        added.push(p); have.add(`${r}-${id}`); n++;
      }
      out.received[r] = n;
    }
    run(root, ["update-ref", "-d", name, sha]); // only if nobody pushed again meanwhile
  }
  if (added.length) {
    run(root, ["add", "--", ...added]);
    gitCommit(root, [`hub: received ${added.length} op(s) from ${Object.keys(out.received).filter((k) => out.received[k]).join(", ")}`, "Each from commits signed by that replica's key."], "hub");
  }
  return out;
}

// ---------- sync: a replica sends its ops and follows the hub ----------

function fetchMain(root: string, url: string, into: string): boolean {
  return run(root, ["fetch", "-q", url, `+refs/heads/main:${into}`], { timeoutMs: 20000 }).code === 0;
}

// Finds the newest hub: tries the hub this clone knows; if it's unreachable, asks the other
// replicas, and follows any of them that knows a higher epoch to the hub it names.
function findHub(root: string, cfg: HubConfig, me: string, from?: string): { url: string; ref: string; cfg: HubConfig } | { error: string } {
  const ref = "refs/pocketbrain/hub";
  const tried: string[] = [];
  const tryUrl = (url: string | undefined) => {
    if (!url || tried.includes(url)) return undefined;
    tried.push(url);
    if (!fetchMain(root, url, ref)) return undefined;
    const c = hubAt(root, ref);
    return c ? { url, ref, cfg: c } : undefined;
  };
  if (from) return tryUrl(from) ?? { error: `couldn't fetch ${from}` };
  let best = cfg.hub === me ? undefined : tryUrl(cfg.replicas[cfg.hub]?.git);
  if (best && best.cfg.hub === cfg.hub && best.cfg.epoch >= cfg.epoch) return best;
  for (const [n, r] of Object.entries(cfg.replicas)) {
    if (n === me || n === cfg.hub) continue;
    const peer = tryUrl(r.git);
    if (!peer || peer.cfg.epoch <= (best?.cfg.epoch ?? cfg.epoch)) continue;
    // The peer knows a newer hub. Fetch from that hub itself when possible.
    const hub = peer.cfg.hub === n ? peer : tryUrl(peer.cfg.replicas[peer.cfg.hub]?.git);
    if (hub) best = hub;
  }
  return best ?? { error: `hub ${cfg.hub} unreachable at ${cfg.replicas[cfg.hub]?.git ?? "(no git address in rules/hub.yaml)"}, and no replica knows a newer one` };
}

export interface SyncResult {
  role: "hub" | "replica";
  hub: string;
  epoch: number;
  fetched?: string;
  pushed: number;
  orphaned?: string; // branch holding commits this clone made as hub after it was replaced
  ingest?: ReturnType<typeof ingest>;
  replay?: ReplayResult;
  problems: string[];
}

// On a replica: fetch the hub's main, verify it, park anything this clone committed that the
// hub doesn't have (it was hub and got replaced), move to the hub's main, re-queue this clone's
// ops the hub hasn't seen, and push them to the hub's inbound/<me>.
// On the hub: check no replica knows a newer epoch (if one does, this clone steps down and
// syncs as a replica), then ingest and replay.
export function sync(root: string, opts: { from?: string; push?: boolean } = {}): SyncResult {
  const role = hubRole(root);
  if (role.mode === "single") throw new HubError("no rules/hub.yaml: this brain is one machine. Start hub mode with: pocketbrain hub init --name <machine>");
  if (role.mode === "unnamed") throw new HubError("this clone has no replica name; run pocketbrain hub init --name <machine>");
  const me = role.name!;
  const cfg = role.cfg;
  if (role.mode === "hub") {
    const newer = findNewerEpoch(root, cfg, me);
    if (!newer) {
      const ing = ingest(root);
      return { role: "hub", hub: me, epoch: cfg.epoch, pushed: 0, ingest: ing, replay: replay(root), problems: [] };
    }
    // Someone was promoted while this clone thought it was hub: step down.
  }
  // log/ is per machine (alerts, write log); the hub's copy wins.
  if (lines(run(root, ["status", "--porcelain", "--untracked-files=no"]).out).filter((l) => !l.slice(3).startsWith("log/")).length)
    throw new HubError("uncommitted changes to tracked files; commit or discard them before syncing");
  const found = findHub(root, cfg, me, opts.from);
  if ("error" in found) return { role: "replica", hub: cfg.hub, epoch: cfg.epoch, pushed: 0, problems: [found.error] };
  if (found.cfg.epoch < cfg.epoch) return { role: "replica", hub: cfg.hub, epoch: cfg.epoch, pushed: 0, problems: [`${found.url} is stale: it names ${found.cfg.hub} at epoch ${found.cfg.epoch}; this clone knows epoch ${cfg.epoch}`] };
  const base = run(root, ["merge-base", "HEAD", found.ref]).out;
  const v = verifyHistory(root, base || undefined, found.ref);
  if (v.problems.length) { hubAlert(root, "history_unverified", `${found.url}: ${v.problems[0]}`); return { role: "replica", hub: found.cfg.hub, epoch: found.cfg.epoch, pushed: 0, problems: v.problems }; }

  // This clone's own commits the hub doesn't have: ops are re-queued; anything else is parked.
  const mine = lines(run(root, ["rev-list", "--reverse", base ? `${base}..HEAD` : "HEAD"]).out);
  const pending = new Map<string, string>(); // path -> content
  let foreign = false;
  for (const c of mine) {
    const parent = lines(run(root, ["rev-list", "--parents", "-n", "1", c]).out)[0]?.split(" ")[1];
    const ch = changes(root, c, parent);
    if (!ch.every((x) => x.status === "A" && x.path.startsWith(`ops/${me}/`))) foreign = true;
  }
  const result: SyncResult = { role: "replica", hub: found.cfg.hub, epoch: found.cfg.epoch, fetched: found.url, pushed: 0, problems: [] };
  if (foreign) {
    const branch = `orphaned/${today()}-${run(root, ["rev-parse", "--short", "HEAD"]).out}`;
    run(root, ["branch", "-f", branch, "HEAD"]);
    result.orphaned = branch;
    result.problems.push(`commits made here that ${found.cfg.hub} doesn't have are kept on branch ${branch}; the owner decides what to redo`);
    hubAlert(root, "orphaned_commits", `${me}: ${branch}`);
  }
  const theirs = new Set(lines(run(root, ["ls-tree", "-r", "--name-only", found.ref, "ops/"]).out).map((p) => {
    const f = p.split("/").pop()!.replace(/\.json$/, "");
    return p.startsWith("ops/applied/") ? f : `${p.split("/")[1]}-${f}`;
  }));
  for (const f of opFiles(root)) if (f.replica === me && !theirs.has(`${me}-${f.id}`)) pending.set(f.rel, readFileSync(join(root, f.rel), "utf8"));

  run(root, ["reset", "-q", "--hard", found.ref]);
  writeFileSync(MARK(root), run(root, ["rev-parse", "HEAD"]).out + "\n");
  if (pending.size) {
    for (const [p, text] of pending) { mkdirSync(join(root, dirname(p)), { recursive: true }); writeFileSync(join(root, p), text); }
    run(root, ["add", "--", ...pending.keys()]);
    gitCommit(root, [`op(${me}): ${pending.size} queued op(s)`], me, [...pending.keys()]);
    if (opts.push === false) return result;
    const p = run(root, ["push", "-q", "--force", found.url, `HEAD:refs/heads/inbound/${me}`], { timeoutMs: 20000 });
    if (p.code === 0) result.pushed = pending.size;
    else result.problems.push(`couldn't push ${pending.size} op(s) to ${found.url}: ${p.err.split("\n")[0]}`);
  }
  return result;
}

function findNewerEpoch(root: string, cfg: HubConfig, me: string): HubConfig | undefined {
  for (const [n, r] of Object.entries(cfg.replicas)) {
    if (n === me || !r.git) continue;
    if (!fetchMain(root, r.git, `refs/pocketbrain/peers/${n}`)) continue;
    const c = hubAt(root, `refs/pocketbrain/peers/${n}`);
    if (c && c.epoch > cfg.epoch) return c;
  }
  return undefined;
}

// ---------- init, add-replica, promote ----------

// ssh-keygen signs commits (unless another signer is set) and always verifies them.
export function hasSshKeygen(): boolean {
  return !!Bun.which("ssh-keygen");
}

function pubKeyOf(keyFile: string): string {
  const pub = existsSync(keyFile + ".pub") ? readFileSync(keyFile + ".pub", "utf8") : "";
  if (pub) return pub.trim();
  const r = Bun.spawnSync(["ssh-keygen", "-y", "-f", keyFile]);
  if (r.exitCode !== 0) throw new HubError(`can't read the public half of ${keyFile}`);
  return r.stdout.toString().trim();
}

function saveHub(root: string, cfg: HubConfig, header?: string) {
  const f = join(root, HUB_FILE);
  const keep = existsSync(f) ? YAML.parseDocument(readFileSync(f, "utf8")) : undefined;
  const doc = keep ?? new YAML.Document({});
  if (!keep && header) doc.commentBefore = header;
  for (const [k, v] of Object.entries(cfg)) if (v !== undefined) doc.set(k, doc.createNode(v));
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, doc.toString({ lineWidth: 0 }));
}

const HEADER = ` One hub at a time (portability.md 7.4). Only the owner edits this file.
 hub: the clone that commits. Every other clone queues writes in ops/<name>/ and syncs.
 epoch: goes up by one on each "pocketbrain hub promote"; a clone never follows a lower one.
 replicas.<name>.signing_key: that machine's SSH signing key (public half). Commits must be
 signed by a key listed here; a replica's key only vouches for its own op files.`;

// Names this clone, sets up its signing key, and (if the brain has no hub yet) makes it the hub.
// o.signer: the program git signs with (default ssh-keygen with the key file; 1Password users
// pass op-ssh-sign and the public key instead).
export function init(root: string, o: { name: string; key?: string; git?: string; publicUrl?: string; signer?: string }): string[] {
  const say: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(o.name)) throw new HubError("replica name: lowercase letters, digits and dashes");
  run(root, ["config", "--local", "pocketbrain.replica", o.name]);
  let pub: string | undefined;
  if (o.key) {
    if (!hasSshKeygen()) throw new HubError("signed commits need ssh-keygen; install openssh-client (it ships with macOS)");
    pub = pubKeyOf(o.key);
    run(root, ["config", "--local", "gpg.format", "ssh"]);
    run(root, ["config", "--local", "gpg.ssh.program", o.signer ?? "ssh-keygen"]);
    run(root, ["config", "--local", "user.signingkey", o.key]);
    run(root, ["config", "--local", "commit.gpgsign", "true"]);
    say.push(`${o.name} signs every commit with ${o.key}`);
  }
  const cfg = loadHub(root);
  if (!cfg) {
    const fresh: HubConfig = { hub: o.name, epoch: 1, since: today(), replicas: { [o.name]: { ...(pub ? { signing_key: pub } : {}), ...(o.git ? { git: o.git } : {}) } }, ...(o.publicUrl ? { public_url: o.publicUrl } : {}) };
    saveHub(root, fresh, HEADER);
    run(root, ["add", HUB_FILE]);
    asPromotion(() => gitCommit(root, [`owner: hub mode, ${o.name} is the hub (epoch 1)`], OWNER, [HUB_FILE]));
    writeFileSync(MARK(root), run(root, ["rev-parse", "HEAD"]).out + "\n");
    say.push(`rules/hub.yaml created: ${o.name} is the hub, epoch 1`);
  } else if (!cfg.replicas[o.name] || (pub && cfg.replicas[o.name].signing_key !== pub)) {
    say.push(`${o.name} isn't listed in rules/hub.yaml with this key yet. On the hub (${cfg.hub}), the owner runs:`);
    say.push(`  pocketbrain hub add-replica ${o.name}${pub ? ` --pub "${pub}"` : ""}${o.git ? ` --git ${o.git}` : ""}`);
    say.push(`then here: pocketbrain hub sync`);
  } else say.push(`${o.name} is in rules/hub.yaml as ${cfg.hub === o.name ? "the hub" : "a replica"} (epoch ${cfg.epoch})`);
  return say;
}

// The public door: the address agents hold and the tunnel that serves it (src/door.ts).
export function setDoor(root: string, door: { public_url: string; tunnel: NonNullable<HubConfig["tunnel"]> }): string {
  const cfg = loadHub(root);
  if (!cfg) throw new HubError("no rules/hub.yaml yet; start with pocketbrain hub init --name <machine>");
  const role = hubRole(root);
  if (role.mode !== "hub") throw new HubError(`change the door on the hub (${cfg.hub})`);
  if (cfg.public_url === door.public_url && JSON.stringify(cfg.tunnel) === JSON.stringify(door.tunnel)) return `rules/hub.yaml already has ${door.public_url}`;
  saveHub(root, { ...cfg, ...door });
  run(root, ["add", HUB_FILE]);
  gitCommit(root, [`owner: public door ${door.public_url}`], OWNER, [HUB_FILE]);
  return `rules/hub.yaml: public_url ${door.public_url}, tunnel ${door.tunnel.name}`;
}

export function addReplica(root: string, name: string, spec: ReplicaSpec): string {
  const role = hubRole(root);
  if (role.mode !== "hub") throw new HubError("run add-replica on the hub");
  const cfg = role.cfg;
  cfg.replicas[name] = { ...cfg.replicas[name], ...spec };
  saveHub(root, cfg);
  run(root, ["add", HUB_FILE]);
  gitCommit(root, [`owner: replica ${name} added to rules/hub.yaml`], OWNER, [HUB_FILE]);
  return `${name} added; it can sync now`;
}

export interface PromoteResult { from: string; to: string; epoch: number; verified: number; replay: ReplayResult; ingest?: ReturnType<typeof ingest>; next: string[]; problems: string[] }

// pocketbrain hub promote <me>: run on the clone that becomes the hub.
// 1. pull what's reachable and verify the history and the write log; 2. bump the epoch in
// rules/hub.yaml naming this clone, signed; 3. ingest and replay every queued op;
// 4. print what Louis does outside the repo (tunnel/DNS, deploy key, start the server).
export function promote(root: string, name: string, opts: { from?: string; force?: boolean } = {}): PromoteResult {
  const role = hubRole(root);
  if (role.mode === "single") throw new HubError("no rules/hub.yaml yet; start with pocketbrain hub init --name <machine>");
  if (role.mode === "unnamed" || role.name !== name) throw new HubError(`run promote on ${name} itself (this clone is ${role.mode === "unnamed" ? "unnamed" : role.name})`);
  if (role.mode === "hub") throw new HubError(`${name} is already the hub (epoch ${role.cfg.epoch})`);
  if (role.cfg.replicas[name]?.can_be_hub === false) throw new HubError(`rules/hub.yaml says ${name} can't be hub`);
  const problems: string[] = [];
  // 1. Catch up with whatever is reachable. An unreachable hub is the normal case here.
  // Its ops stay here (this clone applies them in a moment), so nothing is pushed to the old hub.
  const s = sync(root, { from: opts.from, push: false });
  problems.push(...s.problems.filter((p) => !/unreachable|couldn't fetch|couldn't push/.test(p)));
  const unreachable = s.problems.find((p) => /unreachable|couldn't fetch/.test(p));
  const cfg = loadHub(root)!;
  if (cfg.hub === name) throw new HubError(`${name} is already the hub (epoch ${cfg.epoch})`);
  const v = verifyNew(root);
  const log = verifyWriteLog(root);
  problems.push(...v.problems, ...log.problems.map((p) => `log/writes.jsonl ${p}`));
  if (problems.length && !opts.force) throw new HubError(`not promoting, the history doesn't check out:\n  ${problems.join("\n  ")}\n(--force promotes anyway; the owner's call)`);
  // 2. The epoch bump. Signed by this machine's key; the old hub refuses to commit once it sees it.
  const old = cfg.hub;
  const next: HubConfig = { ...cfg, hub: name, epoch: cfg.epoch + 1, since: today(), previous: old };
  saveHub(root, next);
  run(root, ["add", HUB_FILE]);
  asPromotion(() => gitCommit(root, [`owner: promote ${name} to hub (epoch ${next.epoch}, was ${old})`], OWNER, [HUB_FILE]));
  writeFileSync(MARK(root), run(root, ["rev-parse", "HEAD"]).out + "\n");
  // 3. Everything queued, including this clone's own ops from when it was a replica.
  const ing = ingest(root);
  const rep = replay(root);
  // 4. What only Louis can do.
  const host = next.public_url ? new URL(next.public_url).host : "brain.<your domain>";
  const t = next.tunnel ?? {};
  const say = [
    t.kind === "funnel"
      ? `public door: on ${name}, run "tailscale funnel --bg ${next.port ?? 8787}", then give agents the new *.ts.net address (stopgap; the address changes with the machine)`
      : `public door: on ${name}, run "cloudflared tunnel route dns ${t.name ?? "<tunnel>"} ${host}" and start the tunnel with the ingress from "pocketbrain hub tunnel-config"; agent configs keep ${next.public_url ?? "their URL"}`,
    `start the server here: pocketbrain serve${next.port ? ` --port ${next.port}` : ""}`,
    `GitHub: make ${name}'s deploy key the only one allowed to push main`,
    unreachable ? `${old} was unreachable; when it comes back, "pocketbrain hub sync" there makes it a replica (anything it wrote meanwhile is parked on an orphaned/ branch)` : `${old} becomes a replica at its next sync or server tick`,
    `other replicas find ${name} at their next "pocketbrain hub sync"${next.replicas[name]?.git ? "" : ` once rules/hub.yaml lists ${name}'s git address`}`,
  ];
  return { from: old, to: name, epoch: next.epoch, verified: v.checked, replay: rep, ingest: ing, next: say, problems };
}

// The paths the tunnel forwards: the agent API, the browser door and the OAuth metadata, nothing else.
export const AGENT_INGRESS_PATH = String.raw`^/(mcp(/.*)?|v1/.*|b(/.*)?|health|openapi\.json|\.well-known/oauth-protected-resource/mcp/oauth)$`;

// The cloudflared ingress that exposes only what agents need (portability 7.9).
export function tunnelConfig(root: string): string {
  const cfg = loadHub(root);
  const host = cfg?.public_url ? new URL(cfg.public_url).host : "brain.example.com";
  return `# ~/.cloudflared/config.yml on the hub. Only the agent API goes out; the dashboard never does.
tunnel: ${cfg?.tunnel?.name ?? "pocketbrain"}
credentials-file: ~/.cloudflared/${cfg?.tunnel?.name ?? "pocketbrain"}.json
ingress:
  - hostname: ${host}
    path: ${AGENT_INGRESS_PATH}
    service: http://127.0.0.1:${cfg?.port ?? 8787}
  - service: http_status:404
`;
}

// One server tick on the hub: catch a newer epoch, take inbound ops, apply them.
export function tick(root: string): SyncResult | undefined {
  const role = hubRole(root);
  if (role.mode === "single" || role.mode === "unnamed") return undefined;
  return sync(root);
}
