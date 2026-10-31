// SPDX-License-Identifier: AGPL-3.0-only
// A test run never changes the machine's own Claude Code (G393): a piped `init --interview` once
// ran the real `claude mcp add` with a test token and wrote a test owner's standing instruction
// into the real ~/.claude/CLAUDE.md. test/setup.ts gives every run its own home and a fake
// `claude`; the code itself refuses a home or a claude outside the run's folder.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const APP = join(import.meta.dir, "..");
const inRun = (p: string) => resolve(p).startsWith(resolve(process.env.PB_TEST_RUN_DIR!) + "/");

test("during a run, HOME and the claude on PATH are the run's own", () => {
  expect(inRun(process.env.HOME!)).toBe(true);
  expect(inRun(Bun.which("claude", { PATH: process.env.PATH ?? "" }) ?? "")).toBe(true);
});

test("a piped init in a test run refuses a home and a claude outside the run, and changes neither", () => {
  const outer = mkdtempSync(join(process.env.PB_REAL_TMPDIR ?? tmpdir(), "pb-realhome-"));
  try {
    const home = join(outer, "home"), bin = join(outer, "bin"), calls = join(outer, "calls.log");
    mkdirSync(home); mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${calls}"\n`, { mode: 0o755 });
    const dir = mkdtempSync(join(tmpdir(), "pb-init-home-"));
    const r = Bun.spawnSync(["bun", "src/cli.ts", "init", join(dir, "brain"), "--interview"], {
      cwd: APP, stdin: new TextEncoder().encode("Robin\n" + "\n".repeat(14)), stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, PB_CONFIG_DIR: mkdtempSync(join(tmpdir(), "pb-cfg-")) },
    });
    expect(r.stdout.toString() + r.stderr.toString()).toContain("won't change Claude Code outside");
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(home, ".claude"))).toBe(false);
  } finally { rmSync(outer, { recursive: true, force: true }); }
}, 60_000);
