// SPDX-License-Identifier: AGPL-3.0-only
// Red team #236 (pocketbrain-app-reviews/redteam-236-batches-20-21.md): backups leave out any file
// that holds a secret shape, so a secret that slips into a stored field or a log stops a backup or
// silently drops a hash-chained log from it.
// G182: no_secret_shapes read value, text, title and sources only; an attribute name, share_with or
// a new note's area carrying a key was stored, and every backup refused after that.
// G185: a memory-sync answer or correction note with a secret shape was logged raw to
// log/memsync.jsonl, the backup left the whole log out, and the drill still passed.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import * as ms from "../src/memsync";
import * as bk from "../src/backup";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

// Built at run time so the repo's secret scanner never sees a whole key.
const ghp = "ghp_" + "a1b2c3d4e5".repeat(4);
const akia = "AKIA" + "ABCDEFGHIJKLMNOP";
const keys = () => {
  const k = mkdtempSync(join(tmpdir(), "pb-keys-"));
  Bun.spawnSync(["age-keygen", "-o", join(k, "id")]);
  return { id: join(k, "id"), pub: Bun.spawnSync(["age-keygen", "-y", join(k, "id")]).stdout.toString().trim() };
};
const backupErr = (root: string) => { try { bk.backup(root, { dest: mkdtempSync(join(tmpdir(), "pb-dest-")), recipients: [keys().pub], record: false }); return ""; } catch (e) { return (e as Error).message; } };
const inBrain = (root: string, s: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name === ".git") continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (readFileSync(p, "utf8").includes(s)) out.push(p.slice(root.length + 1)); } };
  walk(root);
  return out;
};
const base = { agent: "planner", id: "projects/course-a", value: "plain", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" };

for (const [name, req, secret] of [
  ["the attribute name", { ...base, attribute: ghp }, ghp],
  ["share_with", { ...base, attribute: "deploy_note", share_with: ["planner", akia] }, akia],
  ["a new note's area (a trial-style proposal)", { ...base, id: undefined, type: "project", title: "Course C", area: akia, attribute: "next_step" }, akia],
  ["a key inside an object value", { ...base, attribute: "deploy_note", value: { [akia]: "x" } }, akia],
] as [string, Record<string, unknown>, string][]) {
  test(`G182: a key in ${name} is refused, stored nowhere, and backups still run`, () => {
    const root = makeBrain();
    const w = write(root, req as never);
    expect({ outcome: w.outcome, check: w.fails?.[0]?.check, stored: inBrain(root, secret), backup: backupErr(root) }).toEqual({ outcome: "refused", check: "no_secret_shapes", stored: [], backup: "" });
  });
}

test("G182: an ordinary write still goes in", () => {
  const root = makeBrain();
  expect(write(root, { ...base, attribute: "deploy_note", share_with: ["planner"] } as never).outcome).toBe("committed");
});

test("G185: a secret-shaped quiz answer is logged redacted, and the memsync log is in the backup and the restore", async () => {
  const k = keys();
  const root = makeBrain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: `Program director ${akia}` }] });
  const log = readFileSync(join(root, "log/memsync.jsonl"), "utf8");
  expect(bk.secretIn(log)).toBeUndefined();
  expect(log).toContain("Program director");
  const b = bk.backup(root, { dest: mkdtempSync(join(tmpdir(), "pb-dest-")), recipients: [k.pub], record: false });
  expect(b.skipped.map((s) => s.path)).not.toContain("log/memsync.jsonl");
  const to = join(mkdtempSync(join(tmpdir(), "pb-new-")), "brain");
  await bk.restore(b.file, { to, identity: k.id });
  expect(existsSync(join(to, "log/memsync.jsonl"))).toBe(true);
});

test("G185: a correction note with a secret shape is logged redacted too", () => {
  const root = makeBrain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Program director" }] });
  const c = ms.state(root).corrections[0];
  ms.approve(root, c.id);
  ms.memoryCheck(root, "helper");
  ms.memoryReply(root, "helper", { corrections: [{ id: c.id, done: false, note: "DEPLOY_API_KEY=" + "abc12345xyz" }] });
  expect(bk.secretIn(readFileSync(join(root, "log/memsync.jsonl"), "utf8"))).toBeUndefined();
});

test("G185: the drill fails when a backup leaves a log/*.jsonl out", async () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "handoffs.jsonl"), JSON.stringify({ note: akia }) + "\n");
  const d = await bk.drill(root);
  expect(d.skipped.map((s) => s.path)).toContain("log/handoffs.jsonl");
  expect(d.ok).toBe(false);
  expect(bk.renderDrill(d)).toContain("LOST: log/handoffs.jsonl");
});
