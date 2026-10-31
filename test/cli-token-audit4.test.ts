// SPDX-License-Identifier: AGPL-3.0-only
// Slice audit 4 of claude/cli-token-pem: the invite lock never exists empty, so a reader can't take
// a live holder's lock for a stale one, and one code started in many terminals at the same instant
// mints one token (G335); a revoke under a held lock can't leave the agent's open code working
// after its keys are gone, and its sign-ins go whatever happens (G336); no src file but util.ts
// writes log/alerts.jsonl, however the path is built (G338).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeBrain } from "./fixture";
import { runAction } from "../src/dashboard/actions";
import { resetEnrollLimits, redeemInvite, withInviteLock, InviteLockBusy } from "../src/invite";
import { revokeTokens, tokenInfo, issueToken } from "../src/auth";
import { setupOAuth, bindClient, clientsOf } from "../src/oauth";

const APP = join(import.meta.dir, "..");
const SRC = join(APP, "src");
const codeOf = (s: string) => s.match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
const lockFile = (root: string) => join(root, ".git", "pb-invites.lock");

test("G335: a lock just created and not yet filled in is live, never taken over", () => {
  const root = makeBrain();
  writeFileSync(lockFile(root), ""); // the moment between create and write, as another process sees it
  let ran = false;
  expect(() => withInviteLock(root, () => { ran = true; })).toThrow(InviteLockBusy);
  expect([ran, readFileSync(lockFile(root), "utf8")]).toEqual([false, ""]);
});

// A stress check, not the proof: without the G335 fix it double-spent in only about 2 of 15 trials,
// so it can pass on unfixed code. The tests that always fail without the fix are the empty-lock test
// above and the half-written-lock test in test/cli-token-audit5.test.ts.
test("G335: one code, twelve terminals released at the same instant, fifteen times: one token each time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-barrier-"));
  const child = join(dir, "spend.ts");
  writeFileSync(child, `const { main } = await import(${JSON.stringify(join(SRC, "cli.ts"))});
const [root, code, at] = [process.argv[2], process.argv[3], Number(process.argv[4])];
while (Date.now() < at) {}
const out: string[] = []; const log = console.log;
console.log = (...a: unknown[]) => { out.push(a.join(" ")); }; console.error = console.log;
main(["token", "--agent", "steward", "--code", code, "--brain", root]);
console.log = log; log(/pb_steward_/.test(out.join("\\n")) ? "MINTED" : "refused");
`);
  const minted: number[] = [];
  for (let trial = 0; trial < 15; trial++) {
    resetEnrollLimits();
    const root = makeBrain();
    const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
    const at = Date.now() + 2_500;
    const procs = Array.from({ length: 12 }, () => Bun.spawn(["bun", child, root, code, String(at)], { cwd: APP, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-cfg-")) } }));
    const outs = await Promise.all(procs.map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    minted.push(outs.filter((o) => o.includes("MINTED")).length);
  }
  rmSync(dir, { recursive: true, force: true });
  expect(minted).toEqual(Array(15).fill(1));
}, 300_000);

test("G336: a revoke under a held lock never leaves the agent's open code working after its keys are gone; its sign-ins go regardless", () => {
  resetEnrollLimits();
  const root = makeBrain();
  setupOAuth(root, { issuer: "https://auth.example", resource: "https://hub.example/mcp/oauth", owner_subject: "user_owner" });
  bindClient(root, "client-steward-1", "steward");
  issueToken(root, "steward");
  const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  writeFileSync(lockFile(root), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "someone-else" }));
  let threw = false;
  try { revokeTokens(root, "steward"); } catch { threw = true; }
  rmSync(lockFile(root), { force: true });
  expect(clientsOf(root, "steward")).toEqual([]);
  const keysLeft = (tokenInfo(root).steward ?? []).length;
  const after = redeemInvite(root, code);
  // Either the revoke finished (no keys, the code cancelled) or it refused before touching a key.
  expect(threw ? [keysLeft > 0, true] : [keysLeft, "token" in after]).toEqual(threw ? [true, true] : [0, false]);
  if (!threw) return;
  // Run again once the lock is free: now it all goes, the code included.
  const code2 = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  revokeTokens(root, "steward");
  expect([(tokenInfo(root).steward ?? []).length, "token" in redeemInvite(root, code2)]).toEqual([0, false]);
}, 60_000);

test("G338: no src file but util.ts names alerts.jsonl except to read it", () => {
  const reads = /readJsonl\b|jsonl\(|readFileSync|existsSync|statSync/;
  // The overview's ?alerts= page number (dashboard/html.ts) is a URL parameter, not the log.
  const queryParam = /q\.get\(["'`]alerts["'`]\)|withParam\([^)]*["'`]alerts["'`]/;
  const writers: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!p.endsWith(".ts") || p === join(SRC, "util.ts")) continue;
      readFileSync(p, "utf8").split("\n").forEach((l, i) => {
        if (/alerts\.jsonl|["'`]alerts["'`]\s*[,)+]/.test(l) && !/^\s*\/\//.test(l) && !reads.test(l) && !queryParam.test(l)) writers.push(`${p.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
  };
  walk(SRC);
  expect(writers).toEqual([]);
});
