// SPDX-License-Identifier: AGPL-3.0-only
// Every access-core file is a registered fragile surface with a contract suite (registry.ts).
import { test, expect } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ACCESS_CORE, FRAGILE, contractFile } from "./registry";

const ROOT = join(import.meta.dir, "..", "..");

test("every access-core source file is a registered fragile surface", () => {
  const core = readdirSync(join(ROOT, "src")).filter((f) => ACCESS_CORE.test(f)).map((f) => `src/${f}`).sort();
  expect(core).toEqual(Object.values(FRAGILE).map((s) => s.src).sort());
});

test("every fragile surface has its contract suite", () => {
  for (const name of Object.keys(FRAGILE)) expect([name, existsSync(join(ROOT, contractFile(name)))]).toEqual([name, true]);
});
