// SPDX-License-Identifier: AGPL-3.0-only
// Backups (backup-recovery.md 3 and 5): the backup file leaves the hub only age-encrypted.
// Separately, with push_origin: true in rules/backup.yaml the hub pushes main in plain git to the
// brain's origin remote every hour (pushOriginApart, below): that copy is NOT encrypted, so origin
// must be a private repository the owner controls (outside review 2026-10-25).
//   backup   git bundle of every ref + the untracked state git doesn't carry (read log, alerts,
//            sleep state, text channel state), a manifest with hashes, tar, encrypted to the
//            public key(s) in rules/backup.pub, written as a dated file into a folder Louis's
//            storage service syncs. The private key never touches the hub.
//   rotate   every file for keep_daily days, the first of each month for keep_monthly months.
//   restore  decrypt with the key from 1Password, check every hash, rebuild the repo and its
//            state in an empty folder, rename the clone, rebuild views, run doctor.
//   drill    copy the brain, back the copy up, wipe it, restore it, diff before and after.
// Views, cells and node_modules are rebuilt, never backed up. Plaintext secrets never go in.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { sha256 } from "./util";
import { hardSecretIn } from "./checks";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { loadBrain, today, isList } from "./brain";
import { loadRules } from "./rules";
import { carve, grantFor } from "./carve";
import { buildView } from "./view";
import { formatProblem } from "./format";
import { git } from "./git";
import * as hub from "./hub";
import { doctor, finding, type Finding } from "./doctor";
import type { OwnerErrorId, Vars } from "./owner-errors";
import { beat } from "./heartbeat";

export class BackupError extends Error {}

export interface BackupConfig {
  dest?: string; // the synced folder, e.g. ~/Library/CloudStorage/<service>/pocketbrain-backups
  recipients?: string; // file of age public keys, one per line (default rules/backup.pub)
  every_hours?: number; // a scheduled backup runs when main moved and this long passed (default 24)
  keep_daily?: number; // keep every file this many days (default 30)
  keep_monthly?: number | "all"; // and the first file of each month for this many months (default all)
  push_origin?: boolean; // the hub pushes main to the brain's origin remote every hour (docs/backup.md)
}

const CONFIG = "rules/backup.yaml";
const LAST = "log/last-backup";
const FORMAT = "pocketbrain-backup/1";
// Rebuilt from main, never backed up.
const DERIVED = [/^views\//, /^\.cells\//, /^node_modules\//, /(^|\/)\.DS_Store$/];
// Never in a backup, whatever the folder: private keys and credential files by name.
const SECRET_NAMES = [/(^|\/)\.env(\..*)?$/, /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, /\.(pem|key|p12|pfx)$/, /(^|\/)(age-)?identity(\.txt)?$/, /(^|\/)\.netrc$/];
// Plaintext secrets by content, the same list the write path refuses (src/checks.ts), so a write
// that passes never stops a backup. Hashes of tokens (rules/tokens.yaml) don't match these.
export function secretIn(text: string): string | undefined {
  return hardSecretIn(text);
}

const expand = (p: string) => p.replace(/^~(?=$|\/)/, homedir());

interface Run { code: number; out: string; err: string }
function run(cmd: string[], opts: { cwd?: string; stdin?: Buffer | string } = {}): Run {
  const r = Bun.spawnSync(cmd, { cwd: opts.cwd, stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin), env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
const g = (root: string, ...args: string[]) => run(["git", ...args], { cwd: root });

export function loadBackupConfig(root: string): BackupConfig | undefined {
  const f = join(root, CONFIG);
  return existsSync(f) ? ((YAML.parse(readFileSync(f, "utf8")) as BackupConfig | null) ?? {}) : undefined;
}

export const CONFIG_TEMPLATE = `# Backups (docs/backup.md). Only the owner edits this file.
# dest: the folder your storage service's desktop app syncs. Each machine may override it with
# PB_BACKUP_DEST, so the path can differ between the hub and a stand-in.
dest: ~/pocketbrain-backups
recipients: rules/backup.pub   # age public keys (age1...), one per line; the private key lives in your password manager
every_hours: 24                # the hub backs up when main moved and this long passed
keep_daily: 30                 # every file for 30 days
keep_monthly: all              # then the first file of each month, forever
# push_origin: true            # the hub also pushes main to the brain's git origin every hour
`;

// The age public keys backups are encrypted to. A private key here is a FAIL, not a warning.
export function recipients(root: string, cfg: BackupConfig): string[] {
  const f = join(root, cfg.recipients ?? "rules/backup.pub");
  if (!existsSync(f)) throw new BackupError(`no recipients file ${relative(root, f)}; put your age public key (age1...) there. The private key goes in your password manager, never in the brain`);
  const text = readFileSync(f, "utf8");
  if (secretIn(text)) throw new BackupError(`${relative(root, f)} holds a private key. Move it to your password manager now, delete it here, and treat it as exposed (generate a new pair)`);
  const keys = text.split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
  const bad = keys.filter((k) => !/^(age1[0-9a-z]{58}|ssh-(ed25519|rsa) \S+)/.test(k));
  if (bad.length) throw new BackupError(`${relative(root, f)}: not an age or ssh public key: ${bad[0].slice(0, 20)}…`);
  if (!keys.length) throw new BackupError(`${relative(root, f)} is empty`);
  return keys;
}

export function destOf(root: string, cfg: BackupConfig | undefined, override?: string): string {
  const d = override ?? process.env.PB_BACKUP_DEST ?? cfg?.dest;
  if (!d) throw new BackupError(`no backup folder: set dest in ${CONFIG} or pass --dest`);
  const abs = resolve(root, expand(d));
  const rel = relative(resolve(root), abs);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new BackupError(`the backup folder ${abs} is inside the brain; pick a folder outside it`);
  return abs;
}

// ---------- what goes in ----------

export interface Extra { path: string; sha256: string; bytes: number }
export interface Skipped { path: string; reason: string }

// Untracked files git doesn't carry, minus derived output and anything secret.
function collectExtras(root: string): { extras: string[]; skipped: Skipped[] } {
  const listed = g(root, "ls-files", "-z", "--others").out.split("\0").filter(Boolean);
  const extras: string[] = [], skipped: Skipped[] = [];
  for (const p of listed.sort()) {
    if (DERIVED.some((r) => r.test(p))) continue;
    if (SECRET_NAMES.some((r) => r.test(p))) { skipped.push({ path: p, reason: "credential file" }); continue; }
    const st = statSync(join(root, p), { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    const s = secretIn(readFileSync(join(root, p), "utf8"));
    if (s) { skipped.push({ path: p, reason: `holds ${s}` }); continue; }
    extras.push(p);
  }
  return { extras, skipped };
}

// Plaintext secrets committed to main stop the backup: rotate and scrub first (backup-recovery 4.5).
function committedSecrets(root: string): string[] {
  const found: string[] = [];
  for (const p of g(root, "ls-files", "-z").out.split("\0").filter(Boolean)) {
    if (SECRET_NAMES.some((r) => r.test(p))) { found.push(`${p} (credential file)`); continue; }
    const st = statSync(join(root, p), { throwIfNoEntry: false });
    if (!st?.isFile() || st.size > 5_000_000) continue;
    const s = secretIn(readFileSync(join(root, p), "utf8"));
    if (s) found.push(`${p} (${s})`);
  }
  return found;
}

export interface Manifest {
  format: string;
  created: string;
  head: string;
  branch: string;
  refs: Record<string, string>;
  replica?: string;
  hub?: { hub: string; epoch: number };
  bundle_sha256: string;
  extras: Extra[];
  skipped: Skipped[];
  uncommitted: string[];
}

function refsOf(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of g(root, "show-ref").out.split("\n").filter(Boolean)) { const [sha, ref] = l.split(" "); out[ref] = sha; }
  return out;
}
// The refs a bundle itself holds, so the manifest says what was packed, not what the brain held a
// moment later: the hourly push to origin runs beside the hourly backup and moves the tracking ref
// in between (G738).
function bundleRefs(root: string, bundle: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of g(root, "bundle", "list-heads", bundle).out.split("\n").filter(Boolean)) { const [sha, ref] = l.split(" "); if (ref && ref !== "HEAD") out[ref] = sha; }
  return out;
}
// A remote-tracking ref is the brain's note of where its origin was, not part of the brain.
const tracking = (ref: string) => ref.startsWith("refs/remotes/");

export interface BackupResult { file: string; bytes: number; sha256: string; head: string; extras: number; skipped: Skipped[]; uncommitted: string[]; deleted: string[]; recorded: boolean }

export function backup(root: string, o: { dest?: string; recipients?: string[]; now?: Date; record?: boolean; rotate?: boolean } = {}): BackupResult {
  if (!existsSync(join(root, ".git"))) throw new BackupError(`${root} isn't a git repo; nothing to back up`);
  if (!Bun.which("age")) throw new BackupError("age isn't installed (brew install age, or apt install age)");
  const cfg = loadBackupConfig(root) ?? {};
  const keys = o.recipients ?? recipients(root, cfg);
  const dest = destOf(root, cfg, o.dest);
  const leaks = committedSecrets(root);
  if (leaks.length) throw new BackupError(`main holds plaintext secrets, so no backup was made: ${leaks.slice(0, 3).join("; ")}. Rotate them, then scrub history (backup-recovery.md 4.5)`);
  const now = o.now ?? new Date();

  const stage = mkdtempSync(join(tmpdir(), "pb-backup-"));
  try {
    const b = g(root, "bundle", "create", join(stage, "repo.bundle"), "--all");
    if (b.code !== 0) throw new BackupError(`git bundle: ${b.err}`);
    const { extras, skipped } = collectExtras(root);
    const ex: Extra[] = [];
    for (const p of extras) {
      const buf = readFileSync(join(root, p));
      mkdirSync(dirname(join(stage, "files", p)), { recursive: true });
      writeFileSync(join(stage, "files", p), buf);
      ex.push({ path: p, sha256: sha256(buf), bytes: buf.length });
    }
    const cfgHub = hub.loadHub(root);
    const manifest: Manifest = {
      format: FORMAT,
      created: now.toISOString(),
      head: g(root, "rev-parse", "HEAD").out,
      branch: g(root, "symbolic-ref", "--short", "HEAD").out || "main",
      refs: bundleRefs(root, join(stage, "repo.bundle")),
      replica: hub.replicaName(root),
      ...(cfgHub ? { hub: { hub: cfgHub.hub, epoch: cfgHub.epoch } } : {}),
      bundle_sha256: sha256(readFileSync(join(stage, "repo.bundle"))),
      extras: ex,
      skipped,
      uncommitted: g(root, "status", "--porcelain", "--untracked-files=no").out.split("\n").filter(Boolean).map((l) => l.slice(3)),
    };
    writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 1));

    // tar | age, into a .partial that is renamed only once complete.
    mkdirSync(dest, { recursive: true });
    const tar = Bun.spawnSync(["tar", "-cf", "-", "-C", stage, "."]);
    if (tar.exitCode !== 0) throw new BackupError(`tar: ${tar.stderr.toString()}`);
    let name = `brain-${today()}.tar.age`;
    for (let i = 2; existsSync(join(dest, name)); i++) name = `brain-${today()}-${i}.tar.age`;
    const partial = join(dest, `.${name}.partial`);
    const age = Bun.spawnSync(["age", ...keys.flatMap((k) => ["-r", k]), "-o", partial], { stdin: tar.stdout });
    if (age.exitCode !== 0) { rmSync(partial, { force: true }); throw new BackupError(`age: ${age.stderr.toString().trim()}`); }
    renameSync(partial, join(dest, name));
    const enc = readFileSync(join(dest, name));
    const res: BackupResult = { file: join(dest, name), bytes: enc.length, sha256: sha256(enc), head: manifest.head, extras: ex.length, skipped, uncommitted: manifest.uncommitted, deleted: [], recorded: false };

    if (o.rotate !== false) res.deleted = rotate(dest, cfg, today());
    if (o.record !== false) res.recorded = record(root, { at: now.toISOString(), file: name, head: manifest.head, sha256: res.sha256, bytes: res.bytes });
    return res;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// log/last-backup: one line, committed on the hub so a GitHub Action can check freshness
// without ever seeing a backup (backup-recovery 5). A replica only keeps it locally.
interface LastBackup { at: string; file: string; head: string; sha256: string; bytes: number }
function record(root: string, e: LastBackup): boolean {
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, LAST), JSON.stringify(e) + "\n");
  const role = hub.hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") return false;
  git(root, ["add", LAST]);
  git(root, ["commit", "-q", "-m", `backup: ${e.file}`, "--", LAST], "backup");
  return true;
}

export function lastBackup(root: string): LastBackup | undefined {
  const f = join(root, LAST);
  if (!existsSync(f)) return undefined;
  try { return JSON.parse(readFileSync(f, "utf8").trim()) as LastBackup; } catch { return undefined; }
}

// Due when there's no backup yet, or main moved (other than log/last-backup) and every_hours passed.
export function due(root: string, now = new Date()): { due: boolean; why: string } {
  const cfg = loadBackupConfig(root);
  if (!cfg) return { due: false, why: `no ${CONFIG}` };
  const last = lastBackup(root);
  if (!last) return { due: true, why: "no backup yet" };
  const hours = (now.getTime() - Date.parse(last.at)) / 3600000;
  const moved = g(root, "diff", "--quiet", last.head, "HEAD", "--", ".", `:(exclude)${LAST}`).code !== 0;
  if (!moved) return { due: false, why: `main hasn't moved since ${last.at.slice(0, 16)}` };
  if (hours < (cfg.every_hours ?? 24)) return { due: false, why: `last backup ${hours.toFixed(1)}h ago` };
  return { due: true, why: `main moved and the last backup is ${hours.toFixed(1)}h old` };
}

// The hub's scheduled run: back up if due. Replicas leave it to the hub.
export function scheduled(root: string, now = new Date()): BackupResult | undefined {
  const role = hub.hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") return undefined;
  return due(root, now).due ? backup(root, { now }) : undefined;
}

// ---------- rotation ----------

const NAME = /^brain-(\d{4})-(\d{2})-(\d{2})(?:-\d+)?\.tar\.age$/;

// Keeps every file from the last keep_daily days, the first file of each month for keep_monthly
// months, and always the newest. Deletes nothing it didn't name itself.
export function rotate(dest: string, cfg: BackupConfig, day = today()): string[] {
  if (!existsSync(dest)) return [];
  const files = readdirSync(dest).filter((f) => NAME.test(f)).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  if (!files.length) return [];
  const t = Date.parse(day);
  const daily = cfg.keep_daily ?? 30, monthly = cfg.keep_monthly ?? "all";
  const keep = new Set<string>([files[files.length - 1]]);
  const firstOfMonth = new Map<string, string>();
  for (const f of files) {
    const [, y, m, d] = f.match(NAME)!;
    if ((t - Date.parse(`${y}-${m}-${d}`)) / 86400000 < daily) keep.add(f);
    if (!firstOfMonth.has(`${y}-${m}`)) firstOfMonth.set(`${y}-${m}`, f);
  }
  const [ty, tm] = day.split("-").map(Number);
  for (const [ym, f] of firstOfMonth) {
    const [y, m] = ym.split("-").map(Number);
    const monthsAgo = (ty - y) * 12 + (tm - m);
    if (monthly === "all" || monthsAgo < monthly) keep.add(f);
  }
  const deleted: string[] = [];
  for (const f of files) if (!keep.has(f)) { unlinkSync(join(dest, f)); deleted.push(f); }
  // Leftovers of a run that died mid-write.
  for (const f of readdirSync(dest)) if (/^\.brain-.*\.partial$/.test(f) && Date.now() - statSync(join(dest, f)).mtimeMs > 86400000) unlinkSync(join(dest, f));
  return deleted;
}
function order(f: string): number {
  const m = f.match(/^brain-(\d{4}-\d{2}-\d{2})(?:-(\d+))?/)!;
  return Date.parse(m[1]) + Number(m[2] ?? 1);
}

export function newestBackup(dest: string): string | undefined {
  if (!existsSync(dest)) return undefined;
  const files = readdirSync(dest).filter((f) => NAME.test(f)).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  return files.length ? join(dest, files[files.length - 1]) : undefined;
}

// ---------- restore ----------

// The identity is read by this process (a file, "-" for stdin, or a <(op read ...) pipe) and
// handed to age on its stdin, so the private key is never written to disk.
// A pipe can be read only once, so callers that decrypt twice read it first and pass { text }.
export type Identity = string | { text: string };
export function readIdentity(identity: Identity): string {
  try {
    const text = typeof identity !== "string" ? identity.text : identity === "-" ? readFileSync(0, "utf8") : readFileSync(expand(identity), "utf8");
    if (!/AGE-SECRET-KEY-1|PRIVATE KEY/.test(text)) throw new BackupError("that isn't an age identity (expected a line starting AGE-SECRET-KEY-1)");
    return text;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(`can't read the identity: ${(e as Error).message}`);
  }
}

export function decrypt(file: string, identity: Identity, into: string): Manifest {
  if (!existsSync(file)) throw new BackupError(`no such backup: ${file}`);
  const age = Bun.spawnSync(["age", "-d", "-i", "-", file], { stdin: Buffer.from(readIdentity(identity)) });
  if (age.exitCode !== 0) throw new BackupError(`can't decrypt ${file}: ${age.stderr.toString().trim()}. Is this the key from your password manager that matches rules/backup.pub?`);
  mkdirSync(into, { recursive: true });
  const tar = Bun.spawnSync(["tar", "-xf", "-", "-C", into], { stdin: age.stdout });
  if (tar.exitCode !== 0) throw new BackupError(`the backup is damaged (tar: ${tar.stderr.toString().trim()})`);
  const m = JSON.parse(readFileSync(join(into, "manifest.json"), "utf8")) as Manifest;
  if (m.format !== FORMAT) throw new BackupError(`unknown backup format ${m.format}`);
  return m;
}

// Every hash in the manifest, and nothing outside it. Only plain files and folders: a link in a
// backup (anyone with the public key can pack one) would let later writes land outside the brain.
function checkPayload(stage: string, m: Manifest): string[] {
  const problems: string[] = [];
  for (const p of linksIn(stage)) problems.push(`${p}: not a plain file (a link or a device)`);
  if (problems.length) return problems;
  if (sha256(readFileSync(join(stage, "repo.bundle"))) !== m.bundle_sha256) problems.push("repo.bundle doesn't match its hash");
  for (const e of m.extras) {
    if (!safeRel(e.path)) { problems.push(`${e.path}: unsafe path`); continue; }
    const f = join(stage, "files", e.path);
    if (!existsSync(f)) problems.push(`${e.path}: missing`);
    else if (sha256(readFileSync(f)) !== e.sha256) problems.push(`${e.path}: doesn't match its hash`);
  }
  const listed = new Set(m.extras.map((e) => e.path));
  for (const p of walk(join(stage, "files"))) if (!listed.has(p)) problems.push(`${p}: not in the manifest`);
  return problems;
}
function linksIn(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? linksIn(dir, r) : e.isFile() ? [] : [r];
  });
}
const safeRel = (p: string) => !isAbsolute(p) && !p.split("/").includes("..") && !p.startsWith(".git/") && p !== ".git";
function walk(dir: string, rel = ""): string[] {
  if (!existsSync(join(dir, rel))) return [];
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? walk(dir, r) : [r];
  });
}

export interface RestoreResult { to: string; head: string; refs: number; extras: number; replica?: string; built: string[]; findings: Finding[]; next: string[] }

// pocketbrain restore <file> --to <empty folder> --identity <key>: a working brain from one file.
// --key: the SSH signing key (1Password's SSH agent or a file) when rules/hub.yaml requires signing.
export async function restore(file: string, o: { to: string; identity: Identity; name?: string; key?: string; signer?: string; offline?: boolean }): Promise<RestoreResult> {
  const to = resolve(expand(o.to));
  const existed = existsSync(to);
  if (existed && readdirSync(to).length) throw new BackupError(`${to} isn't empty; restore only into a new or empty folder`);
  const stage = mkdtempSync(join(tmpdir(), "pb-restore-"));
  // A restore that fails part-way leaves the folder as it found it (gone, or empty), so the retry
  // isn't refused as "not empty".
  const undo = () => {
    if (!existsSync(to)) return;
    if (!existed) rmSync(to, { recursive: true, force: true });
    else for (const e of readdirSync(to)) rmSync(join(to, e), { recursive: true, force: true });
  };
  try {
    const m = decrypt(resolve(expand(file)), o.identity, stage);
    const problems = checkPayload(stage, m);
    if (problems.length) throw new BackupError(`the backup doesn't check out, nothing restored: ${problems.slice(0, 5).join("; ")}`);
    mkdirSync(to, { recursive: true });
    g(to, "init", "-q", "-b", m.branch);
    const v = g(to, "bundle", "verify", "-q", join(stage, "repo.bundle"));
    if (v.code !== 0) throw new BackupError(`git bundle verify: ${v.err}`);
    const f = g(to, "fetch", "-q", "--update-head-ok", join(stage, "repo.bundle"), "refs/*:refs/*");
    if (f.code !== 0) throw new BackupError(`git fetch from the bundle: ${f.err}`);
    // A tracked link (mode 120000) would be checked out pointing anywhere: refused before checkout.
    const links = g(to, "ls-tree", "-r", m.branch).out.split("\n").filter((l) => l.startsWith("120000 ")).map((l) => l.split("\t")[1]);
    if (links.length) throw new BackupError(`the backup's history holds a link, nothing restored: ${links.slice(0, 3).join(", ")}`);
    const co = g(to, "checkout", "-q", "-f", m.branch);
    if (co.code !== 0) throw new BackupError(`git checkout ${m.branch}: ${co.err}`);
    // A backup of a brain newer than this code (src/format.ts) isn't unpacked into a brain this
    // version would then run on: the folder goes, and the line says which release can restore it.
    let fp: ReturnType<typeof formatProblem>;
    try { fp = formatProblem(to); } catch (e) { rmSync(to, { recursive: true, force: true }); throw new BackupError((e as Error).message); }
    if (fp?.kind === "newer") { rmSync(to, { recursive: true, force: true }); throw new BackupError(fp.text.replace("Nothing was read or changed", "Nothing was restored")); }
    // Every ref the bundle holds must be here as packed; beyond that, a branch or tag the manifest
    // names must match too (anything else would be lost work), but a remote-tracking ref may differ:
    // backups made before G738 listed refs a moment after packing, while a push could move one.
    const got = refsOf(to), packed = bundleRefs(to, join(stage, "repo.bundle"));
    const missing = [...Object.entries(packed), ...Object.entries(m.refs).filter(([r]) => !tracking(r))].filter(([r, s]) => got[r] !== s).map(([r]) => r);
    if (missing.length) throw new BackupError(`refs didn't come back: ${[...new Set(missing)].slice(0, 3).join(", ")}`);
    const fsck = g(to, "fsck", "--full", "--no-progress");
    if (fsck.code !== 0) throw new BackupError(`git fsck: ${fsck.err || fsck.out}`);
    for (const e of m.extras) {
      mkdirSync(dirname(join(to, e.path)), { recursive: true });
      cpSync(join(stage, "files", e.path), join(to, e.path));
    }

    const next: string[] = [];
    const name = o.name ?? m.replica;
    const cfgHub = hub.loadHub(to);
    if (cfgHub && name) {
      next.push(...hub.init(to, { name, key: o.key ? expand(o.key) : undefined, signer: o.signer }));
      if (hub.signingRequired(cfgHub) && !o.key) next.push(`rules/hub.yaml requires signed commits: run pocketbrain hub init --name ${name} --key <your signing key>`);
      if (name !== cfgHub.hub) next.push(`${name} is a replica; to make this machine the hub: pocketbrain hub promote ${name}`);
      const vh = hub.verifyNew(to);
      if (vh.problems.length) next.push(`history check: ${vh.problems.slice(0, 3).join("; ")}`);
    }

    const built = buildAll(to);
    const findings = await doctor(to, { offline: o.offline ?? true });
    next.push("the next backup from this machine starts the record again (pocketbrain backup, once the backup folder syncs here)");
    next.push("re-issue agent tokens if they were lost with the old machine (pocketbrain token --agent <name>; a wider than trial agent needs its one-time code from the dashboard, --code), then start the server");
    return { to, head: m.head, refs: Object.keys(m.refs).length, extras: m.extras.length, replica: name, built, findings, next };
  } catch (e) {
    undo();
    throw e;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// Same as `pocketbrain build --all`: every outside agent's view and dated snapshot.
export function buildAll(root: string): string[] {
  const rules = loadRules(root), notes = loadBrain(root);
  const out: string[] = [];
  for (const [a, spec] of Object.entries(rules.policy.agents)) {
    if (spec.inside_wall) continue;
    buildView(notes, rules, carve(notes, rules, grantFor(rules, a)), root);
    out.push(a);
  }
  return out;
}

// ---------- drill ----------

export interface Fingerprint { head: string; refs: Record<string, string>; tree: string; dirty: string[]; files: Record<string, string>; replica?: string; signing?: string }

export function fingerprint(root: string): Fingerprint {
  const files: Record<string, string> = {};
  for (const p of g(root, "ls-files", "-z", "--others").out.split("\0").filter(Boolean).sort()) {
    if (DERIVED.some((r) => r.test(p)) || p === LAST) continue;
    const f = join(root, p);
    if (statSync(f, { throwIfNoEntry: false })?.isFile()) files[p] = sha256(readFileSync(f));
  }
  return {
    head: g(root, "rev-parse", "HEAD").out,
    refs: refsOf(root),
    tree: g(root, "rev-parse", "HEAD^{tree}").out,
    dirty: g(root, "status", "--porcelain", "--untracked-files=no").out.split("\n").filter(Boolean),
    files,
    replica: hub.replicaName(root),
    signing: g(root, "config", "--get", "user.signingkey").out || undefined,
  };
}

// `ignore`: paths left out of the file and uncommitted-change comparison (the drill's hub logs).
export function diffFingerprints(a: Fingerprint, b: Fingerprint, skipped: string[] = [], ignore: (p: string) => boolean = () => false): string[] {
  const d: string[] = [];
  if (a.head !== b.head) d.push(`HEAD ${a.head.slice(0, 8)} -> ${b.head.slice(0, 8)}`);
  if (a.tree !== b.tree) d.push("the checked-out tree differs");
  for (const r of new Set([...Object.keys(a.refs), ...Object.keys(b.refs)])) if (a.refs[r] !== b.refs[r]) d.push(`ref ${r}: ${a.refs[r]?.slice(0, 8) ?? "absent"} -> ${b.refs[r]?.slice(0, 8) ?? "absent"}`);
  for (const p of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    if (skipped.includes(p) || ignore(p)) continue;
    if (a.files[p] !== b.files[p]) d.push(`${p}: ${!b.files[p] ? "missing after restore" : !a.files[p] ? "new after restore" : "content differs"}`);
  }
  const dirty = (f: Fingerprint) => f.dirty.filter((l) => !ignore(l.trim().replace(/^\S+\s+/, "")));
  if (dirty(a).join() !== dirty(b).join()) d.push(`uncommitted changes differ (${dirty(a).length} before, ${dirty(b).length} after)`);
  if (a.replica !== b.replica) d.push(`replica name ${a.replica ?? "none"} -> ${b.replica ?? "none"}`);
  return d;
}

// `lost`: logs (log/*.jsonl) the backup left out for holding a secret shape. A restore would start
// them fresh (a hash-chained log loses its chain), so the drill fails on any (G185).
export interface DrillResult { ok: boolean; notes: number; facts: number; checks: string[]; keySource: "given" | "throwaway"; file: string; bytes: number; head: string; refs: number; extras: number; skipped: Skipped[]; lost: string[]; diff: string[]; leaks: string[]; doctorFails: string[]; doctorWarns: string[]; alerts: string[]; seconds: number }

// What a restored brain must still hold: every note and every fact record, by count.
export function brainCounts(root: string): { notes: number; facts: number } {
  const notes = loadBrain(root);
  let facts = 0;
  for (const n of notes) for (const f of Object.values(n.fm.facts ?? {})) facts += isList(f) ? f.items.length : 1;
  return { notes: notes.length, facts };
}

// Beyond the fingerprint diff: the repo is sound (git fsck), nothing went missing (note and fact
// counts), and the hub serves the restored brain (its rules load and /health answers 200).
// One line per problem; empty when the restore is good.
export async function restoreChecks(root: string, before: { notes: number; facts: number }): Promise<string[]> {
  const out: string[] = [];
  const fsck = g(root, "fsck", "--full", "--no-progress");
  if (fsck.code !== 0) out.push(`git fsck: ${(fsck.err || fsck.out).split("\n")[0] || `exit ${fsck.code}`}`);
  let after = { notes: -1, facts: -1 };
  try { after = brainCounts(root); } catch (e) { out.push(`notes can't be read: ${(e as Error).message.split("\n")[0]}`); }
  if (after.notes >= 0 && after.notes !== before.notes) out.push(`notes: ${before.notes} before, ${after.notes} after`);
  if (after.notes >= 0 && after.facts !== before.facts) out.push(`facts: ${before.facts} before, ${after.facts} after`);
  try {
    loadRules(root);
    const { serve } = await import("./server");
    const s = serve(root, 0);
    try {
      const h = await fetch(`http://127.0.0.1:${s.port}/health`);
      if (h.status !== 200) out.push(`the hub didn't boot: /health answered ${h.status}`);
    } finally { s.stop(true); }
  } catch (e) { out.push(`the hub didn't boot: ${(e as Error).message.split("\n")[0]}`); }
  return out;
}

// pocketbrain drill: copy -> backup -> wipe -> restore -> diff. Never touches the brain itself or
// the real backup folder. With --identity it proves the key in 1Password opens what the hub
// encrypts to rules/backup.pub; without, it proves the mechanics with a throwaway key.
export async function drill(root: string, o: { identity?: string; key?: string; keep?: boolean } = {}): Promise<DrillResult> {
  const t0 = Date.now();
  const work = mkdtempSync(join(tmpdir(), "pb-drill-"));
  const copy = join(work, "brain"), dest = join(work, "backups");
  try {
    cpSync(root, copy, { recursive: true, verbatimSymlinks: true, filter: (src) => ![join(root, "views"), join(root, ".cells"), join(root, "node_modules")].includes(src) });
    const signingKey = o.key ?? (g(copy, "config", "--get", "user.signingkey").out || undefined);
    let identity: Identity, keys: string[] | undefined;
    if (o.identity) identity = { text: readIdentity(o.identity) };
    else {
      const k = run(["age-keygen"]);
      if (k.code !== 0) throw new BackupError("age-keygen isn't installed");
      identity = { text: k.out + "\n" };
      keys = [run(["age-keygen", "-y"], { stdin: k.out + "\n" }).out];
    }
    const before = fingerprint(copy);
    const counts = brainCounts(copy);
    const b = backup(copy, { dest, recipients: keys, record: false, rotate: false });

    // Nothing readable in the encrypted file, and no plaintext secret inside it.
    const leaks: string[] = [];
    const enc = readFileSync(b.file);
    if (enc.includes(Buffer.from(before.head)) || enc.includes(Buffer.from("rules/"))) leaks.push("the encrypted file contains readable repo text");
    const peek = join(work, "peek");
    decrypt(b.file, identity, peek);
    for (const p of walk(join(peek, "files"))) { const s = secretIn(readFileSync(join(peek, "files", p), "utf8")); if (s) leaks.push(`${p} holds ${s}`); }
    rmSync(peek, { recursive: true, force: true });

    rmSync(copy, { recursive: true, force: true });
    if (existsSync(copy)) throw new BackupError("couldn't wipe the drill copy");
    const r = await restore(b.file, { to: copy, identity, key: signingKey, offline: true });
    const after = fingerprint(copy);
    // The brain's content, not the hub's own logs: a log the hub writes and doesn't commit (the
    // pull's log/sources/runs.jsonl) differs after a restore by design. Logs a backup had to leave
    // out are still reported, as `lost`.
    const diff = diffFingerprints(before, after, b.skipped.map((s) => s.path), (p) => p.startsWith("log/"));
    // Open hub alerts are the live brain's state, carried over by the restore, not a restore that
    // failed: listed apart (2026-10-22, a week of probe alerts made a clean restore read "failed").
    const isAlerts = (f: { id?: string }) => f.id === "doctor.hub-alerts";
    const alerts = r.findings.filter(isAlerts).map((f) => `${f.area}: ${f.text}`);
    const doctorFails = r.findings.filter((f) => f.level === "FAIL" && !isAlerts(f)).map((f) => `${f.area}: ${f.text}`);
    const doctorWarns = r.findings.filter((f) => f.level === "warn").map((f) => `${f.area}: ${f.text}`);
    const lost = b.skipped.filter((x) => /^(log\/.*|actions\/log)\.jsonl$/.test(x.path) && x.reason !== "credential file").map((x) => x.path);
    const checks = await restoreChecks(copy, counts);
    return { ok: !diff.length && !leaks.length && !doctorFails.length && !lost.length && !checks.length, notes: counts.notes, facts: counts.facts, checks, keySource: o.identity ? "given" : "throwaway", file: b.file, bytes: b.bytes, head: b.head, refs: Object.keys(before.refs).length, extras: b.extras, skipped: b.skipped, lost, diff, leaks, doctorFails, doctorWarns, alerts, seconds: (Date.now() - t0) / 1000 };
  } finally {
    if (!o.keep) rmSync(work, { recursive: true, force: true });
  }
}

export function renderDrill(d: DrillResult): string {
  const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
  return [
    `drill ${d.ok ? "PASSED" : "FAILED"} in ${d.seconds.toFixed(1)}s`,
    `  backed up a copy at ${d.head.slice(0, 8)}: ${d.refs} ref(s), ${d.extras} untracked state file(s), ${kb(d.bytes)} encrypted`,
    `  key: ${d.keySource === "given" ? "the identity you passed (the 1Password key path is proven)" : "a throwaway key (mechanics only; run with --identity to prove the 1Password key)"}`,
    ...d.skipped.filter((s) => !d.lost.includes(s.path)).map((s) => `  left out on purpose: ${s.path} (${s.reason})`),
    ...d.lost.map((p) => `  LOST: ${p} holds a secret shape, so the backup left the whole log out; a restore would start it empty`),
    `  wiped the copy, restored it into an empty folder`,
    d.diff.length ? `  DIFF:\n${d.diff.map((x) => `    ${x}`).join("\n")}` : `  diff: none (refs, history, tree, untracked state and replica name all identical; the hub's own logs are not compared)`,
    d.leaks.length ? `  LEAKS:\n${d.leaks.map((x) => `    ${x}`).join("\n")}` : `  secrets: none in the backup`,
    ...(d.checks.length ? [`  RESTORE CHECKS:\n${d.checks.map((x) => `    ${x}`).join("\n")}`] : [`  git fsck: clean; ${d.notes} notes and ${d.facts} facts, same as before; hub booted on the restored brain`]),
    ...(d.alerts.length ? [`  open alerts on the brain (not a drill failure; see pocketbrain doctor):\n${d.alerts.map((x) => `    ${x}`).join("\n")}`] : []),
    d.doctorFails.length ? `  DOCTOR FAILS:\n${d.doctorFails.map((x) => `    ${x}`).join("\n")}` : `  doctor on the restored brain: no FAIL${d.doctorWarns.length ? ` (${d.doctorWarns.length} warning(s))` : ""}`,
  ].join("\n");
}

// pocketbrain drill --demo: the whole drill on the sample brain (examples/brain) with a throwaway
// key, so CI and a new install prove backup and restore end to end without any real data or key.
// Never reads the owner's brain and records nothing in it.
export const DEMO_BRAIN = join(import.meta.dir, "..", "examples", "brain");
export async function demoDrill(): Promise<DrillResult> {
  const work = mkdtempSync(join(tmpdir(), "pb-demo-drill-"));
  try {
    const root = join(work, "brain");
    cpSync(DEMO_BRAIN, root, { recursive: true });
    const env = { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.com" };
    for (const a of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "demo brain"]]) {
      const r = Bun.spawnSync(["git", ...a], { cwd: root, env });
      if (r.exitCode !== 0) throw new BackupError(`demo brain: git ${a[0]} failed: ${r.stderr.toString().trim()}`);
    }
    return await drill(root);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
export const demoLine = (d: DrillResult) => `drill ${d.ok ? "PASSED" : "FAILED"} in ${d.seconds.toFixed(1)}s (demo brain, throwaway key): ${d.notes} notes, ${d.facts} facts, fsck ${d.checks.some((c) => c.startsWith("git fsck")) ? "FAILED" : "clean"}, hub ${d.checks.some((c) => c.startsWith("the hub")) ? "DIDN'T BOOT" : "booted"}`;

// ---------- doctor's backup lines ----------

export function backupFindings(root: string, now = new Date()): Finding[] {
  const out: Finding[] = [];
  const add = (level: "ok", text: string) => out.push({ area: "backup", level, text });
  const bad = (level: "warn" | "FAIL", id: OwnerErrorId, vars: Vars = {}, repair?: string) => out.push(finding("backup", level, id, vars, repair));
  const cfg = loadBackupConfig(root);
  if (!cfg) { bad("warn", "doctor.backup-none"); return out; }
  try { recipients(root, cfg); } catch (e) { bad("FAIL", "doctor.backup-config", { message: (e as Error).message }); }
  const look = lastLook(root);
  const lookLine = () => { if (look && !Number.isNaN(Date.parse(look.at))) add("ok", `last backup look ${Math.max(0, Math.round((now.getTime() - Date.parse(look.at)) / 60000))} min ago${look.error ? ` (it failed: ${look.error})` : ""}`); };
  const last = lastBackup(root);
  if (!last) { bad("warn", "doctor.backup-never", {}, "backup"); lookLine(); return out; }
  const days = (now.getTime() - Date.parse(last.at)) / 86400000;
  const moved = g(root, "diff", "--quiet", last.head, "HEAD", "--", ".", `:(exclude)${LAST}`).code !== 0;
  if (days > 3 && moved) bad("warn", "doctor.backup-stale", { days: days.toFixed(0) }, "backup");
  else add("ok", `last backup ${last.file}, ${days < 1 ? `${(days * 24).toFixed(0)}h` : `${days.toFixed(0)} day(s)`} ago`);
  let dest: string | undefined;
  try { dest = destOf(root, cfg); } catch (e) { bad("FAIL", "doctor.backup-config", { message: (e as Error).message }); }
  // The folder only exists on the machine that writes it; elsewhere this is quiet.
  if (dest && existsSync(dest) && !existsSync(join(dest, last.file))) bad("warn", "doctor.backup-gone", { file: last.file, dest });
  lookLine();
  return out;
}

// ---------- from the hub ----------

// The hub's hourly backup, in a child process (`pocketbrain backup --if-due`) it waits for without
// blocking: the backup folder is often a cloud-synced one, and on 2026-10-20 a sync open() there
// never returned and froze the whole hub for two days. Past the time limit the child is killed and
// the hub carries on; the probe's stale-backup check reports a backup that keeps failing.
type Child = { exited: Promise<number>; kill: (signal?: string) => void };
export async function backupApart(root: string, o: { spawn?: (cmd: string[]) => Child; timeoutMs?: number; due?: () => boolean } = {}): Promise<number | undefined> {
  const role = hub.hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") return undefined;
  if (!(o.due ?? (() => due(root).due))()) return undefined;
  const cmd = [process.execPath, join(import.meta.dir, "cli.ts"), "backup", "--if-due", "--brain", root];
  const child = (o.spawn ?? ((c) => Bun.spawn(c, { stdout: "inherit", stderr: "inherit" }) as unknown as Child))(cmd);
  const limit = o.timeoutMs ?? 20 * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([child.exited, new Promise<never>((_, no) => { timer = setTimeout(() => no(new BackupError(`the backup didn't finish in ${Math.round(limit / 60_000) || 1} min and was stopped: is the backup folder a cloud drive that stopped answering?`)), limit); })]);
  } catch (e) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    throw e;
  } finally { if (timer) clearTimeout(timer); }
}

// ---------- origin ----------

// The hub's hourly push of main to the brain's origin remote, when rules/backup.yaml says
// push_origin: true (backlog 381; on 2026-10-22, 331 commits were only on the Mac's disk). In a
// child process the hub can kill, like the backup: a remote that stops answering never holds the
// hub. Never --force: an origin that moved on fails the push and says so. Two failures in a row
// are a probe alert (src/probe.ts); the next good push clears it.
const PUSHED = "log/origin-push.json";
export interface PushState { at: string; ok_at?: string; error?: string; fails: number }
export function lastPush(root: string): PushState | undefined {
  try { return JSON.parse(readFileSync(join(root, PUSHED), "utf8")); } catch { return undefined; }
}
type PushChild = Child & { stderr?: ReadableStream<Uint8Array> };
export async function pushOriginApart(root: string, o: { spawn?: (cmd: string[]) => PushChild; timeoutMs?: number; now?: Date } = {}): Promise<PushState | undefined> {
  if (!loadBackupConfig(root)?.push_origin) return undefined;
  const role = hub.hubRole(root);
  if (role.mode === "replica" || role.mode === "unnamed") return undefined;
  if (g(root, "remote", "get-url", "origin").code !== 0) return undefined;
  // A prompt for a password would wait forever: it fails instead. The error kept never names the
  // remote's address (it can carry a token), since it reaches the probe, the digest and the texts.
  const cmd = ["git", "-C", root, "push", "--quiet", "origin", "HEAD"];
  const child = (o.spawn ?? ((c) => Bun.spawn(c, { stdout: "ignore", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }) as unknown as PushChild))(cmd);
  const limit = o.timeoutMs ?? 5 * 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let error: string | undefined;
  try {
    const code = await Promise.race([child.exited, new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`the push to origin didn't finish in ${limit >= 60_000 ? `${Math.round(limit / 60_000)} min` : `${limit} ms`} and was stopped`)), limit); })]);
    if (code !== 0) error = (child.stderr ? (await new Response(child.stderr).text()).split("\n").map((l) => l.trim()).filter((l) => /^(!|error:|fatal:)/.test(l)).slice(0, 2).join(" ").replace(/'[^']*'|\S+:\/\/\S+/g, "origin") : "") || `git push exited ${code}`;
  } catch (e) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    error = (e as Error).message;
  } finally { if (timer) clearTimeout(timer); }
  const at = (o.now ?? new Date()).toISOString();
  const prev = lastPush(root);
  const state: PushState = error ? { at, ...(prev?.ok_at ? { ok_at: prev.ok_at } : {}), error: error.slice(0, 300), fails: (prev?.fails ?? 0) + 1 } : { at, ok_at: at, fails: 0 };
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, PUSHED), JSON.stringify(state));
  // One failure can be a blip (the probe waits for two); the ledger keeps the last run as it was.
  beat(root, "origin_push", { ok: !error, error, now: o.now });
  return state;
}

// ---------- the hub's timers ----------

// The hourly backup look and push, as `start` and `serve` run them. Each also runs once a few
// minutes after start when its last run is over its hour old: an hour counted only from start
// never came while updates restarted the hub more often than hourly (2026-10-24, 335 commits
// never pushed). The backup's own `due` decides whether a look backs up.
const HOUR = 3600000;
export function pushDue(root: string, now = new Date()): boolean {
  const last = lastPush(root);
  return !last || now.getTime() - Date.parse(last.at) >= HOUR || Number.isNaN(Date.parse(last.at));
}
// Each look leaves its time in log/backup-look.json, backup or not, so doctor (and whoever checks
// the hub) can see the looks happen even on days nothing is due.
const LOOKED = "log/backup-look.json";
export interface LookState { at: string; error?: string }
export function lastLook(root: string): LookState | undefined {
  try { return JSON.parse(readFileSync(join(root, LOOKED), "utf8")); } catch { return undefined; }
}
function noteLook(root: string, error?: string): void {
  beat(root, "backup_look", { ok: !error, error });
  try {
    mkdirSync(join(root, "log"), { recursive: true });
    writeFileSync(join(root, LOOKED), JSON.stringify({ at: new Date().toISOString(), ...(error ? { error: error.slice(0, 300) } : {}) }));
  } catch { /* the look itself already ran; its trace is best effort */ }
}
export function startBackupTimers(root: string, o: {
  after?: (fn: () => unknown, ms: number) => void; every?: (fn: () => unknown, ms: number) => void;
  firstMs?: number; backup?: () => Promise<number | undefined>; push?: () => Promise<PushState | undefined>;
} = {}): void {
  const cfg = loadBackupConfig(root);
  if (!cfg) return;
  const after = o.after ?? ((fn, ms) => { setTimeout(fn, ms); });
  const every = o.every ?? ((fn, ms) => { setInterval(fn, ms); });
  const first = o.firstMs ?? 3 * 60_000;
  const look = () => (o.backup ?? (() => backupApart(root)))().then((code) => { noteLook(root, code ? `exited ${code}` : undefined); if (code) console.error(`backup: exited ${code}`); }, (e) => { noteLook(root, (e as Error).message); console.error(`backup: ${(e as Error).message}`); });
  after(look, first);
  every(look, HOUR);
  if (!cfg.push_origin) return;
  const push = () => (o.push ?? (() => pushOriginApart(root)))().then((p) => { if (p?.error) console.error(`push to origin: ${p.error}`); }, (e) => console.error(`push to origin: ${(e as Error).message}`));
  after(() => (pushDue(root) ? push() : undefined), first);
  every(push, HOUR);
}
