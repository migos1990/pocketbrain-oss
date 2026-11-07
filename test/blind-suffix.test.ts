// SPDX-License-Identifier: AGPL-3.0-only
// PR 116's CI, 2026-11-07: a page an agent outside the wall makes gets a six-hex suffix, and the fold
// knows such a page by a digit in it (src/fold.ts blindId), so an all-letter suffix like "cbcdff"
// (about 1 in 360) read as a word and the fold kept the wrong page. The suffix always holds a digit
// now (G710).
import { test, expect } from "bun:test";
import { blindSuffix } from "../src/write";
import { blindId } from "../src/fold";

test("G710 a blind writer's suffix always holds a digit, so the fold always knows it", () => {
  for (const hex of ["cbcdff", "aaaaaa", "fedcba"]) {
    const s = blindSuffix(hex);
    expect(s).toMatch(/^[0-9a-f]{6}$/);
    expect(s).toMatch(/\d/);
    expect(blindId(`projects/garden-${s}`)).toBe(true);
  }
  expect(blindSuffix("a1b2c3")).toBe("a1b2c3");
  // A word is still a word.
  expect(blindId("projects/decade")).toBe(false);
});
