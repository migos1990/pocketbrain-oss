// SPDX-License-Identifier: AGPL-3.0-only
// A refusal from the brain is an answer, not a crash (stranger rehearsal 3): `ask decline` on an
// unknown ask printed a Bun stack trace with a source excerpt.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { makeBrain } from "./fixture";

test("a CoreError from a command prints its message and exits 1, with no stack trace", () => {
  const root = makeBrain();
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "ask", "decline", "ask-nope"], { env: { ...process.env, PB_BRAIN: root }, stdout: "pipe", stderr: "pipe" });
  const err = r.stderr.toString();
  expect(err).toContain("no ask ask-nope");
  expect(err).not.toMatch(/\n\s+at /);
  expect(r.exitCode).toBe(1);
});
