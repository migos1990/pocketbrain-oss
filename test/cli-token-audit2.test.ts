// SPDX-License-Identifier: AGPL-3.0-only
// Slice audit 2 of claude/cli-token-pem: what a sender writes never reaches a committed file raw,
// reasons and alerts included (G280); a one-time code is spent once even by parallel processes
// (G283); blanking a record keeps who it was from and to, so the owner can still release it, and a
// key in a message id costs only the id (G284); the guess counter fails closed, a terminal's invite
// is checked again when redeemed, held originals don't outlive the decision, `tend --apply` from a
// terminal needs the code (G285); and the ant's error output never carries the token (N11).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, mkdtempSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { tokenOwner } from "../src/auth";
import { runAction } from "../src/dashboard/actions";
import { resetEnrollLimits } from "../src/invite";
import { rotate } from "../src/gardener";
import { handOff, decideHandoff } from "../src/handoff";
import { relayOnce, fileTransport, decideHeld } from "../src/relay";
import { secretIn } from "../src/backup";
import { alert } from "../src/util";

const APP = join(import.meta.dir, "..");
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
const AKIA = () => "AKIA" + "ABCDEFGHIJKLMNOP";
const KEY_HEAD = () => "-----BEGIN OPENSSH PRIVATE " + "KEY-----";
const KEY_BODY = () => "b3BlbnNzaC1rZXktdjEAAAAA" + "BG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";
const mail = (root: string, m: Record<string, unknown>) => {
  mkdirSync(join(root, "relay/incoming"), { recursive: true });
  writeFileSync(join(root, "relay/incoming", `${String(m.id).replace(/[^A-Za-z0-9]/g, "_") || "m"}.json`), JSON.stringify({ from: "planner@brain.example", to: ["relay+helper@brain.example"], subject: "Course A", ...m }));
  return relayOnce(root, fileTransport(root));
};
const comms = (root: string) => { const day = readdirSync(join(root, "comms"))[0]; return readdirSync(join(root, "comms", day)).map((f) => readFileSync(join(root, "comms", day, f), "utf8")); };

test("G280: a key quoted into a handoff's reasons reaches neither the record nor alerts.jsonl", async () => {
  const root = makeBrain();
  const r = await handOff(root, "planner", { to: "helper", task: `How much does Robin make ${AKIA()} per year?`, next_step: "Answer." }, { model: null });
  await r.settled;
  expect(leaks(root)).toEqual([]);
});

test("G280: the same reason in relay mail stays out of alerts.jsonl", () => {
  const root = makeBrain();
  mail(root, { id: "q2", text: `How much does Robin make ${AKIA()} per year?` });
  expect(leaks(root)).toEqual([]);
});

test("G280: alert() never writes a secret shape, whatever field carries it", () => {
  const root = makeBrain();
  alert(root, { check: "x", reasons: [`asks for ${AKIA()}`], detail: { why: `token pb_town_${"Zx9Yw8Vu".repeat(4)}` } });
  alert(root, { check: "y", a: KEY_HEAD(), b: [KEY_BODY()] });
  expect(secretIn(readFileSync(join(root, "log/alerts.jsonl"), "utf8"))).toBeUndefined();
});

test("G283: one code, many terminals at once: exactly one token", async () => {
  for (let trial = 0; trial < 3; trial++) {
    resetEnrollLimits();
    const root = makeBrain();
    const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
    const procs = Array.from({ length: 8 }, () => Bun.spawn(["bun", join(APP, "src/cli.ts"), "token", "--agent", "steward", "--code", code, "--brain", root], { cwd: APP, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-cfg-")) } }));
    const outs = await Promise.all(procs.map(async (p) => { await p.exited; return new Response(p.stdout).text(); }));
    expect([trial, outs.filter((o) => /pb_steward_/.test(o)).length]).toEqual([trial, 1]);
  }
}, 120_000);

test("G284: a held record blanked for a split key keeps from and to, and the owner can release it", () => {
  const root = makeBrain();
  mail(root, { id: "x1", subject: KEY_HEAD(), text: KEY_BODY() });
  const [rec] = comms(root);
  const fm = YAML.parse(rec.match(/^---\n([\s\S]*?)\n---\n/)![1]);
  expect([fm.from, fm.to]).toEqual(["planner", "helper"]);
  expect(secretIn(rec)).toBeUndefined();
  const said = decideHeld(root, fileTransport(root), "x1", "release");
  expect(said).not.toContain("unknown recipient");
});

test("G284: a key header in a delivered message's id costs only the id", () => {
  const root = makeBrain();
  mail(root, { id: KEY_HEAD(), text: `Draft the reminder ${KEY_BODY().slice(0, 24)} please` });
  const [rec] = comms(root);
  const fm = YAML.parse(rec.match(/^---\n([\s\S]*?)\n---\n/)![1]);
  expect(fm.message_id).toMatch(/^id-[0-9a-f]{16}$/);
  expect([fm.from, fm.to, fm.subject]).toEqual(["planner", "helper", "Course A"]);
  expect(rec).toContain("Draft the reminder");
  expect(leaks(root)).toEqual([]);
});

test("G285: the guess counter fails closed when it is missing or not a file", () => {
  for (const spoil of [(p: string) => rmSync(p, { force: true }), (p: string) => { rmSync(p, { force: true }); mkdirSync(p); }]) {
    resetEnrollLimits();
    const root = makeBrain();
    const code = codeOf(runAction({ root }, "token-code", { agent: "steward" }));
    spoil(join(root, ".git/pb-enroll-fails.json"));
    const r = run(root, "token", "--agent", "steward", "--code", code);
    expect([r.code, r.token]).toEqual([1, undefined]);
    expect(r.out).toContain("guess counter");
  }
});

test("G285: a terminal's invite for a narrow agent is refused once the agent is wider", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const code = codeOf(run(root, "invite", "helper").out);
  const pf = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(pf, "utf8")); p.agents.helper.slices = ["all"]; p.agents.helper.tier = "core"; writeFileSync(pf, YAML.stringify(p));
  const t = run(root, "token", "--agent", "helper", "--code", code);
  expect([t.code, t.token]).toEqual([1, undefined]);
});

test("G285: held originals go once nothing can release them: delivered handoffs keep none, decided mail is swept", async () => {
  const root = makeBrain();
  const held = () => { const d = join(root, ".git/pb-held"); return existsSync(d) ? readdirSync(d).filter((f) => !f.startsWith(".")) : []; };
  // A core agent's delivered handoff with a redacted secret keeps no original.
  const h = await handOff(root, "planner", { to: "steward", task: `Course A login: password hunter2xx`, next_step: "Draft it." }, { model: null });
  await h.settled;
  const rec = readFileSync(join(root, "handoffs", readdirSync(join(root, "handoffs"))[0], `${h.id}.md`), "utf8");
  if (/verdict: delivered/.test(rec)) expect(held().filter((f) => f.includes(h.id))).toEqual([]);
  else decideHandoff(root, h.id, "drop");
  // Held mail dropped from the record by hand (as an old hub would leave it) is swept at the next pass.
  mail(root, { id: "s1", subject: KEY_HEAD(), text: KEY_BODY() });
  expect(held().some((f) => f.includes("s1"))).toBe(true);
  decideHeld(root, fileTransport(root), "s1", "drop");
  expect(held().some((f) => f.includes("s1"))).toBe(false);
  mail(root, { id: "s2", subject: KEY_HEAD(), text: KEY_BODY() });
  const day = readdirSync(join(root, "comms"))[0];
  const f = join(root, "comms", day, "s2.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("verdict: held", "verdict: dropped-by-owner"));
  mail(root, { id: "s3", text: "Can you draft the midterm reminder for Course A?" });
  expect(held().some((x) => x.includes("s2"))).toBe(false);
});

test("G285: tend --managed --apply from a terminal without the code is refused, and nothing reaches ant", () => {
  const root = makeBrain();
  const d = mkdtempSync(join(tmpdir(), "pb-ant-"));
  const log = join(d, "argv.log");
  writeFileSync(join(d, "ant"), `#!/bin/sh\necho "$*" >> ${log}\nexit 0\n`);
  chmodSync(join(d, "ant"), 0o755);
  const hub = join(root, "rules/hub.yaml");
  writeFileSync(hub, (existsSync(hub) ? readFileSync(hub, "utf8") : "") + "\npublic_url: https://brain.robin.example\n");
  const r = run(root, "tend", "--managed", "--apply", "--dir", mkdtempSync(join(tmpdir(), "pb-tend-")), "--url", "https://brain.robin.example");
  expect(r.code).toBe(1);
  expect(r.out).toContain("--code");
  expect(existsSync(log) && /credentials create/.test(readFileSync(log, "utf8"))).toBe(false);
});

test("N11: ant's error output never carries a copy of the token into alerts.jsonl", () => {
  const root = makeBrain();
  const d = mkdtempSync(join(tmpdir(), "pb-ant-"));
  const ant = join(d, "ant");
  writeFileSync(ant, `#!/bin/sh\ncase "$*" in\n *"auth status"*) exit 0;;\n *"credentials list"*) echo '[]'; exit 0;;\n *"credentials create"*) x=$(cat | sed 's/.*"token":"\\([^"]*\\)".*/\\1/'); echo "bad $x $x" >&2; exit 1;;\nesac\nexit 0\n`);
  chmodSync(ant, 0o755);
  writeFileSync(join(d, "lock.json"), JSON.stringify({ resources: { "vault.yaml": { id: "vlt_1" } } }));
  writeFileSync(join(root, "rules/gardener.yaml"), `ant: ${ant}\nlock_file: ${join(d, "lock.json")}\nmcp_url: http://127.0.0.1:8787/mcp\n`);
  const r = rotate(root, { code: codeOf(runAction({ root }, "token-code", { agent: "gardener" })) });
  expect(r.ok).toBe(false);
  expect(r.message).not.toMatch(/pb_gardener_/);
  expect(readFileSync(join(root, "log/alerts.jsonl"), "utf8")).not.toMatch(/pb_gardener_[A-Za-z0-9_-]{8}/);
});

test("G285: share add for a share a terminal can't invite for points to the dashboard code, not to invite", () => {
  const root = makeBrain();
  const s = run(root, "share", "add", "sh-one", "--name", "Sam", "--slices", "area:personal,area:work", "--yes");
  expect(s.code).toBe(0);
  expect(s.out).not.toContain("pocketbrain invite sh-one");
  expect(s.out).toContain("One-time code");
});
