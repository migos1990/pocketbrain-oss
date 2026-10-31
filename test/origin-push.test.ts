// SPDX-License-Identifier: AGPL-3.0-only
// The brain reaches its origin by itself (backlog 381): with `push_origin: true` in
// rules/backup.yaml, the hub pushes main to origin every hour from a child process it can kill,
// never with --force, and two failed pushes in a row are a probe alert. On 2026-10-22, 331
// commits sat only on the Mac's disk.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { pushOriginApart, lastPush, startBackupTimers, lastLook, backupFindings } from "../src/backup";
import { jobChecks } from "../src/probe";

const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd }).stdout.toString().trim();
function brain(opts: { push?: boolean } = {}) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "backup.yaml"), `dest: ${mkdtempSync(join(tmpdir(), "pb-dest-"))}\n${opts.push === false ? "" : "push_origin: true\n"}`);
  git(root, "add", "-A"); git(root, "commit", "-qm", "backup config");
  const origin = mkdtempSync(join(tmpdir(), "pb-origin-"));
  git(origin, "init", "-q", "--bare", "-b", "main");
  git(root, "remote", "add", "origin", origin);
  return { root, origin };
}

test("with push_origin on, the hub's push puts main on origin", async () => {
  const { root, origin } = brain();
  const s = await pushOriginApart(root);
  expect(s?.fails).toBe(0);
  expect(git(origin, "rev-parse", "main")).toBe(git(root, "rev-parse", "HEAD"));
  expect(lastPush(root)?.ok_at).toBeDefined();
});

test("without push_origin, nothing is pushed", async () => {
  const { root, origin } = brain({ push: false });
  expect(await pushOriginApart(root)).toBeUndefined();
  expect(git(origin, "rev-parse", "--verify", "-q", "main")).toBe("");
});

test("an origin that moved on is never overwritten: the push fails and says so", async () => {
  const { root, origin } = brain();
  const other = mkdtempSync(join(tmpdir(), "pb-other-"));
  git(other, "init", "-q", "-b", "main"); git(other, "-c", "user.name=x", "-c", "user.email=x@x", "commit", "-q", "--allow-empty", "-m", "elsewhere");
  git(other, "push", "-q", origin, "main");
  const before = git(origin, "rev-parse", "main");
  const s = await pushOriginApart(root);
  expect(s?.fails).toBe(1);
  expect(s?.error).toMatch(/rejected|fetch first|non-fast-forward/i);
  expect(s?.error).not.toContain(origin);
  expect(git(origin, "rev-parse", "main")).toBe(before);
});

test("a push that hangs is stopped, and two failures in a row are a probe alert", async () => {
  const { root } = brain();
  let killed = 0;
  const hang = () => ({ exited: new Promise<number>(() => {}), kill: () => { killed++; }, stderr: undefined });
  await pushOriginApart(root, { spawn: hang, timeoutMs: 30 });
  expect(killed).toBe(1);
  expect(jobChecks(root).find((c) => c.name === "origin")?.ok).toBe(true);
  const s = await pushOriginApart(root, { spawn: hang, timeoutMs: 30 });
  expect(s?.fails).toBe(2);
  const c = jobChecks(root).find((c) => c.name === "origin");
  expect(c?.ok).toBe(false);
  expect(c?.detail).toMatch(/didn't finish/);
  // The next good push clears it.
  await pushOriginApart(root);
  expect(jobChecks(root).find((c) => c.name === "origin")?.ok).toBe(true);
});

// A hub that restarts more often than hourly (each update kickstarts it) never reached its first
// hourly push: 335 commits sat on the Mac on 2026-10-24 and log/origin-push.json was never written.
// On start, the push and the backup each get one early run when their last one is over its hour old.
function timers() {
  const once: { ms: number; fn: () => unknown }[] = [];
  const every: { ms: number; fn: () => unknown }[] = [];
  return { once, every, after: (fn: () => unknown, ms: number) => { once.push({ fn, ms }); }, repeat: (fn: () => unknown, ms: number) => { every.push({ fn, ms }); } };
}

test("a restart within the hour still pushes soon when origin was never pushed", async () => {
  const { root, origin } = brain();
  const t = timers();
  startBackupTimers(root, { after: t.after, every: t.repeat, backup: async () => undefined });
  const first = t.once.filter((x) => x.ms < 15 * 60_000);
  expect(first.length).toBeGreaterThan(0);
  for (const x of first) await x.fn();
  expect(git(origin, "rev-parse", "main")).toBe(git(root, "rev-parse", "HEAD"));
  expect(t.every.some((x) => x.ms === 3600000)).toBe(true);
});

test("on start, a push from 10 minutes ago waits for the hour; one from 2 hours ago runs early", async () => {
  const { root, origin } = brain();
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "origin-push.json"), JSON.stringify({ at: new Date(Date.now() - 10 * 60_000).toISOString(), fails: 0 }));
  let t = timers();
  startBackupTimers(root, { after: t.after, every: t.repeat, backup: async () => undefined });
  for (const x of t.once) await x.fn();
  expect(git(origin, "rev-parse", "--verify", "-q", "main")).toBe("");
  writeFileSync(join(root, "log", "origin-push.json"), JSON.stringify({ at: new Date(Date.now() - 2 * 3600_000).toISOString(), fails: 0 }));
  t = timers();
  startBackupTimers(root, { after: t.after, every: t.repeat, backup: async () => undefined });
  for (const x of t.once) await x.fn();
  expect(git(origin, "rev-parse", "main")).toBe(git(root, "rev-parse", "HEAD"));
});

test("on start, the backup gets its look early too, not only after an hour", async () => {
  const { root } = brain({ push: false });
  const t = timers();
  let looks = 0;
  startBackupTimers(root, { after: t.after, every: t.repeat, backup: async () => { looks++; return undefined; } });
  for (const x of t.once.filter((x) => x.ms < 15 * 60_000)) await x.fn();
  expect(looks).toBe(1);
  expect(t.every.some((x) => x.ms === 3600000)).toBe(true);
});

test("each backup look leaves its time, and doctor says how long ago the last one was", async () => {
  const { root } = brain({ push: false });
  const t = timers();
  startBackupTimers(root, { after: t.after, every: t.repeat, backup: async () => undefined });
  for (const x of t.once) await x.fn();
  expect(lastLook(root)?.at).toBeDefined();
  expect(backupFindings(root).map((f) => f.text).join("\n")).toMatch(/last backup look \d+ min ago/);
});
