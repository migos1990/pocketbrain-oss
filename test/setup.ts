// SPDX-License-Identifier: AGPL-3.0-only
// Every test run gets one temp folder of its own, and everything temporary goes inside it:
// TMPDIR points there, so tmpdir() in tests and in any child process they start lands in it.
// The folder is removed when the run exits, so a run leaves no pb-* folders behind.
// Every run also gets its own config folder, so a brain remembered by a developer's own
// `pocketbrain init` is never picked up by a test that runs without --brain.
import { afterAll, beforeEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useFreeDisk } from "../src/textline/items";
import { isolateGit } from "../evals/lib/gitenv";
import { missingTools } from "./tools";
import { cellsOn } from "../src/cell";
import { LANE_CELLS, restoreCells } from "./cells";

if (!process.env.PB_TEST_RUN_DIR) {
  const missing = missingTools();
  if (missing.length) throw new Error(`the test suite needs tools this machine lacks:\n  ${missing.join("\n  ")}\n(PB_TEST_ALLOW_MISSING=<name,...> runs without them; their tests fail or skip, and the merge gate refuses a run with either)`);
  process.env.PB_REAL_TMPDIR = tmpdir();
  const run = mkdtempSync(join(tmpdir(), "pb-run-"));
  process.env.PB_TEST_RUN_DIR = run;
  process.env.TMPDIR = run;
  process.env.PB_CONFIG_DIR = join(run, "config");
  mkdirSync(process.env.PB_CONFIG_DIR);
  // Semantic search (src/semantic.ts) never reads a developer's model or writes their ~/.cache:
  // off unless a test injects an embedder, and its vectors stay in the run folder.
  process.env.PB_MODEL_DIR = join(run, "models");
  process.env.PB_VECTOR_DIR = join(run, "vectors");
  // Coming calendar events (src/upcoming.ts) likewise.
  process.env.PB_UPCOMING_DIR = join(run, "upcoming");
  // The machine's own Claude Code is never changed (G393): HOME is the run's, and a fake `claude`
  // that only records its arguments comes first on PATH. src/cli.ts refuses either outside the run.
  process.env.PB_REAL_HOME = process.env.HOME ?? "";
  // Playwright looks for its browsers under HOME: keep them found by a child test run (the CI runner
  // installs them in ~/.cache, so test/tmp-guard.test.ts's child stopped for a missing chromium, G534).
  const browsers = process.platform === "darwin" ? join(process.env.PB_REAL_HOME, "Library", "Caches", "ms-playwright") : join(process.env.XDG_CACHE_HOME ?? join(process.env.PB_REAL_HOME, ".cache"), "ms-playwright");
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(browsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  process.env.HOME = join(run, "home");
  mkdirSync(process.env.HOME);
  const bin = join(run, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$@" >> "${join(run, "claude-calls.log")}"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  isolateGit(run);
  const clean = () => rmSync(run, { recursive: true, force: true });
  // Removing a whole run of temp brains can take a while on a slow disk.
  afterAll(clean, 300_000);
  process.on("exit", clean);
}
// The hub's disk check reads a fixed figure in tests, so a full build disk can't fail them.
useFreeDisk(() => 1_000_000);

// The cells lane stays real (G801): every test starts with cells as the run asked for them
// (PB_CELLS=1 on, else off). A test that left them changed fails the next test, which puts the
// setting back, so one leak is one red line naming the fix instead of a quiet lane; the run's last
// test is checked when the run ends. See test/cells.ts.
const cellsLeft = (when: string) => `cells were left ${cellsOn() ? "on" : "off"} ${when}, but this run asked for them ${LANE_CELLS ? "on (PB_CELLS=1)" : "off"}: a test that changes cells must put them back with restoreCells() from test/cells.ts`;
beforeEach(() => {
  if (cellsOn() === LANE_CELLS) return;
  const msg = cellsLeft("by the test before this one (or this file's beforeAll)");
  restoreCells();
  throw new Error(msg);
});
afterAll(() => { if (cellsOn() !== LANE_CELLS) { const msg = cellsLeft("by the run's last test"); restoreCells(); throw new Error(msg); } });
