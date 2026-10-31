// SPDX-License-Identifier: AGPL-3.0-only
// git 2.43 prints a UTC time from %aI/%cI as "+00:00", newer git as "Z" (the CI runner's 2.56,
// 2026-10-30). The hub's own times are toISOString()'s; a git time compared or sorted with them is
// made the same shape first, or the order of the owner's diary and history depends on git's version.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitTime } from "../src/git";

test("a git time reads the same whichever way git wrote UTC", () => {
  expect(gitTime("2026-10-08T13:40:00+00:00")).toBe("2026-10-08T13:40:00.000Z");
  expect(gitTime("2026-10-08T13:40:00Z\n")).toBe("2026-10-08T13:40:00.000Z");
  expect(gitTime("2026-10-08T09:40:00-04:00")).toBe("2026-10-08T13:40:00.000Z");
  expect(gitTime("")).toBe("");
});

test("every %aI or %cI the hub reads goes through gitTime or Date.parse", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } };
  walk(join(import.meta.dir, "..", "src"));
  const raw = files.filter((f) => /%[ac]I/.test(readFileSync(f, "utf8")) && !/gitTime\(|Date\.parse\(/.test(readFileSync(f, "utf8")));
  expect(raw).toEqual([]);
});
