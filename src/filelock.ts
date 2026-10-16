// SPDX-License-Identifier: AGPL-3.0-only
// A lock between processes on one brain: a file created with O_EXCL, holding the owner's pid and
// time. Used where the hub's in-process write queue (serial() in src/server.ts) can't reach: a
// second process (`pocketbrain deck auto`, a cron run) must not decide beside the hub (backlog
// #263). A lock whose process is gone, that is older than STALE_MS, or that doesn't parse is
// taken over. Never waits: busy returns undefined and the caller tries on its next tick.
import { existsSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const STALE_MS = 10 * 60_000;

export const lockPath = (root: string, name: string) => join(existsSync(join(root, ".git")) ? join(root, ".git") : root, `pocketbrain-${name}.lock`);

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

function take(f: string, me: string): boolean {
  try { const fd = openSync(f, "wx"); writeSync(fd, me); closeSync(fd); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; return false; }
}

export function withFileLock<T>(root: string, name: string, fn: () => T): T | undefined {
  const f = lockPath(root, name);
  const me = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: Math.random().toString(36).slice(2) });
  if (!take(f, me)) {
    let held: { pid?: number; at?: string } = {};
    try { held = JSON.parse(readFileSync(f, "utf8")); } catch { /* garbled: stale */ }
    const fresh = typeof held.at === "string" && Date.now() - Date.parse(held.at) < STALE_MS;
    if (alive(Number(held.pid)) && fresh) return undefined;
    try { unlinkSync(f); } catch { /* another process took it over first */ }
    if (!take(f, me)) return undefined;
  }
  try { return fn(); }
  finally { try { if (readFileSync(f, "utf8") === me) unlinkSync(f); } catch { /* already gone */ } }
}

export const lockBusy = (root: string, name: string): boolean => withFileLock(root, name, () => true) === undefined;
