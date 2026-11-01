// SPDX-License-Identifier: AGPL-3.0-only
// The rule behind G544 and G551 (audit v7; CLAUDE.md "Lines on the 30-day sign-in"), enforced: any
// line the owner's screens render re-derives its sensitivity from the note at render time, never
// from a stored row. In a screen file that reads the diary, a row's `.sensitivity` is read only
// through privateNow (src/dashboard/home.ts), which takes it as a floor and checks the note now.
// A line that has a reason to read it otherwise says so with `stored-sensitivity-ok: <why>`.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SCREENS = [...readdirSync(join(ROOT, "src/dashboard")).filter((f) => f.endsWith(".ts")).map((f) => `src/dashboard/${f}`), "src/owner-say.ts", "src/owner.ts"];
// A diary row is `row` or `rows[...]`/`rows.at(...)` here (a fact record is `r`, a note's level `fm`).
const STORED = /\b(?:row|rows\.at\([^)]*\)|rows\[[^\]]*\])\??\.sensitivity\b/;

function offending(files = SCREENS): string[] {
  const out: string[] = [];
  for (const f of files) {
    let src: string;
    try { src = readFileSync(join(ROOT, f), "utf8"); } catch { continue; }
    if (!/\b(readDiary|DiaryRow)\b/.test(src)) continue;
    src.split("\n").forEach((line, i) => {
      if (STORED.test(line) && !/privateNow\(/.test(line) && !/stored-sensitivity-ok:\s*\S/.test(line)) out.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

test("screen code reads a stored row's sensitivity only through privateNow (G551)", () => {
  expect(offending()).toEqual([]);
});

test("the check catches a line that trusts the row", () => {
  expect(STORED.test("const shapeless = sensitivityRank(row.sensitivity) >= P;")).toBe(true);
  expect(STORED.test("audienceOf(rows.at(-1)?.sensitivity)")).toBe(true);
  expect(STORED.test("sensitivityRank(n.fm.sensitivity)")).toBe(false);
});
