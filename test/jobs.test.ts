// SPDX-License-Identifier: AGPL-3.0-only
// Silent failures the probe now catches without the network: the nightly pass or the digest not
// running or failing, backups gone stale, texts that stopped going out.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { keysDir } from "../src/secrets";
import { makeBrain } from "./fixture";
import { jobChecks, record } from "../src/probe";
import { recordJob, tendOnce } from "../src/start";
import { bar } from "../src/measure";

const NOW = new Date("2026-10-20T12:00:00Z");
const state = (root: string, s: Record<string, unknown>) => { mkdirSync(join(root, "log"), { recursive: true }); writeFileSync(join(root, "log", "start-state.json"), JSON.stringify(s)); };
const byName = (root: string) => Object.fromEntries(jobChecks(root, NOW).map((c) => [c.name, c]));

test("a brain that never ran the hub has no job checks", () => {
  expect(jobChecks(makeBrain(), NOW)).toEqual([]);
});

test("the nightly pass and the digest fail their check when they last ran over 36 hours ago or threw", () => {
  const root = makeBrain();
  state(root, { night: "2026-10-18", night_at: "2026-10-18T07:00:00Z", digest: "2026-10-20", digest_at: "2026-10-20T11:00:00Z" });
  expect(byName(root).night).toMatchObject({ ok: false });
  expect(byName(root).night.detail).toContain("last ran 2026-10-18");
  expect(byName(root).digest.ok).toBe(true);
  recordJob(root, "digest", new Error("disk full"), NOW);
  expect(byName(root).digest).toMatchObject({ ok: false, detail: "digest failed: disk full" });
  recordJob(root, "digest", undefined, NOW);
  expect(byName(root).digest.ok).toBe(true);
});

test("texts that keep failing to send are a failing check", () => {
  const root = makeBrain();
  mkdirSync(join(root, "textline"), { recursive: true });
  const f = join(root, "textline", "log.jsonl");
  appendFileSync(f, JSON.stringify({ at: "2026-10-20T08:00:00Z", sent: "a", via: "imessage", ok: true }) + "\n");
  expect(byName(root).texts.ok).toBe(true);
  for (const id of ["b", "c", "d"]) appendFileSync(f, JSON.stringify({ at: "2026-10-20T09:00:00Z", sent: id, via: "imessage", ok: false, detail: "osascript: not allowed" }) + "\n");
  expect(byName(root).texts).toMatchObject({ ok: false });
  expect(byName(root).texts.detail).toContain("osascript: not allowed");
});

test("a stale backup is a failing check once backups are set up", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "backup.yaml"), "dest: /tmp/nowhere\nevery_hours: 24\n");
  mkdirSync(join(root, "log"), { recursive: true });
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(root, "log", "last-backup"), JSON.stringify({ at: "2026-10-16T03:00:00Z", file: "brain-2026-10-16.tar.age", head, sha256: "x", bytes: 1 }) + "\n");
  writeFileSync(join(root, "moved.md"), "moved\n");
  git("add", "moved.md"); git("commit", "-qm", "moved");
  const c = byName(root).backup;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("2026-10-16");
});

test("a check that is still failing keeps the real-use bar from being met", () => {
  const root = makeBrain();
  record(root, [{ name: "texts", ok: false, detail: "last 3 texts failed" }], NOW);
  expect(bar(root).text).toContain("open problem: texts");
});

test("a model key the owner set up but the hub didn't load is a failing check; none set up means no check", () => {
  const root = makeBrain();
  const dir = mkdtempSync(join(tmpdir(), "pb-keys-"));
  const was = { cfg: process.env.PB_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY };
  process.env.PB_CONFIG_DIR = dir;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    expect(byName(root).model).toBeUndefined();
    mkdirSync(join(dir, "keys"), { recursive: true });
    writeFileSync(join(dir, "keys", "ANTHROPIC_API_KEY"), "sk-test", { mode: 0o644 });
    expect(byName(root).model).toMatchObject({ ok: false });
    expect(byName(root).model.detail).toContain("ANTHROPIC_API_KEY");
    expect(byName(root).model.detail).not.toContain("sk-test");
    process.env.ANTHROPIC_API_KEY = "sk-test";
    expect(byName(root).model.ok).toBe(true);
  } finally {
    if (was.cfg === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = was.cfg;
    if (was.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = was.key;
  }
});

test("auto-update: no check until it runs; then a rollback, a block or a pass that stopped running is failing", () => {
  const root = makeBrain();
  // Its own config folder: other test files clear PB_CONFIG_DIR, and the real one must never be touched.
  const keep = process.env.PB_CONFIG_DIR;
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-config-"));
  const file = join(dirname(keysDir()), "deploy.json");
  try {
  expect(byName(root).update).toBeUndefined();
  mkdirSync(dirname(file), { recursive: true });
  const put = (s: Record<string, string>) => writeFileSync(file, JSON.stringify(s));
  put({ status: "deployed", detail: "deployed v0.2.0 (was v0.1.0); hub healthy", checked_at: "2026-10-20T11:50:00Z" });
  expect(byName(root).update).toMatchObject({ ok: true, detail: "auto-update deployed: deployed v0.2.0 (was v0.1.0); hub healthy" });
  for (const status of ["rolled-back", "down", "blocked", "error"]) {
    put({ status, detail: "x", checked_at: "2026-10-20T11:50:00Z" });
    expect(byName(root).update.ok).toBe(false);
  }
  put({ status: "held", detail: "on hold", checked_at: "2026-10-20T11:50:00Z" });
  expect(byName(root).update.ok).toBe(true);
  put({ status: "current", detail: "running v0.2.0", checked_at: "2026-10-20T07:00:00Z" });
  expect(byName(root).update).toMatchObject({ ok: false, detail: "auto-update last ran 2026-10-20T07:00, over 3h ago; is com.pocketbrain.update loaded?" });
  } finally { if (keep === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = keep; }
});

test("a gardener cleanup or rotation that throws is recorded and fails the probe, instead of only a log line", () => {
  const root = makeBrain();
  const lock = join(mkdtempSync(join(tmpdir(), "pb-lock-")), "claude-lock.json");
  writeFileSync(lock, "{not json");
  writeFileSync(join(root, "rules", "gardener.yaml"), `ant_profile: pocketbrain\nlock_file: ${lock}\n`);
  const lines: string[] = [];
  tendOnce(root, (s) => lines.push(s), new Date(2026, 9, 20, 6, 0)); // 06:00 local: cleanup is due
  expect(lines.join("\n")).toContain("gardener cleanup failed");
  expect(byName(root).gardener_cleanup).toMatchObject({ ok: false });
  expect(byName(root).gardener_cleanup.detail).toContain("gardener_cleanup failed");
  // Fixed: the next run clears it.
  writeFileSync(lock, JSON.stringify({ resources: {} }));
  recordJob(root, "gardener_cleanup", undefined, NOW);
  expect(byName(root).gardener_cleanup.ok).toBe(true);
});

test("a broken rules/gardener.yaml stops the gardener jobs loudly, not silently", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "gardener.yaml"), "ant_profile: [unclosed\n");
  const lines: string[] = [];
  tendOnce(root, (s) => lines.push(s), new Date(2026, 9, 20, 6, 0));
  expect(byName(root).gardener_jobs).toMatchObject({ ok: false });
});

test("a rotation that reports failure without throwing also fails the probe", () => {
  const root = makeBrain();
  const lock = join(mkdtempSync(join(tmpdir(), "pb-lock-")), "claude-lock.json");
  writeFileSync(lock, JSON.stringify({ resources: {} })); // no vault: rotate returns ok: false
  writeFileSync(join(root, "rules", "gardener.yaml"), `ant_profile: pocketbrain\nlock_file: ${lock}\nmcp_url: https://brain.example.com/mcp\n`);
  tendOnce(root, () => {}, new Date(2026, 9, 18, 13, 30)); // Sunday 13:30: rotation is due
  expect(byName(root).gardener_rotate).toMatchObject({ ok: false });
  expect(byName(root).gardener_rotate.detail).toContain("no vault");
});

// Mac 2026-10-25: a Sunday rotation failed for want of mcp_url; the owner set it, but rotation runs
// only on Sundays (and only for an old token), so the alert stayed open. A failed one is retried daily.
test("a failed rotation is tried again the next day at 13:00, so fixing its cause closes it", () => {
  const root = makeBrain();
  const lock = join(mkdtempSync(join(tmpdir(), "pb-lock-")), "claude-lock.json");
  writeFileSync(lock, JSON.stringify({ resources: {} }));
  const cfg = `ant_profile: pocketbrain\nlock_file: ${lock}\n`;
  writeFileSync(join(root, "rules", "gardener.yaml"), cfg);
  tendOnce(root, () => {}, new Date(2026, 9, 18, 13, 30)); // Sunday 13:30: rotation is due
  expect(byName(root).gardener_rotate.detail).toContain("mcp_url");
  writeFileSync(join(root, "rules", "gardener.yaml"), `${cfg}mcp_url: https://brain.example.com/mcp\n`);
  tendOnce(root, () => {}, new Date(2026, 9, 19, 12, 0)); // Monday before 13:00: not yet
  expect(byName(root).gardener_rotate.detail).toContain("mcp_url");
  tendOnce(root, () => {}, new Date(2026, 9, 19, 13, 30)); // Monday 13:30: tried again, now past mcp_url
  expect(byName(root).gardener_rotate.detail).toContain("no vault");
});

test("without a failed rotation, rotation still runs only on Sundays", () => {
  const root = makeBrain();
  const lock = join(mkdtempSync(join(tmpdir(), "pb-lock-")), "claude-lock.json");
  writeFileSync(lock, JSON.stringify({ resources: {} }));
  writeFileSync(join(root, "rules", "gardener.yaml"), `ant_profile: pocketbrain\nlock_file: ${lock}\nmcp_url: https://brain.example.com/mcp\n`);
  tendOnce(root, () => {}, new Date(2026, 9, 19, 13, 30)); // Monday 13:30
  expect(byName(root).gardener_rotate).toBeUndefined();
});

// Mac audit 2026-10-16: session cleanup had never run, yet its check was green. A cleanup that
// returns without running (no deployments, no ant CLI) is a failing check, not a quiet success.
test("a gardener cleanup that couldn't run fails the probe, with why", () => {
  for (const [lockBody, ant, why] of [
    [JSON.stringify({ resources: {} }), "ant", "no deployments"],
    [JSON.stringify({ resources: { "./agents/gardener/deployment-nightly.yaml": { id: "dep_1" } } }), "/nonexistent/ant", "isn't installed"],
  ]) {
    const root = makeBrain();
    const lock = join(mkdtempSync(join(tmpdir(), "pb-lock-")), "claude-lock.json");
    writeFileSync(lock, lockBody);
    writeFileSync(join(root, "rules", "gardener.yaml"), `ant_profile: pocketbrain\nant: ${ant}\nlock_file: ${lock}\n`);
    tendOnce(root, () => {}, new Date(2026, 9, 20, 6, 0)); // 06:00 local: cleanup is due
    expect(byName(root).gardener_cleanup).toMatchObject({ ok: false });
    expect(byName(root).gardener_cleanup.detail).toContain(why);
  }
});

// Mac 2026-10-16: the gardener ran managed with no rules/gardener.yaml, so session cleanup and
// token rotation were never scheduled, and nothing said so (doctor printed no cleanup line at all).
test("a managed gardener with no rules/gardener.yaml is a failing check and a doctor warning", async () => {
  const root = makeBrain();
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8") + "night: managed\n");
  expect(byName(root).gardener_setup).toMatchObject({ ok: false });
  expect(byName(root).gardener_setup.detail).toContain("rules/gardener.yaml");
  const { doctor } = await import("../src/doctor");
  const lines = (await doctor(root, { offline: true })).filter((f) => f.area === "gardener");
  expect(lines.some((f) => f.level === "warn" && f.text.includes("rules/gardener.yaml") && f.text.includes("cleanup"))).toBe(true);
  // With the file, the check goes away (cleanup and rotation have their own checks).
  writeFileSync(join(root, "rules", "gardener.yaml"), "ant_profile: pocketbrain\n");
  expect(byName(root).gardener_setup).toBeUndefined();
  // A gardener that runs on the hub (night: local) needs no Anthropic jobs, so no check.
  writeFileSync(p, readFileSync(p, "utf8").replace("night: managed\n", ""));
  expect(byName(makeBrain()).gardener_setup).toBeUndefined();
});
