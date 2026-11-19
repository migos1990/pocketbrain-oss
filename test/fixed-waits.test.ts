// SPDX-License-Identifier: AGPL-3.0-only
// No new fixed wait in a test (G983). The list is test/fixed-waits.ts; this counts what each test
// file really holds and compares. A wait that hopes the machine was fast enough ("settle") is the
// kind that fails on a slow runner: no new one, and the ones left may only become fewer.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { WAITS, countWaits } from "./fixed-waits";

const ROOT = join(import.meta.dir, "..");
const SELF = ["test/fixed-waits.ts", "test/fixed-waits.test.ts"]; // these two name the patterns to describe them
const files = [...new Glob("test/**/*.ts").scanSync(ROOT)].filter((f) => !SELF.includes(f)).sort();
const listed = (f: string) => (WAITS[f] ?? []).reduce((n, w) => n + w.n, 0);

test("every wait in a test file is listed with its reason, and the list names none that are gone", () => {
  const off: string[] = [];
  for (const f of new Set([...files, ...Object.keys(WAITS)])) {
    const has = files.includes(f) ? countWaits(readFileSync(join(ROOT, f), "utf8")) : 0;
    if (has > listed(f)) off.push(`${f}: ${has} waits, ${listed(f)} listed. Wait on a signal instead of a time (a file, a line of output, a promise); a wait that must stay gets a line in test/fixed-waits.ts with its reason`);
    if (has < listed(f)) off.push(`${f}: ${has} waits, ${listed(f)} listed. Take the line out of test/fixed-waits.ts`);
  }
  expect(off).toEqual([]);
});

// The ceiling moves down with each one fixed, never up.
const SETTLE_CEILING = 9;
test("fixed pauses that hope something finished: no more than there were, each with a reason and no empty entry", () => {
  const all = Object.values(WAITS).flat();
  expect(all.filter((w) => w.kind === "settle").reduce((n, w) => n + w.n, 0)).toBeLessThanOrEqual(SETTLE_CEILING);
  for (const w of all) { expect(w.n).toBeGreaterThan(0); expect(w.why.length).toBeGreaterThan(15); }
});

test("the counter sees a sleep, a timer, a busy loop on the clock, and calls of a one-line helper around one", () => {
  expect(countWaits("await Bun.sleep(5);\n")).toBe(1);
  expect(countWaits("await new Promise((r) => setTimeout(r, 20));\n")).toBe(1);
  expect(countWaits("while (Date.now() < at) {}\n")).toBe(1);
  expect(countWaits("const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));\nawait pause(300);\nawait pause(100);\n")).toBe(2);
  expect(countWaits("const tick = () => Bun.sleep(1100);\nawait tick();\n")).toBe(1);
  // The product's own nightly pass is called sleep; calling it is no wait, nor is a method of that name.
  expect(countWaits("const r = await sleep(root, { now });\nawait g.pause();\n")).toBe(0);
});

test("the one-code, twelve-terminals check starts on a signal, not after a fixed 2.5 seconds", () => {
  const t = readFileSync(join(ROOT, "test", "cli-token-audit4.test.ts"), "utf8");
  expect(t).not.toMatch(/Date\.now\(\) \+ 2_?500/);
  expect(t).not.toContain("while (Date.now() < at)");
  expect(WAITS["test/cli-token-audit4.test.ts"].map((w) => w.kind)).toEqual(["poll"]);
});
