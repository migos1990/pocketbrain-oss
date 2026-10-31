// SPDX-License-Identifier: AGPL-3.0-only
// Slice audit 3 of claude/cli-token-pem: every line of log/alerts.jsonl goes through util.alert
// (G312); a relay message id is kept as sent unless it carries a hard secret, so two ids never
// share a record (G313); the invite lock fails fast and stays its holder's, the counter fails
// closed on a bad shape, blanked alerts keep who they are about, nested keys are scrubbed, the
// last blanking level is checked, an edge enroll that fails takes its token back, and a code
// redeemed at /v1/enroll is a token_minted alert (G314).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, utimesSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { runAction } from "../src/dashboard/actions";
import { resetEnrollLimits, redeemInvite, withInviteLock } from "../src/invite";
import { mailOnce } from "../src/intake";
import { handOff } from "../src/handoff";
import { relayOnce, fileTransport, decideHeld, relayCheck } from "../src/relay";
import { secretIn } from "../src/backup";
import { alert } from "../src/util";

const SRC = join(import.meta.dir, "..", "src");
function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } finally { console.log = log; console.error = err; }
  const text = out.join("\n");
  return { code, out: text, token: text.match(/pb_[A-Za-z0-9-]+_[A-Za-z0-9_-]{20,}/)?.[0] };
}
const codeOf = (s: string) => s.match(/[0-9A-Z]{5}-[0-9A-Z]{5}/)![0];
const tracked = (root: string) => Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString().trim().split("\n").filter(Boolean);
const leaks = (root: string) => tracked(root).map((f) => [f, existsSync(join(root, f)) ? secretIn(readFileSync(join(root, f), "utf8")) : undefined]).filter(([, s]) => s);
const alerts = (root: string) => existsSync(join(root, "log/alerts.jsonl")) ? readFileSync(join(root, "log/alerts.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const KEY_HEAD = () => "-----BEGIN OPENSSH PRIVATE " + "KEY-----";
const KEY_BODY = () => "b3BlbnNzaC1rZXktdjEAAAAA" + "BG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
const lockFile = (root: string) => join(root, ".git", "pb-invites.lock");

test("G312: a stranger's key-shaped From address at the capture mailbox never reaches a committed alerts.jsonl", async () => {
  const root = makeBrain();
  const from = "sk-proj-" + "abcdefghijklmnopqrstuvwx1234" + "@evil.example";
  const items = [{ id: "m1", from: `X <${from}>`, to: "capture@x", subject: "hi", text: "hello", date: new Date().toISOString() }];
  await mailOnce(root, { name: "fake", fetchNew: () => items as never, done: () => {} }, { allowed_from: ["owner@x.example"] } as never);
  expect(alerts(root).some((a) => a.check === "capture_mail_sender")).toBe(true);
  const r = await handOff(root, "planner", { to: "helper", task: "Draft the Friday agenda", next_step: "Send it." }, { model: null });
  await r.settled;
  expect(leaks(root)).toEqual([]);
});

test("G312: util.alert is the only writer of log/alerts.jsonl in src/", () => {
  const writers: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".ts")) { const t = readFileSync(p, "utf8"); if (/alerts\.jsonl/.test(t) && /(appendFileSync|appendJsonl|writeFileSync)\([^\n]*alerts\.jsonl/.test(t)) writers.push(p.slice(SRC.length + 1)); } } };
  walk(SRC);
  expect(writers).toEqual(["util.ts"]);
});

test("G313: two mail ids that differ only in a card-number-shaped run keep two records; the held one can still be released", () => {
  const root = makeBrain();
  mkdirSync(join(root, "relay/incoming"), { recursive: true });
  writeFileSync(join(root, "relay/incoming/a.json"), JSON.stringify({ id: "msg-4111111111111111", from: "planner@brain.example", to: ["relay+helper@brain.example"], subject: "q", text: "the key is sk-" + "a".repeat(24) }));
  relayOnce(root, fileTransport(root));
  writeFileSync(join(root, "relay/incoming/b.json"), JSON.stringify({ id: "msg-5500000000000004", from: "planner@brain.example", to: ["relay+helper@brain.example"], subject: "lunch", text: "Lunch at noon?" }));
  relayOnce(root, fileTransport(root));
  const day = readdirSync(join(root, "comms"))[0];
  expect(readdirSync(join(root, "comms", day)).length).toBe(2);
  expect(decideHeld(root, fileTransport(root), "msg-4111111111111111", "release")).toContain("released-by-owner");
});

test("G313: every hook id relayCheck hands back finds its record", () => {
  const root = makeBrain();
  const missed: string[] = [];
  for (let i = 0; i < 40; i++) {
    const h = relayCheck(root, { from: "helper", to: "planner", text: "Which credit card should I use?", via: "x" });
    if (decideHeld(root, fileTransport(root), h.id, "drop").startsWith("no held message")) missed.push(h.id);
  }
  expect(missed).toEqual([]);
}, 120_000);

test("G314: a lock with a future mtime is stale, and the hub's /v1/enroll never waits on a held lock", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  writeFileSync(lockFile(root), "planted");
  const future = new Date(Date.now() + 3_600_000);
  utimesSync(lockFile(root), future, future);
  let t = Date.now();
  const r = run(root, "token", "--agent", "steward", "--code", code);
  expect([r.code, Date.now() - t < 5_000]).toEqual([0, true]);
  // A live lock (another redeem in progress): /v1/enroll answers at once, busy, without spending.
  const code2 = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  writeFileSync(lockFile(root), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "someone-else" }));
  t = Date.now();
  const e = redeemInvite(root, code2);
  expect([("status" in e) && e.status, Date.now() - t < 1_000]).toEqual([503, true]);
});

test("G314: the lock is released only by its holder", () => {
  const root = makeBrain();
  withInviteLock(root, () => { writeFileSync(lockFile(root), "another holder took it over"); });
  expect(existsSync(lockFile(root))).toBe(true);
  expect(readFileSync(lockFile(root), "utf8")).toBe("another holder took it over");
});

test("G314: a counter that isn't a list of times fails closed", () => {
  for (const bad of ["{}", "not json", '["x"]']) {
    resetEnrollLimits();
    const root = makeBrain();
    const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
    writeFileSync(join(root, ".git/pb-enroll-fails.json"), bad);
    const r = run(root, "token", "--agent", "steward", "--code", code);
    expect([bad, r.code, r.token]).toEqual([bad, 1, undefined]);
  }
});

test("G314: a blanked alert keeps the agents it is about; nested keys are scrubbed", () => {
  const root = makeBrain();
  alert(root, { check: "relay", from: "planner", to: "helper", reasons: [KEY_HEAD(), KEY_BODY()] });
  alert(root, { check: "relay", from: "stranger@evil.example", reasons: [KEY_HEAD(), KEY_BODY()] });
  alert(root, { check: "x", detail: { ["AKIA" + "ABCDEFGHIJKLMNOP"]: 1 } });
  const [a, b] = alerts(root);
  expect([a.from, a.to]).toEqual(["planner", "helper"]);
  expect(b.from).not.toContain("@");
  expect(secretIn(readFileSync(join(root, "log/alerts.jsonl"), "utf8"))).toBeUndefined();
});

test("G314: the last blanking level is checked too: a key in the received time never reaches the record", () => {
  const root = makeBrain();
  mkdirSync(join(root, "relay/incoming"), { recursive: true });
  writeFileSync(join(root, "relay/incoming/t.json"), JSON.stringify({ id: "t1", from: "planner@brain.example", to: ["relay+helper@brain.example"], subject: "Course A", text: "Can you draft the midterm reminder?", received_at: `${KEY_HEAD()}\n${KEY_BODY()}` }));
  relayOnce(root, fileTransport(root));
  expect(leaks(root)).toEqual([]);
});

test("G314: an edge enroll that fails after the mint takes the token back", () => {
  const root = makeBrain();
  const prev = process.env.PB_CONFIG_DIR;
  const f = join(mkdtempSync(join(tmpdir(), "pb-cfg-")), "file");
  writeFileSync(f, "not a folder");
  process.env.PB_CONFIG_DIR = join(f, "keys");
  try {
    const r = run(root, "edge", "enroll", "helper");
    expect(r.code).toBe(1);
  } finally { if (prev === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = prev; }
  const t = existsSync(join(root, "rules/tokens.yaml")) ? YAML.parse(readFileSync(join(root, "rules/tokens.yaml"), "utf8")) : {};
  expect(t?.agents?.helper ?? []).toEqual([]);
});

test("G314: a code redeemed at /v1/enroll is a token_minted alert", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
  expect("token" in redeemInvite(root, code)).toBe(true);
  expect(alerts(root).filter((a) => a.check === "token_minted").map((a) => a.agent)).toEqual(["steward"]);
});
