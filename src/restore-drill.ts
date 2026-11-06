// SPDX-License-Identifier: AGPL-3.0-only
// The Sunday restore test (next-level R1, G690): once a week the hub proves its newest backup
// would bring the brain back, without the owner doing anything. It runs in a child process the hub
// can stop (`pocketbrain drill --weekly`), never touches the brain or the backup folders except to
// read, and leaves one line in log/restore-drill.json and the heartbeat ledger
// (src/heartbeat.ts) that Settings, Who knows, doctor and the probe read.
//
//   1. The newest backup in the local folder, checked against log/last-backup's hash.
//   2. When the offsite copy is on (src/offsite.ts), the same file read back out of the synced
//      folder in a child process, and its hash compared: a copy that never arrived, or arrived
//      cut short, fails the test.
//   3. With the drill key (`pocketbrain backup drill-key`, an age identity kept in the keys folder,
//      whose public half is one of the recipients in rules/backup.pub), that file is restored
//      into a scratch folder: every hash, git fsck, the same notes and facts as the brain had at
//      that commit, doctor, and the hub boots on it. Without the drill key, the restore runs on a
//      copy of the brain with a throwaway key (the mechanics), and the line says the file itself
//      wasn't opened.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BackupError, brainCounts, destOf, drill, lastBackup, loadBackupConfig, newestBackup, restore, restoreChecks } from "./backup";
import { fetchOffsite, offsiteState, type Exec } from "./offsite";
import { keysDir } from "./secrets";
import { beat } from "./heartbeat";
import { sha256 } from "./util";
import { recordDrill } from "./measure";

export const DRILL_KEY = "backup-drill.key";
export const drillKeyFile = () => join(keysDir(), DRILL_KEY);
const DRILLED = "log/restore-drill.json";

export interface RestoreDrill {
  at: string; ok: boolean; seconds: number;
  file?: string; head?: string;
  from: "offsite" | "local" | "none";
  key: "drill" | "throwaway";
  notes?: number; facts?: number;
  problems: string[];
}

export function lastRestoreDrill(root: string): RestoreDrill | undefined {
  try { return JSON.parse(readFileSync(join(root, DRILLED), "utf8")) as RestoreDrill; } catch { return undefined; }
}

function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

// The drill key, only when it is a private file: one readable by others is refused, like a model key.
function drillIdentity(file: string): { text?: string; problem?: string } {
  if (!existsSync(file)) return {};
  if (statSync(file).mode & 0o077) return { problem: `the drill key ${file} is readable by others; chmod 600 it` };
  const text = readFileSync(file, "utf8");
  if (!/AGE-SECRET-KEY-1/.test(text)) return { problem: `${file} isn't an age key` };
  return { text };
}

// Notes and facts in the brain as it was at `head`, from a throwaway clone: what a restore of that
// backup must give back. Never reads the live working tree, which has moved on since.
function countsAt(root: string, head: string, work: string): { notes: number; facts: number } {
  const at = join(work, "at-backup");
  const c = git(work, "clone", "-q", "--no-checkout", "--no-hardlinks", root, at);
  if (c.code !== 0) throw new BackupError(`couldn't clone the brain to count it: ${c.err}`);
  const co = git(at, "checkout", "-q", head);
  if (co.code !== 0) throw new BackupError(`the backup's commit ${head.slice(0, 8)} isn't in the brain's history: ${co.err}`);
  return brainCounts(at);
}

export async function restoreDrill(root: string, o: { now?: Date; keyFile?: string; run?: Exec; timeoutMs?: number } = {}): Promise<RestoreDrill> {
  const t0 = Date.now();
  const now = o.now ?? new Date();
  const problems: string[] = [];
  const work = mkdtempSync(join(tmpdir(), "pb-sunday-"));
  let res: RestoreDrill = { at: now.toISOString(), ok: false, seconds: 0, from: "none", key: "throwaway", problems };
  try {
    const cfg = loadBackupConfig(root);
    if (!cfg) throw new BackupError("backups aren't set up (no rules/backup.yaml)");
    const last = lastBackup(root);
    const dest = destOf(root, cfg);
    const local = last && existsSync(join(dest, last.file)) ? join(dest, last.file) : newestBackup(dest);
    if (!local) throw new BackupError(`no backup file in ${dest} to restore`);
    const name = basename(local);
    res = { ...res, file: name, from: "local", ...(last?.file === name ? { head: last.head } : {}) };
    const localSha = sha256(readFileSync(local));
    if (last?.file === name && last.sha256 && last.sha256 !== localSha) problems.push(`${name} in the local folder doesn't match the hash it was made with`);

    let file = local;
    const off = offsiteState(root);
    if (off?.to) {
      const got = await fetchOffsite(off.to, name, work, { run: o.run, timeoutMs: o.timeoutMs });
      if (got.error) problems.push(got.error);
      else if (sha256(readFileSync(got.file!)) !== localSha) problems.push(`the offsite copy of ${name} differs from the local file (cut short or changed)`);
      else { file = got.file!; res.from = "offsite"; }
    }

    const id = drillIdentity(o.keyFile ?? drillKeyFile());
    if (id.problem) problems.push(id.problem);
    if (id.text && res.head) {
      res.key = "drill";
      const before = countsAt(root, res.head, work);
      const to = join(work, "restored");
      try {
        const r = await restore(file, { to, identity: { text: id.text }, offline: true });
        if (r.head !== res.head) problems.push(`the restore came back at ${r.head.slice(0, 8)}, not ${res.head.slice(0, 8)}`);
        problems.push(...r.findings.filter((f) => f.level === "FAIL" && f.id !== "doctor.hub-alerts").map((f) => `doctor on the restored brain: ${f.area}: ${f.text}`));
        problems.push(...await restoreChecks(to, before));
        res = { ...res, notes: before.notes, facts: before.facts };
      } catch (e) { problems.push(`the restore failed: ${(e as Error).message.split("\n")[0]}`); }
    } else {
      // Mechanics only: today's brain, backed up with a throwaway key, wiped and restored.
      const d = await drill(root);
      res = { ...res, notes: d.notes, facts: d.facts };
      if (!d.ok) problems.push(...d.diff.map((x) => `diff: ${x}`), ...d.leaks, ...d.checks, ...d.doctorFails, ...d.lost.map((p) => `${p} left out of the backup`));
    }
  } catch (e) { problems.push((e as Error).message.split("\n")[0]!); }
  finally { rmSync(work, { recursive: true, force: true }); }
  res = { ...res, ok: problems.length === 0, seconds: Math.round((Date.now() - t0) / 100) / 10, problems: problems.slice(0, 8) };
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, DRILLED), JSON.stringify(res) + "\n");
  beat(root, "restore_drill", { ok: res.ok, error: res.problems[0], ms: res.seconds * 1000, now });
  // The week report's "Backup drill" row and the real-use bar count it like a hand-run drill.
  recordDrill(root, res.ok);
  return res;
}

// The line Settings and Who knows show, in the owner's words.
const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function drillWords(d: RestoreDrill | undefined): string | undefined {
  if (!d) return undefined;
  const day = WEEKDAY[new Date(d.at).getUTCDay()]!;
  if (!d.ok) return `The ${day} restore test failed: ${d.problems[0] ?? "see doctor"}`;
  const secs = d.seconds < 1 ? "under a second" : `${Math.round(d.seconds)} s`;
  if (d.key === "drill") return `Your brain was restored from ${day}'s backup${d.from === "offsite" ? " in your cloud folder" : ""} in ${secs}`;
  return `${day}'s backup ${d.from === "offsite" ? "is in your cloud folder and " : ""}restores (tested with a stand-in key; add the drill key to open the file itself)`;
}

// The probe's check: once the test has run. Failing, or no test in 8 days, alerts once.
export function drillCheck(root: string, now = new Date()): { name: string; ok: boolean; detail: string } | undefined {
  const d = lastRestoreDrill(root);
  if (!d) return undefined;
  if (!d.ok) return { name: "restore_drill", ok: false, detail: `the Sunday restore test failed ${d.at.slice(0, 10)}: ${d.problems.join("; ").slice(0, 300)}` };
  const days = (now.getTime() - Date.parse(d.at)) / 86_400_000;
  if (days > 8) return { name: "restore_drill", ok: false, detail: `no restore test since ${d.at.slice(0, 10)}; is the hub running start?` };
  return { name: "restore_drill", ok: true, detail: `restore test passed ${d.at.slice(0, 10)} (${d.key === "drill" ? "drill key" : "stand-in key"}, ${d.from} file)` };
}

// `pocketbrain backup drill-key`: the key the Sunday test opens the real backup file with. Made here
// by age-keygen and written straight into the keys folder (0600), never printed; its public half
// goes into rules/backup.pub beside the owner's own key, so every backup from now on opens with
// either. Whoever can read the keys folder on this machine can already read the brain itself in
// plain text, so the key adds no reader there; it does mean a copy of the keys folder opens the
// offsite files, so it is never synced or backed up (the backup leaves credential files out).
const PUB = "rules/backup.pub";
const MARK = "# drill key (pocketbrain backup drill-key): the Sunday restore test opens backups with it";
export function drillKeyOn(root: string, o: { keyFile?: string } = {}): string {
  const file = o.keyFile ?? drillKeyFile();
  if (!existsSync(join(root, PUB))) throw new BackupError(`no ${PUB} yet; set up backups first (pocketbrain backup --init --pub <age1...>)`);
  if (existsSync(file)) throw new BackupError(`there is already a drill key at ${file}; pocketbrain backup drill-key off first to make a new one`);
  const k = Bun.spawnSync(["age-keygen"], { stdout: "pipe", stderr: "pipe" });
  if (k.exitCode !== 0) throw new BackupError("age-keygen isn't installed (brew install age)");
  const secret = k.stdout.toString().split("\n").find((l) => l.startsWith("AGE-SECRET-KEY-1"));
  if (!secret) throw new BackupError("age-keygen gave no key");
  const pub = Bun.spawnSync(["age-keygen", "-y"], { stdin: Buffer.from(secret + "\n"), stdout: "pipe" }).stdout.toString().trim();
  if (!/^age1[0-9a-z]{58}$/.test(pub)) throw new BackupError("age-keygen -y gave no public key");
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(file, secret + "\n", { mode: 0o600 });
  const text = readFileSync(join(root, PUB), "utf8").replace(/\n?$/, "\n");
  writeFileSync(join(root, PUB), `${text}${MARK}\n${pub}\n`);
  const add = git(root, "add", PUB), c = git(root, "commit", "-q", "-m", "louis: drill key for the Sunday restore test", "--", PUB);
  if (add.code !== 0 || c.code !== 0) throw new BackupError(`wrote ${PUB} but couldn't commit it: ${c.err || add.err}`);
  return `drill key made in ${file} (0600, not printed) and added to ${PUB}; the next backup opens with it, and the Sunday test restores that file. pocketbrain drill --weekly runs the test now`;
}

export function drillKeyOff(root: string, o: { keyFile?: string } = {}): string {
  const file = o.keyFile ?? drillKeyFile();
  // Only the drill key's own public line goes (derived from the key file), and the comment above it:
  // never the line after the comment whatever it is, which could be the owner's own key.
  const mine = existsSync(file) ? Bun.spawnSync(["age-keygen", "-y", file], { stdout: "pipe" }).stdout.toString().trim() : "";
  const lines = existsSync(join(root, PUB)) ? readFileSync(join(root, PUB), "utf8").split("\n") : [];
  const keep = lines.filter((l) => l !== MARK && !(mine && l.trim() === mine));
  if (keep.length !== lines.length) {
    lines.splice(0, lines.length, ...keep);
    writeFileSync(join(root, PUB), lines.join("\n"));
    git(root, "add", PUB);
    git(root, "commit", "-q", "-m", "louis: drill key removed", "--", PUB);
  }
  rmSync(file, { force: true });
  return `drill key removed from ${PUB} and the keys folder; backups made before now still open with it until they rotate out. The Sunday test goes back to a stand-in key`;
}
