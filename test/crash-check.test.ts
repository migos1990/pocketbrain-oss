// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// G1017: `bun run crash` ran in no workflow, and had come to fail before its first kill: the
// synthetic brain's write log carries stand-in hashes, which the check's own chain check called a
// broken log. A check that cries wolf on an untouched brain can't tell a real loss from its own noise.
test("G1017 the crash check finds nothing wrong with its own brain before anything is killed", async () => {
  const { checkBrain, crashBrain } = await import("../scripts/crash");
  const root = mkdtempSync(join(tmpdir(), "pb-crash-check-"));
  const s = crashBrain(root, 40);
  const before = process.env.PB_TODAY;
  process.env.PB_TODAY = s.today;
  try { expect(await checkBrain(root)).toEqual([]); }
  finally { if (before === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = before; }
});

test("G1017 CI runs the crash check, with a time limit", async () => {
  const ci = await Bun.file(join(import.meta.dir, "..", ".github", "workflows", "ci.yml")).text();
  const step = /- name: crash check\n\s+timeout-minutes: \d+\n\s+run: bun scripts\/crash\.ts --rounds \d+ --notes \d+/;
  expect(step.test(ci)).toBe(true);
});
