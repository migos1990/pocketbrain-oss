// SPDX-License-Identifier: AGPL-3.0-only
// Main went red on 2026-11-14 when a slow runner took CI's `bun test` step past its limit; the same
// tree had passed in 528 s an hour before, and nothing had said the step was close. A full gate run
// now prints the step's time against its limit and blocks when the median of main's last runs is
// over 70% of it. One slow run never blocks.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ciTimeVerdict, stepOf, stepLimits, slowestPerStep, isSuiteJob, CI_TIME_SHARE } from "../scripts/gate";

test("the limits are read from ci.yml: both bun test steps, in seconds", () => {
  const limits = stepLimits(readFileSync(join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8"));
  expect(Object.keys(limits)).toEqual(["bun test", "PB_CELLS=1 bun test"]);
  expect(Object.values(limits).every((s) => s >= 600 && s % 60 === 0)).toBe(true);
  expect(stepLimits("      - run: bun test\n        timeout-minutes: 15\n        env:\n")).toEqual({ "bun test": 900 });
});

test("every run prints the latest time and the median against the limit", () => {
  const v = ciTimeVerdict([{ step: "bun test", limit: 1500, seconds: [528, 782, 519, 540, 530] }]);
  expect(v).toEqual({ lines: ["CI `bun test` on main: latest 528 s (35% of its 1500 s limit), median of the last 5 runs 530 s (35%)"] });
});

test("one slow runner doesn't block: the median decides", () => {
  expect(ciTimeVerdict([{ step: "bun test", limit: 900, seconds: [899, 528, 519, 540, 530] }]).block).toBeUndefined();
});

test("a median over 70% of the limit blocks, with the number and what to do about it", () => {
  const v = ciTimeVerdict([{ step: "bun test", limit: 900, seconds: [782, 640, 700, 519, 790] }, { step: "PB_CELLS=1 bun test", limit: 900, seconds: [500] }]);
  expect(CI_TIME_SHARE).toBe(0.7);
  expect(v.block).toContain("`bun test` takes 700 s at the median of main's last 5 runs, over 70% of its 900 s limit");
  expect(v.block).toContain("Make the suite faster");
  expect(v.block).toContain("timeout-minutes in .github/workflows/ci.yml");
  expect(v.block).toContain("--ci-slow-ok");
  expect(v.block).not.toContain("PB_CELLS");
});

test("a step with no finished run says nothing and blocks nothing", () => {
  expect(ciTimeVerdict([{ step: "bun test", limit: 900, seconds: [] }])).toEqual({ lines: [] });
});

test("a step keeps its key when its command carries flags, and other steps have none", () => {
  expect(stepLimits("      - run: PB_CELLS=1 bun test --timeout 20000   # cells\n        timeout-minutes: 40\n")).toEqual({ "PB_CELLS=1 bun test": 2400 });
  expect(stepOf("Run bun test --timeout 20000")).toBe("bun test");
  expect(stepOf("Run PB_CELLS=1 bun test --timeout 20000")).toBe("PB_CELLS=1 bun test");
  expect(stepOf("Run bun test")).toBe("bun test");
  expect(stepOf("Run bun tests/other.ts")).toBeUndefined();
  expect(stepOf("Run bunx tsc --noEmit")).toBeUndefined();
});

test("G982: a suite split across jobs counts once per run, as its slowest part, and a step with a file list is still that step", () => {
  const limits = { "bun test": 2400, "PB_CELLS=1 bun test": 2400 };
  const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, s)).toISOString();
  const steps = [
    { name: "Run bun test --timeout 20000", started_at: at(0), completed_at: at(50) },
    { name: "Run PB_CELLS=1 bun test --timeout 20000 $(bun scripts/test-shard.ts 1 2)   # every read through per-agent cells", started_at: at(0), completed_at: at(30) },
    { name: "Run PB_CELLS=1 bun test --timeout 20000 $(bun scripts/test-shard.ts 2 2)   # every read through per-agent cells", started_at: at(0), completed_at: at(41) },
    { name: "Run bunx tsc --noEmit", started_at: at(0), completed_at: at(59) },
  ];
  expect(slowestPerStep(steps, limits)).toEqual({ "bun test": 50, "PB_CELLS=1 bun test": 41 });
  expect(stepLimits("      - run: PB_CELLS=1 bun test --timeout 20000 $(bun scripts/test-shard.ts ${{ matrix.part }} 2)   # cells\n        timeout-minutes: 40\n")).toEqual({ "PB_CELLS=1 bun test": 2400 });
});

test("G982: a matrix part of the cells suite is read under the name GitHub gives it, so the rule keeps watching it", () => {
  for (const name of ["test", "suite", "suite-cells", "suite-cells (1)", "suite-cells (2)"]) expect(`${name}: ${isSuiteJob(name)}`).toBe(`${name}: true`);
  for (const name of ["e2e", "conformance", "cold-install", "suite-cells (x)", "outside-pr"]) expect(`${name}: ${isSuiteJob(name)}`).toBe(`${name}: false`);
});
