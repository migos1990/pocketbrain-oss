// SPDX-License-Identifier: AGPL-3.0-only
// A test run must leave no temp brains behind: thousands of leftover pb-* folders once filled
// a build machine's disk and blocked every merge.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    // What the child printed, so a failure on the CI runner says why (it failed there, 2026-10-30).
    const out = r.exitCode ? (r.stdout.toString() + r.stderr.toString()).split("\n").filter((l) => /fail|error|Error/.test(l)).slice(-20).join("\n") : "";
    expect({ exit: r.exitCode, out }).toEqual({ exit: 0, out: "" });
    expect(readdirSync(outer)).toEqual([]);
  } finally { rmSync(outer, { recursive: true, force: true }); }
}, 60_000);

// A run whose browsers live in the developer's own ~/.cache (GitHub's runner keeps them there):
// test/setup.ts gives the run a HOME of its own, and what the run starts must still find them (G534).
test("what a test run starts finds Playwright's browsers kept under the real home", () => {
  const home = mkdtempSync(join(process.env.PB_REAL_TMPDIR ?? tmpdir(), "pb-guard-home-"));
  try {
    const browsers = dirname(dirname(dirname(require("playwright").chromium.executablePath())));
    mkdirSync(join(home, ".cache"));
    symlinkSync(browsers, join(home, ".cache", "ms-playwright"));
    const probe = join(home, "probe.test.ts");
    writeFileSync(probe, `import { test, expect } from "bun:test";\nimport { existsSync } from "node:fs";\ntest("browsers", () => {\n  const r = Bun.spawnSync(["bun", "-e", "console.log(require('playwright').chromium.executablePath())"], { env: process.env });\n  expect(existsSync(r.stdout.toString().trim())).toBe(true);\n});\n`);
    const env: Record<string, string> = { ...process.env as Record<string, string>, HOME: home, PB_TEST_RUN_DIR: "", PB_CONFIG_DIR: "" };
    delete env.XDG_CACHE_HOME;
    delete env.PLAYWRIGHT_BROWSERS_PATH;
    const r = spawnSync(["bun", "test", probe], { env, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString() + r.stderr.toString();
    expect({ exit: r.exitCode, failed: out.match(/\(fail\) .*/)?.[0] ?? "", passed: / 1 pass/.test(out) }).toEqual({ exit: 0, failed: "", passed: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);
