// SPDX-License-Identifier: AGPL-3.0-only
// Backups off the cloud-synced folder (finals plan row 413). The hub writes each backup to a local
// folder only (rules/backup.yaml dest); this separate launchd job, com.pocketbrain.offsite, copies
// new ones to the owner's synced folder (Drive, say) every hour. Each copy is a child process with
// a time limit, so a synced folder that hangs (2026-10-20: a sync open() on the Drive symlink froze
// the hub for two days) can only stall this copy, never the hub. Each run records its outcome in
// log/offsite.json, which the hub's probe (src/probe.ts) turns into the `offsite` check.
// `pocketbrain backup offsite on <folder>` installs the job, `off` removes it.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBackupConfig, destOf } from "./backup";
import { launchdPlist } from "./start";

export const OFFSITE_LABEL = "com.pocketbrain.offsite";
export const OFFSITE_TIMEOUT_MS = 10 * 60_000;
const EVERY_S = 3600;
// No successful copy in this long while the job is on fails the check.
export const OFFSITE_STALE_HOURS = 48;

type Exec = (cmd: string[], ms: number) => Promise<{ code: number; out: string }>;
export type Run = (cmd: string[]) => { code: number; out: string };
export interface OffsiteState { to?: string; on_at?: string; at?: string; ok_at?: string; error?: string; copied?: number }

const stateFile = (root: string) => join(root, "log", "offsite.json");
export function offsiteState(root: string): OffsiteState | undefined {
  try { return JSON.parse(readFileSync(stateFile(root), "utf8")) as OffsiteState; } catch { return undefined; }
}
function saveState(root: string, s: OffsiteState) { mkdirSync(join(root, "log"), { recursive: true }); writeFileSync(stateFile(root), JSON.stringify(s) + "\n"); }

const exec: Exec = async (cmd, ms) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  let late = false;
  const timer = setTimeout(() => { late = true; p.kill(9); }, ms);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return late ? { code: 1, out: `no answer in ${Math.round(ms / 1000)} s` } : { code, out: (err || out).trim() };
  } finally { clearTimeout(timer); }
};

// One run of the job: every finished backup (brain-*.tar.age, never a .partial) in the local folder
// that the synced folder lacks, or has at another size, is copied there under a partial name and
// renamed once whole. Listing and copying the synced folder happen only in child processes, under
// one time limit for the whole run: this process never touches it directly either.
export async function offsiteCopy(root: string, to: string, o: { from?: string; timeoutMs?: number; run?: Exec; now?: Date } = {}): Promise<{ copied: string[]; error?: string }> {
  const now = o.now ?? new Date();
  const from = o.from ?? destOf(root, loadBackupConfig(root));
  const ms = o.timeoutMs ?? OFFSITE_TIMEOUT_MS;
  const run = o.run ?? exec;
  const prev = offsiteState(root) ?? {};
  const copied: string[] = [];
  let error: string | undefined;
  const deadline = Date.now() + ms;
  const left = () => Math.max(1, deadline - Date.now());
  // A whole run under one limit: the time a step may take is what is left of it.
  const step = async (cmd: string[]) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<{ code: number; out: string }>((done) => { t = setTimeout(() => done({ code: 1, out: `no answer in ${Math.round(ms / 1000)} s` }), left()); });
    try { return await Promise.race([run(cmd, left()), late]); } finally { clearTimeout(t); }
  };
  try {
    const mine = readdirSync(from).filter((f) => /^brain-.*\.tar\.age$/.test(f)).sort();
    const ls = await step(["/bin/ls", "-ln", to]);
    if (ls.code !== 0) throw new Error(`can't list ${to}: ${ls.out.slice(0, 160)}`);
    const there = new Map(ls.out.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 9).map((p) => [p.slice(8).join(" "), Number(p[4])]));
    for (const f of mine) {
      if (there.get(f) === statSync(join(from, f)).size) continue;
      const r = await step(["/bin/sh", "-c", 'cp "$1" "$2/.$3.partial" && mv "$2/.$3.partial" "$2/$3"', "sh", join(from, f), to, f]);
      if (r.code !== 0) throw new Error(`copying ${f}: ${r.out.slice(0, 160)}`);
      copied.push(f);
    }
  } catch (e) { error = (e as Error).message; }
  saveState(root, { ...prev, to, at: now.toISOString(), ...(error ? { error } : { ok_at: now.toISOString(), error: undefined }), copied: copied.length });
  return { copied, ...(error ? { error } : {}) };
}

// The probe's `offsite` check: once the job was turned on or has run (off removes the state).
export function offsiteCheck(root: string, now = new Date()): { name: string; ok: boolean; detail: string } | undefined {
  const s = offsiteState(root);
  if (!s) return undefined;
  if (s.error) return { name: "offsite", ok: false, detail: `the offsite copy of backups failed ${s.at?.slice(0, 16) ?? ""}: ${s.error}` };
  const since = s.ok_at ?? s.on_at ?? s.at ?? now.toISOString();
  const hours = (now.getTime() - Date.parse(since)) / 3_600_000;
  if (hours > OFFSITE_STALE_HOURS) return { name: "offsite", ok: false, detail: `no offsite copy of backups since ${since.slice(0, 16)}; is com.pocketbrain.offsite loaded?` };
  return { name: "offsite", ok: true, detail: s.ok_at ? `backups copied offsite ${s.ok_at.slice(0, 16)}` : "offsite copy on, first run pending" };
}

const plistFile = (home: string) => join(home, "Library", "LaunchAgents", `${OFFSITE_LABEL}.plist`);

export function offsiteOn(root: string, to: string, o: { home: string; uid: number; bun: string; app: string; run: Run }): string {
  const dir = resolve(to);
  const file = plistFile(o.home);
  // Turning it on again with another folder replaces the job.
  if (existsSync(file)) o.run(["launchctl", "bootout", `gui/${o.uid}/${OFFSITE_LABEL}`]);
  mkdirSync(join(o.home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(file, launchdPlist({ label: OFFSITE_LABEL, args: [o.bun, join(o.app, "src", "cli.ts"), "backup", "offsite", "copy", "--brain", resolve(root), "--to", dir], cwd: o.app, env: { PATH: "/usr/bin:/bin" }, logDir: join(o.home, "Library", "Logs"), interval: EVERY_S }));
  const r = o.run(["launchctl", "bootstrap", `gui/${o.uid}`, file]);
  if (r.code !== 0) throw new Error(`launchctl bootstrap ${OFFSITE_LABEL} failed: ${r.out.trim().slice(0, 200)}`);
  saveState(root, { to: dir, on_at: new Date().toISOString() });
  return `offsite copy on: new backups go to ${dir} every hour (${OFFSITE_LABEL})`;
}

export function offsiteOff(root: string, o: { home: string; uid: number; run: Run }): string {
  const file = plistFile(o.home);
  if (existsSync(file)) { o.run(["launchctl", "bootout", `gui/${o.uid}/${OFFSITE_LABEL}`]); rmSync(file); }
  rmSync(stateFile(root), { force: true });
  return "offsite copy off: backups stay in the local folder only";
}
