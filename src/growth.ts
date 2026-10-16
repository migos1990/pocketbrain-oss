// SPDX-License-Identifier: AGPL-3.0-only
// A year of growth (docs/perf.md): the night pass's housekeeping. It touches no note and makes
// no commit. It rotates the hub's launchd logs, packs the brain's git (agent writes never pay for
// git's own gc: `gitRun` turns it off for commits), and fails the job, which the probe reports,
// when the brain's .git grows past its budget. log/*.jsonl are hash-chained and stay whole; their
// size is reported, never cut.
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitRun } from "./git";

const HUB_LOG = /^com\.pocketbrain\.[\w.-]+\.log$/;
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 3;
export const GIT_MAX_MB = Number(process.env.PB_GIT_MAX_MB ?? 2048);

export const hubLogDir = () => process.env.PB_HUB_LOG_DIR ?? join(homedir(), "Library", "Logs");

// Each com.pocketbrain.*.log over maxBytes is copied to .1 (older copies shift up, the oldest past
// `keep` is dropped) and then emptied in place: launchd holds the file open for appending, so a
// rename would leave it writing to the old copy. A line written between the copy and the
// truncate is lost. Returns the rotated files.
export function rotateHubLogs(dir = hubLogDir(), o: { maxBytes?: number; keep?: number } = {}): string[] {
  if (!existsSync(dir)) return [];
  const max = o.maxBytes ?? LOG_MAX_BYTES, keep = o.keep ?? LOG_KEEP;
  const out: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (!HUB_LOG.test(f) || statSync(p).size <= max) continue;
    rmSync(`${p}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) if (existsSync(`${p}.${i}`)) renameSync(`${p}.${i}`, `${p}.${i + 1}`);
    copyFileSync(p, `${p}.1`);
    truncateSync(p, 0);
    out.push(p);
  }
  return out;
}

// git's own `gc --auto`: packs loose objects and old packs only past git's thresholds, so most
// nights it does nothing. Never detached, so the night pass waits for it inside the write queue.
export function gcAuto(root: string): { ok: boolean; err: string } {
  const r = gitRun(root, ["-c", "gc.autoDetach=false", "gc", "--auto", "--quiet"]);
  return { ok: r.ok, err: r.err };
}

function bytes(p: string): number {
  if (!existsSync(p)) return 0;
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  let n = 0;
  for (const e of readdirSync(p)) n += bytes(join(p, e));
  return n;
}
const mb = (b: number) => { const m = b / 1048576; return m < 0.05 ? "0" : m.toFixed(1); };

export function diskUse(root: string, logDir = hubLogDir()) {
  const hub = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.startsWith("com.pocketbrain.")).reduce((n, f) => n + bytes(join(logDir, f)), 0) : 0;
  return { git: bytes(join(root, ".git")), log: bytes(join(root, "log")), hubLogs: hub };
}

// One line for the hub's log; throws (the job is recorded as failed) when gc fails or the .git
// is over budget, so a brain heading for a full disk shows in the probe and the digest.
export function housekeeping(root: string, o: { logDir?: string; maxGitMb?: number } = {}): string {
  const logDir = o.logDir ?? hubLogDir(), max = o.maxGitMb ?? GIT_MAX_MB;
  const rotated = rotateHubLogs(logDir);
  const gc = gcAuto(root);
  if (!gc.ok) throw new Error(`git gc failed: ${gc.err.slice(0, 160)}`);
  const d = diskUse(root, logDir);
  if (d.git / 1048576 > max) throw new Error(`the brain's .git is ${mb(d.git)} MB, over its budget of ${max} MB; see docs/perf.md`);
  return `housekeeping: .git ${mb(d.git)} MB, log/ ${mb(d.log)} MB, hub logs ${mb(d.hubLogs)} MB${rotated.length ? `; rotated ${rotated.length} hub log(s)` : ""}`;
}
