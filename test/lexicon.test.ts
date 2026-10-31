// SPDX-License-Identifier: AGPL-3.0-only
// The French-English word map (src/lexicon.ts, gap G172): on by default, a query word also looks for
// its translation, at a lower weight than the word itself; PB_LEXICON=0 turns it off.
import { test, expect, afterEach } from "bun:test";
import { queryTerms, stem } from "../src/retrieve";

const keep = process.env.PB_LEXICON;
afterEach(() => { if (keep === undefined) delete process.env.PB_LEXICON; else process.env.PB_LEXICON = keep; });
const words = (q: string) => new Map(queryTerms(q).map((t) => [t.t, t.w]));

test("on by default: a question in other everyday words or the other language looks for them too", () => {
  delete process.env.PB_LEXICON;
  expect(words("plumber").has(stem("plombier"))).toBe(true);
  expect(words("daycare").has(stem("garderie"))).toBe(true);
  expect(words("genou").has(stem("knee"))).toBe(true);
});

test("PB_LEXICON=0: a query looks only for its own words (and the short synonym list)", () => {
  process.env.PB_LEXICON = "0";
  expect(words("plumber").has(stem("plombier"))).toBe(false);
});

test("an English word also finds the French one, and the other way round, below the word's own weight", () => {
  process.env.PB_LEXICON = "1";
  const en = words("plumber");
  expect(en.get(stem("plumber"))).toBe(1);
  expect(en.get(stem("plombier"))).toBeLessThan(1);
  expect(words("soeur").has(stem("sister"))).toBe(true);
  expect(words("hypothèque").has(stem("mortgage"))).toBe(true);
});
