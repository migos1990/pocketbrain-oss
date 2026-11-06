// SPDX-License-Identifier: AGPL-3.0-only
// One heartbeat ledger for every scheduled job (next-level R4, G691, G692). Each job, wherever it
// runs (the hub's daily jobs, the hourly backup look and push, the offsite copy's own launchd job,
// the watchdog, the probe, the Sunday restore drill), leaves one line here when it ends: when it
// ran, whether it worked, how long it took. One file per job under log/heartbeats/, so two
// processes beating at once never lose each other's line. `lateJobs` is the one reader the home,
// doctor and the probe share: a job is late when its last good run is older than its cadence
// allows, or failing when its last run failed. A job that never beat is neither (a new brain, or
// a job that isn't set up, like the offsite copy before `backup offsite on`).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Beat { job: string; at: string; ok: boolean; ms?: number; error?: string; ok_at?: string }

// How often each job runs, and how long past that before it counts as late. `owner` is the job in
// the owner's words, for the home and doctor. A job not listed here is still kept and shown by
// doctor, but is only ever failing, never late (it has no schedule to be late on).
export interface Cadence { owner: string; late_hours: number }
export const CADENCE: Record<string, Cadence> = {
  night: { owner: "night pass", late_hours: 36 },
  digest: { owner: "morning digest", late_hours: 36 },
  searchable: { owner: "nightly search check", late_hours: 36 },
  backfill: { owner: "nightly source check", late_hours: 36 },
  trust: { owner: "nightly trust count", late_hours: 36 },
  housekeeping: { owner: "nightly housekeeping", late_hours: 36 },
  audit: { owner: "weekly access audit", late_hours: 8 * 24 },
  pull: { owner: "mail and calendar pull", late_hours: 36 },
  backup_look: { owner: "hourly backup look", late_hours: 6 },
  origin_push: { owner: "hourly push of your brain to its private copy", late_hours: 6 },
  offsite: { owner: "offsite copy of backups", late_hours: 48 },
  restore_drill: { owner: "Sunday restore test", late_hours: 8 * 24 },
  probe: { owner: "health check", late_hours: 12 },
  watchdog: { owner: "watchdog", late_hours: 1 },
};

const dir = (root: string) => join(root, "log", "heartbeats");
const SAFE = /^[a-z][a-z0-9_]{0,63}$/;

export function readBeat(root: string, job: string): Beat | undefined {
  if (!SAFE.test(job)) return undefined;
  try { return JSON.parse(readFileSync(join(dir(root), `${job}.json`), "utf8")) as Beat; } catch { return undefined; }
}

// Never throws: a heartbeat is the job's trace, and a full disk must not turn a good run into a
// failed one. The last good run (ok_at) survives a failure, so "late since" stays true.
export function beat(root: string, job: string, o: { ok: boolean; error?: string; ms?: number; now?: Date }): void {
  if (!SAFE.test(job)) return;
  try {
    const at = (o.now ?? new Date()).toISOString();
    const prev = readBeat(root, job);
    const b: Beat = { job, at, ok: o.ok, ...(o.ms !== undefined ? { ms: Math.round(o.ms) } : {}), ...(o.ok ? { ok_at: at } : { ...(prev?.ok_at ? { ok_at: prev.ok_at } : {}), error: (o.error ?? "failed").slice(0, 200) }) };
    mkdirSync(dir(root), { recursive: true });
    const f = join(dir(root), `${job}.json`);
    writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(b) + "\n");
    renameSync(`${f}.${process.pid}.tmp`, f);
  } catch { /* best effort */ }
}

export function ledger(root: string): Beat[] {
  if (!existsSync(dir(root))) return [];
  return readdirSync(dir(root)).filter((f) => f.endsWith(".json")).map((f) => readBeat(root, f.slice(0, -5))).filter((b): b is Beat => !!b).sort((a, b) => a.job.localeCompare(b.job));
}

export interface Late { job: string; owner: string; why: "late" | "failed"; since: string; error?: string }
export function lateJobs(root: string, now = new Date()): Late[] {
  const out: Late[] = [];
  for (const b of ledger(root)) {
    const c = CADENCE[b.job];
    const owner = c?.owner ?? b.job.replace(/_/g, " ");
    if (!b.ok) { out.push({ job: b.job, owner, why: "failed", since: b.at, ...(b.error ? { error: b.error } : {}) }); continue; }
    const last = b.ok_at ?? b.at;
    if (c && (now.getTime() - Date.parse(last)) / 3_600_000 > c.late_hours) out.push({ job: b.job, owner, why: "late", since: last });
  }
  // The longest-late first: that's the one the home names.
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

// How long ago, in the owner's words: "2 days", "5 hours".
export function agoWords(since: string, now = new Date()): string {
  const h = Math.max(0, (now.getTime() - Date.parse(since)) / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days`;
  if (h >= 24) return "a day";
  const n = Math.max(1, Math.round(h));
  return n === 1 ? "an hour" : `${n} hours`;
}

// The home's one line, only when a job is late or failing: the longest-late one by name, then how
// many more. Undefined when all is well, so the home says nothing.
export function lateLine(late: Late[], now = new Date()): string | undefined {
  const first = late[0];
  if (!first) return undefined;
  const lead = first.why === "late" ? `Your ${first.owner} has not run for ${agoWords(first.since, now)}` : `Your ${first.owner} failed ${agoWords(first.since, now)} ago`;
  return late.length > 1 ? `${lead}, and ${late.length - 1} more job${late.length > 2 ? "s are" : " is"} behind. Settings has the details.` : `${lead}. Settings has the details.`;
}
