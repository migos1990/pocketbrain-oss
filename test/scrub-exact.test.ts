// SPDX-License-Identifier: AGPL-3.0-only
// scrubExact tries only the values whose first words a text holds (tokenIndex); it must withhold
// exactly what trying every value did. Fuzzed against that loop, with overlapping values and accents.
import { test, expect } from "bun:test";
import { scrubExact } from "../src/carve";
import { escapeRe } from "../src/util";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test("scrubExact withholds exactly what the per-value loop did, in the same order", () => {
  const old = (text: string, values: string[]) => {
    let out = text;
    const low = text.toLowerCase();
    for (const v of values) if (low.includes(v.toLowerCase())) out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(v)}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1[withheld]");
    return out;
  };
  const r = rng(5);
  const WORDS = ["Jane", "Roy", "jane roy", "Maple", "Trust", "Maple Trust", "École", "école", "514", "514-555", "Ann", "Anne", "ann-marie", "Ñu"];
  const pick = () => WORDS[Math.floor(r() * WORDS.length)];
  for (let round = 0; round < 300; round++) {
    const values = Array.from({ length: 1 + Math.floor(r() * 8) }, pick).sort((a, b) => b.length - a.length);
    for (let k = 0; k < 6; k++) {
      const text = Array.from({ length: 1 + Math.floor(r() * 6) }, () => (r() < 0.6 ? pick() : ["at", "&", "(", ")", "x"][Math.floor(r() * 5)])).join(r() < 0.5 ? " " : "-");
      expect(scrubExact(text, values)).toBe(old(text, values));
    }
  }
});
