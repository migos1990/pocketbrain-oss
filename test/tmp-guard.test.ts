// SPDX-License-Identifier: AGPL-3.0-only
// A test run must leave no temp brains behind: thousands of leftover pb-* folders once filled
// a build machine's disk and blocked every merge.
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "bun";

test("temp folders made during a run live inside the run's own folder", () => {
  const run = process.env.PB_TEST_RUN_DIR;
  expect(run).toBeTruthy();
  expect(tmpdir().startsWith(run!)).toBe(true);
});

test("no test or source file makes temp folders under a hard-coded /tmp", () => {
  const bad: string[] = [];
  for (const dir of ["test", "src", "evals/lib"]) {
    for (const f of readdirSync(dir, { recursive: true }) as string[]) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(join(dir, f), "utf8");
      if (/mkdtemp\w*\(\s*["'`]\/tmp/.test(text)) bad.push(join(dir, f));
    }
  }
  expect(bad).toEqual([]);
});

test("a test file that makes temp brains leaves its temp folder empty", () => {
  const outer = mkdtempSync(join(process.env.PB_REAL_TMPDIR ?? tmpdir(), "pb-guard-"));
  try {
    const r = spawnSync(["bun", "test", "test/jobs.test.ts"], { env: { ...process.env, TMPDIR: outer, PB_TEST_RUN_DIR: "", PB_CONFIG_DIR: "" }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(readdirSync(outer)).toEqual([]);
  } finally { rmSync(outer, { recursive: true, force: true }); }
}, 60_000);
