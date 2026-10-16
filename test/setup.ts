// SPDX-License-Identifier: AGPL-3.0-only
// Every test run gets one temp folder of its own, and everything temporary goes inside it:
// TMPDIR points there, so tmpdir() in tests and in any child process they start lands in it.
// The folder is removed when the run exits, so a run leaves no pb-* folders behind.
// Every run also gets its own config folder, so a brain remembered by a developer's own
// `pocketbrain init` is never picked up by a test that runs without --brain.
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useFreeDisk } from "../src/textline/items";
import { isolateGit } from "../evals/lib/gitenv";
import { missingTools } from "./tools";

if (!process.env.PB_TEST_RUN_DIR) {
  const missing = missingTools();
  if (missing.length) throw new Error(`the test suite needs tools this machine lacks:\n  ${missing.join("\n  ")}\n(PB_TEST_ALLOW_MISSING=<name,...> runs without them; their tests fail or skip, and the merge gate refuses a run with either)`);
  process.env.PB_REAL_TMPDIR = tmpdir();
  const run = mkdtempSync(join(tmpdir(), "pb-run-"));
  process.env.PB_TEST_RUN_DIR = run;
  process.env.TMPDIR = run;
  process.env.PB_CONFIG_DIR = join(run, "config");
  mkdirSync(process.env.PB_CONFIG_DIR);
  isolateGit(run);
  const clean = () => rmSync(run, { recursive: true, force: true });
  // Removing a whole run of temp brains can take a while on a slow disk.
  afterAll(clean, 300_000);
  process.on("exit", clean);
}
// The hub's disk check reads a fixed figure in tests, so a full build disk can't fail them.
useFreeDisk(() => 1_000_000);
