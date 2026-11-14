// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { wilsonLower, pooledLines, poolRuns } from "../evals/lib/pooled";

test("G813 the Wilson lower bound matches the textbook values", () => {
  expect(wilsonLower(0, 0)).toBe(0);
  expect(wilsonLower(11, 12)).toBeCloseTo(0.699, 3);
  expect(wilsonLower(59, 78)).toBeCloseTo(0.669, 3);
  expect(wilsonLower(12, 12)).toBeLessThan(1);
});

// The stored paid runs of the persona case (G789), replayed: every one failed and fails again; the
// best single run is not enough on its own. Runs 1 and 2 predate the filed/guessed split.
test("G813 pooled lines: every stored paid run still fails, and one good run alone does not pass", () => {
  // Run 1, tree 7c72a10, k=3: 59 of 78 pooled (old rule: 2 of 3 runs).
  expect(pooledLines([{ right: 20, lines: 26 }, { right: 22, lines: 26 }, { right: 17, lines: 26 }]).pass).toBe(false);
  // Run 2, tree 8d212d3, k=3: 56 of 85.
  expect(pooledLines([{ right: 19, lines: 28 }, { right: 19, lines: 29 }, { right: 18, lines: 28 }]).pass).toBe(false);
  // Diagnostic 9865891c, k=1: 11 of 20, filed 8 of 9.
  expect(pooledLines([{ right: 11, lines: 20, filed_right: 8, filed: 9 }]).pass).toBe(false);
  // Diagnostic 1fdc3554, k=1: 11 of 12, filed 10 of 11: 95% sure of only 69.9%.
  const one = pooledLines([{ right: 11, lines: 12, filed_right: 10, filed: 11 }]);
  expect(one.pass).toBe(false);
  expect(one.detail).toContain("lower bound 69.9% under 70%");
});

test("G813 pooled lines: a pass needs the bound, the filed floor and no decoy; none of them alone", () => {
  const good = { right: 31, lines: 36, filed_right: 29, filed: 33 };
  expect(pooledLines([good]).pass).toBe(true);
  expect(pooledLines([{ ...good, right: 29 }]).pass).toBe(false);
  expect(pooledLines([{ ...good, filed_right: 26 }]).pass).toBe(false);
  expect(pooledLines([{ ...good, forbidden: 1 }]).pass).toBe(false);
  expect(pooledLines([]).pass).toBe(false);
  expect(pooledLines([{ right: 0, lines: 0 }]).detail).toContain("no lines");
  // Three runs of a dozen lines pool to one decision.
  const r = pooledLines([{ right: 11, lines: 12, filed_right: 10, filed: 11 }, { right: 10, lines: 12, filed_right: 10, filed: 11 }, { right: 11, lines: 12, filed_right: 9, filed: 11 }]);
  expect(r.metrics!.lines).toBe(36);
  expect(r.pass).toBe(true);
});

test("G813 a run that failed without counting lines fails the pooled case, however good the rest", () => {
  const good = { pass: true as const, metrics: { right: 16, lines: 18, filed_right: 15, filed: 17, forbidden: 0 } };
  expect(poolRuns([good, good]).pass).toBe(true);
  const r = poolRuns([good, good, { pass: false, detail: "error: model timed out" }]);
  expect(r.pass).toBe(false);
  expect(r.detail).toContain("model timed out");
});
