// SPDX-License-Identifier: AGPL-3.0-only
// Slice audit 5 of claude/cli-token-pem: a planted `.break` dated in the future, or a breaker that
// holds `.break`, can't make an invite-lock caller spin; every loop path answers busy at its
// deadline (G351). A half-written lock is live, never taken over (G335, deterministic). A revoke
// that fails on a held lock still leaves the agent paused, and a share end still ends the share
// and lets the coworker go (G352).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeBrain } from "./fixture";
import { runAction } from "../src/dashboard/actions";
import { resetEnrollLimits, redeemInvite, withInviteLock, InviteLockBusy } from "../src/invite";
import { loadRules } from "../src/rules";
import { setupOAuth, addCoworker, loadOAuth } from "../src/oauth";
import { addShare, endShare } from "../src/share";
import { issueToken } from "../src/auth";

const SRC = join(import.meta.dir, "..", "src");
const codeOf = (s: string) => s.match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
const lockFile = (root: string) => join(root, ".git", "pb-invites.lock");
const deadPid = () => { const p = Bun.spawnSync(["true"]); return p.pid; };
const deadLock = () => JSON.stringify({ pid: deadPid(), at: new Date().toISOString(), token: "crashed-holder" });
const liveLock = () => JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "someone-else" });

// The old code spins forever in a synchronous loop, so the redeem runs in its own process, killed
// at 10 s.
function redeemApart(root: string, code: string, cli = false) {
  const dir = mkdtempSync(join(tmpdir(), "pb-brk-"));
  const f = join(dir, "one.ts");
  writeFileSync(f, cli
    ? `const { main } = await import(${JSON.stringify(join(SRC, "cli.ts"))}); const log = console.log; const out: string[] = []; console.log = console.error = (...a: unknown[]) => { out.push(a.join(" ")); }; const c = main(["token", "--agent", "steward", "--code", ${JSON.stringify(code)}, "--brain", ${JSON.stringify(root)}]); log("exit", c, /pb_steward_/.test(out.join("\\n")) ? "MINTED" : "refused");`
    : `const { redeemInvite } = await import(${JSON.stringify(join(SRC, "invite.ts"))}); const r = redeemInvite(${JSON.stringify(root)}, ${JSON.stringify(code)}); console.log("status" in r ? "status " + r.status : "MINTED");`);
  const t = Date.now();
  const p = Bun.spawnSync(["bun", f], { timeout: 10_000, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-cfg-")) } });
  rmSync(dir, { recursive: true, force: true });
  return { ms: Date.now() - t, killed: p.exitCode === null || p.signalCode != null, out: p.stdout.toString().trim() };
}

test("G351: a dead holder's lock and a .break dated tomorrow can't make /v1/enroll or the terminal spin", () => {
  for (const cli of [false, true]) {
    resetEnrollLimits();
    const root = makeBrain();
    const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
    writeFileSync(lockFile(root), deadLock());
    writeFileSync(lockFile(root) + ".break", "planted");
    const tomorrow = new Date(Date.now() + 86_400_000);
    utimesSync(lockFile(root) + ".break", tomorrow, tomorrow);
    const r = redeemApart(root, code, cli);
    expect([cli, r.killed, r.out.includes("MINTED")]).toEqual([cli, false, true]);
  }
}, 60_000);

test("G351: the stale-lock path checks the deadline too: /v1/enroll answers busy at once while another breaker holds .break", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  writeFileSync(lockFile(root), deadLock());
  writeFileSync(lockFile(root) + ".break", "a breaker at work"); // fresh: someone is breaking it now
  const t = Date.now();
  const e = redeemInvite(root, code);
  expect([("status" in e) && e.status, Date.now() - t < 1_000]).toEqual([503, true]);
});

test("G335: a half-written lock is live, never taken over", () => {
  const root = makeBrain();
  writeFileSync(lockFile(root), '{"pid":');
  let ran = false;
  expect(() => withInviteLock(root, () => { ran = true; })).toThrow(InviteLockBusy);
  expect([ran, readFileSync(lockFile(root), "utf8")]).toEqual([false, '{"pid":']);
});

test("G352: a dashboard revoke that fails on a held lock still leaves the agent paused", () => {
  resetEnrollLimits();
  const root = makeBrain();
  issueToken(root, "steward");
  writeFileSync(lockFile(root), liveLock());
  expect(() => runAction({ root }, "agent-revoke", { agent: "steward" })).toThrow();
  rmSync(lockFile(root), { force: true });
  expect(loadRules(root).policy.agents.steward.status).toBe("paused");
}, 30_000);

test("G352: a share end that fails on a held lock still ends the share, pauses it and lets the coworker go", () => {
  const root = makeBrain();
  setupOAuth(root, { issuer: "https://as.example", resource: "https://brain.example/mcp/oauth", owner_subject: "user_owner" });
  addShare(root, { agent: "alice", name: "Alice Roy", slices: ["area:work"], days: 30 });
  addCoworker(root, "user_alice", "Alice Roy", "alice");
  issueToken(root, "alice");
  writeFileSync(lockFile(root), liveLock());
  expect(() => endShare(root, "alice")).toThrow();
  rmSync(lockFile(root), { force: true });
  const a = loadRules(root).policy.agents.alice;
  expect([a.status, !!a.collaborator?.ended, loadOAuth(root)!.coworkers ?? {}]).toEqual(["paused", true, {}]);
  // Run again once the lock is free: its keys go.
  expect(endShare(root, "alice")).toMatch(/share ended/);
}, 30_000);
