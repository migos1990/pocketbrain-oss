// SPDX-License-Identifier: AGPL-3.0-only
// The suite runs the same on every machine (backlog #278): git never reads the machine's own
// config, and a missing tool stops the run with one line instead of scattered failures and skips.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingTools } from "./tools";

const ROOT = join(import.meta.dir, "..");

test("git in a test run never reads the machine's global config: a global signer that fails can't fail a commit", () => {
  const home = mkdtempSync(join(tmpdir(), "pb-home-"));
  writeFileSync(join(home, ".gitconfig"), "[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n\tprogram = /nonexistent/signer\n[gpg \"ssh\"]\n\tprogram = /nonexistent/signer\n");
  const repo = join(home, "r"); mkdirSync(repo);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo, env });
  const c = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: repo, env, stderr: "pipe" });
  expect(c.stderr.toString()).toBe("");
  expect(c.exitCode).toBe(0);
});

test("a missing tool is named once with how to get it, unless the run allows it", () => {
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const m = missingTools("");
    for (const n of ["ssh-keygen", "age", "ffmpeg"]) expect(m.some((l) => l.startsWith(`${n} (for `) && l.includes("install"))).toBe(true);
    expect(missingTools("ssh-keygen,age,ffmpeg,python3,chromium")).toEqual([]);
  } finally { process.env.PATH = saved; }
});

test("bun test stops at once on a machine without a tool, naming it", () => {
  const env: Record<string, string> = { ...process.env, PATH: `/nonexistent:${process.env.PATH}` } as Record<string, string>;
  delete env.PB_TEST_RUN_DIR;
  const bare = mkdtempSync(join(tmpdir(), "pb-bare-"));
  // A PATH with bun and git only: no age, no ssh-keygen, no ffmpeg.
  for (const t of ["bun", "git", "sh"]) Bun.spawnSync(["ln", "-s", Bun.which(t)!, join(bare, t)]);
  env.PATH = bare;
  const r = Bun.spawnSync([join(bare, "bun"), "test", "test/access-request.test.ts"], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const out = r.stdout.toString() + r.stderr.toString();
  expect(r.exitCode).not.toBe(0);
  expect(out).toContain("the test suite needs tools this machine lacks");
  expect(out).toContain("age (for encrypted backups)");
});
