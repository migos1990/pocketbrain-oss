// SPDX-License-Identifier: AGPL-3.0-only
// A burst gets the same slice as one call (test/burst-check.ts has the statements): made-up brains
// from the carve property's generator, every assistant and token, every door, the reads sent many
// at a time in a seeded order, alone and with other assistants' writes landing between them.
//   Per run: BURST_CASES brains (default 2), each through one door in turn, since the whole suite has
//   a time limit in CI. Every door on every brain: BURST_DOORS=all, a soak (BURST_SOAK=1, 60 brains)
//   or one seed (BURST_SEED=n).
// A seed that fails is added to test/fixtures/burst-seeds.json and replayed on every run.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brainOf, DOORS } from "./carve-check";
import { burst, reportBurst } from "./burst-check";

const BASE = 61_000;
const N = Number(process.env.BURST_CASES ?? (process.env.BURST_SOAK ? 60 : 2));
const FROZEN: number[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "burst-seeds.json"), "utf8"));
const SEEDS = process.env.BURST_SEED ? [Number(process.env.BURST_SEED)] : [...new Set([...FROZEN, ...Array.from({ length: N }, (_, i) => BASE + i)])];

const EVERY_DOOR = !!(process.env.BURST_SOAK || process.env.BURST_SEED || process.env.BURST_DOORS === "all");

test(`burst property: ${SEEDS.length} made-up brains, every token, ${EVERY_DOOR ? "every door" : "the doors in turn"}, reads at once and between writes, the same slice as one call`, async () => {
  const failed: string[] = [];
  const sum = { readers: 0, reads: 0, stable: 0, writes: 0, committed: 0, refused: 0, turnedAway: 0 };
  for (const [i, seed] of SEEDS.entries()) {
    const g = await brainOf(seed);
    const c = await burst(g, EVERY_DOOR ? {} : { doors: [DOORS[i % DOORS.length]!] });
    for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += c[k];
    if (c.findings.length) failed.push(reportBurst(g, c.findings));
  }
  console.log(`burst property: ${SEEDS.length} brains, ${sum.readers} tokens, ${sum.reads} reads in bursts (${sum.stable} held to the same call asked alone), ${sum.writes} writes between reads (${sum.committed} filed, ${sum.refused} refused), ${sum.turnedAway} calls turned away over budget, ${failed.length} brains with a finding`);
  expect(failed.join("\n")).toBe("");
  // The run did something: reads were compared, writes landed, refusals were seen, a budget was hit.
  expect(sum.stable).toBeGreaterThan(SEEDS.length * 60);
  expect(sum.committed).toBeGreaterThan(0);
  expect(sum.refused).toBeGreaterThanOrEqual(SEEDS.length);
  expect(sum.turnedAway).toBe(SEEDS.length * 60);
}, Math.max(600_000, SEEDS.length * 120_000));
