// SPDX-License-Identifier: AGPL-3.0-only
// The cells lane must really run with cells (G801). bun runs every test file in one process, and
// `afterEach(() => useCells(false))` in test/cell.test.ts and eleven other files switched cells off
// for every file after them, so under `PB_CELLS=1 bun test` much of the suite ran without cells and
// a test that failed with cells (test/golden.test.ts) passed only by file order.
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "bun";
import { cellsOn } from "../src/cell";
import { LANE_CELLS } from "./cells";

const CELL = resolve("src/cell.ts"), CELLS = resolve("test/cells.ts");

// Runs one small test file in a child `bun test` (with test/setup.ts preloaded, as every run is).
function child(lane: "0" | "1", body: string) {
  const dir = mkdtempSync(join(process.env.PB_REAL_TMPDIR ?? tmpdir(), "pb-cells-lane-"));
  try {
    const file = join(dir, "probe.test.ts");
    writeFileSync(file, `import { test, expect } from "bun:test";\nimport { useCells, cellsOn } from ${JSON.stringify(CELL)};\nimport { restoreCells } from ${JSON.stringify(CELLS)};\n${body}\n`);
    const r = spawnSync(["bun", "test", file], { env: { ...process.env, PB_CELLS: lane }, stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString() + r.stderr.toString();
    return { exit: r.exitCode, out };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("every test starts with cells as the run asked for them", () => {
  expect(cellsOn()).toBe(LANE_CELLS);
  expect(LANE_CELLS).toBe(process.env.PB_CELLS === "1");
});

test("in the cells lane, a test that leaves cells off fails the run, and the next test runs with cells again", () => {
  const r = child("1", `test("leaves them off", () => { useCells(false); });\ntest("after it", () => { expect(cellsOn()).toBe(true); });\ntest("and after that", () => { expect(cellsOn()).toBe(true); });`);
  expect(r.exit).not.toBe(0);
  expect(r.out).toContain("cells were left off by the test before this one (or this file's beforeAll), but this run asked for them on (PB_CELLS=1)");
  expect(r.out).toMatch(/ 2 pass/);   // the leaker and the one after it fail once; the third runs with cells
}, 60_000);

test("a run's last test leaving cells changed fails the run too", () => {
  const r = child("1", `test("leaves them off", () => { useCells(false); });`);
  expect(r.exit).not.toBe(0);
  expect(r.out).toContain("by the run's last test");
}, 60_000);

test("without the cells lane, a test that leaves cells on fails the run", () => {
  const r = child("0", `test("leaves them on", () => { useCells(true); });\ntest("after it", () => { expect(cellsOn()).toBe(false); });`);
  expect(r.exit).not.toBe(0);
  expect(r.out).toContain("cells were left on by the test before this one (or this file's beforeAll), but this run asked for them off");
}, 60_000);

test("a test that puts back the run's setting passes in both lanes", () => {
  for (const lane of ["0", "1"] as const) {
    const r = child(lane, `test("flips and restores", () => { useCells(!cellsOn()); restoreCells(); });\ntest("after it", () => { expect(cellsOn()).toBe(${lane === "1"}); });`);
    expect({ lane, exit: r.exit, fail: r.out.match(/\(fail\) .*/)?.[0] ?? "" }).toEqual({ lane, exit: 0, fail: "" });
  }
}, 60_000);

test("no test file puts cells back to a fixed off", () => {
  const bad: string[] = [];
  for (const f of readdirSync("test", { recursive: true }) as string[]) {
    if (!f.endsWith(".ts") || f === "cells-lane.test.ts") continue;
    const text = readFileSync(join("test", f), "utf8");
    if (/(afterEach|afterAll|finally)[^\n]*useCells\(false\)/.test(text)) bad.push(f);
  }
  expect(bad).toEqual([]);
});
