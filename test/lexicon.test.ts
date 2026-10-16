// SPDX-License-Identifier: AGPL-3.0-only
// The French-English word map (src/lexicon.ts, gap G172): off by default, and when PB_LEXICON=1 a
// query word also looks for its translation, at a lower weight than the word itself.
import { test, expect, afterEach } from "bun:test";
import { queryTerms, stem } from "../src/retrieve";

const keep = process.env.PB_LEXICON;
afterEach(() => { if (keep === undefined) delete process.env.PB_LEXICON; else process.env.PB_LEXICON = keep; });
const words = (q: string) => new Map(queryTerms(q).map((t) => [t.t, t.w]));

test("off by default: a query looks only for its own words (and the short synonym list)", () => {
  delete process.env.PB_LEXICON;
  expect(words("plumber").has(stem("plombier"))).toBe(false);
});

test("on: an English word also finds the French one, and the other way round, below the word's own weight", () => {
  process.env.PB_LEXICON = "1";
  const en = words("plumber");
  expect(en.get(stem("plumber"))).toBe(1);
  expect(en.get(stem("plombier"))).toBeLessThan(1);
  expect(words("soeur").has(stem("sister"))).toBe(true);
  expect(words("hypothèque").has(stem("mortgage"))).toBe(true);
});
