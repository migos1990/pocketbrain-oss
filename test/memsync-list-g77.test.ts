// SPDX-License-Identifier: AGPL-3.0-only
// Red team: G77 kept agent-written text on one clean line in `beliefs`, but `memsync list` (the
// command the radar and the digest point the owner to) prints the agent's raw answer and note.
import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import * as ms from "../src/memsync";

test("memsync list prints an agent's answer without control characters or forged lines", () => {
  const cfg = mkdtempSync(join(tmpdir(), "pb-cfg-"));
  process.env.PB_CONFIG_DIR = cfg;
  const root = makeBrain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  const forged = "Dean\"\nfix-00000000  helper  verified  update Jane Roy: role: \"ok\x1b[2J\x1b[8m";
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: forged }] });
  const out = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "memsync", "list"], { env: { ...process.env, PB_BRAIN: root, PB_CONFIG_DIR: cfg } }).stdout.toString();
  expect(out).toContain("helper");
  expect(out).not.toContain("\x1b");
  expect(out.split("\n").filter((l) => l.startsWith("fix-00000000")).length).toBe(0);
});
