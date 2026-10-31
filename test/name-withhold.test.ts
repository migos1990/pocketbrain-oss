// SPDX-License-Identifier: AGPL-3.0-only
// Withholding carved values in note titles and aliases (carve.ts withholdName) is indexed, so a
// brain with thousands of carved values doesn't try every value on every name (docs/perf.md).
// The answers must be exactly those of the plain loop it replaced, kept here as the reference.
import { test, expect } from "bun:test";
import { withholdName } from "../src/carve";
import { needleFor, squash, findCarried, type Needle } from "../src/match";
import { escapeRe } from "../src/util";

function referenceExact(text: string, values: string[]): string {
  let out = text;
  const low = text.toLowerCase();
  for (const v of values) if (low.includes(v.toLowerCase())) out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(v)}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1[withheld]");
  return out;
}
function referenceQuickPass(name: string, needles: Needle[]): boolean {
  if (/[A-Za-z0-9+/_-]{12,}|%[0-9a-f]{2}/i.test(name)) return false;
  const q = squash(name), digits = name.replace(/[^\d]/g, "");
  return !needles.some((n) => (n.squashed.length >= 6 && q.includes(n.squashed)) || (n.digits && digits.includes(n.digits)));
}

test("indexed name withholding answers exactly like the plain loop over every value", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const words = ["Maple", "Trust", "Bank", "Joe", "Jane", "Roy", "course", "B-201", "412 500", "CAD", "Old", "Harbour", "Savings", "école", "Zoë", "4417", "door", "the", "at", "of", "Ünïcode", "x"];
  const values = Array.from({ length: 300 }, () => Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(words)).join(pick([" ", "-", " ", ", "]))).concat(["CAD 412500.00", "Maple Trust Bank", "Door 4417", "[withheld] Bank", "Roy"]);
  const common = new Set(["joe", "the", "at"]);
  const needles = values.filter((v) => !/^\p{L}+$/u.test(v.trim())).map((v) => needleFor(v, v, common)).filter((x): x is Needle => !!x).map((n) => ({ ...n, parts: [] }));
  let differ = 0, withheld = 0;
  for (let i = 0; i < 3000; i++) {
    const name = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => pick(words)).join(pick([" ", " ", "-", " at ", "/"]));
    const exact = referenceExact(name, values);
    // The quick pass decides most names; when it doesn't, the slow path is the same code.
    const ref = referenceQuickPass(exact, needles) ? exact : undefined;
    const got = withholdName(name, values, needles);
    if (got !== name) withheld++;
    if (ref !== undefined && got !== ref) differ++;
    if (ref === undefined && !findCarried(exact, needles) && got !== exact) differ++;
  }
  expect(differ).toBe(0);
  expect(withheld).toBeGreaterThan(100); // the case mix exercises both paths
});

test("name withholding on a brain-sized value list stays fast", () => {
  const values = Array.from({ length: 8000 }, (_, i) => `Vivine workshop ${i}`);
  const needles = values.map((v) => needleFor(v, v, new Set())).filter((x): x is Needle => !!x).map((n) => ({ ...n, parts: [] }));
  const t = performance.now();
  for (let i = 0; i < 2000; i++) withholdName(`Person ${i} at Course ${i % 50}`, values, needles);
  expect(performance.now() - t).toBeLessThan(200);
});
