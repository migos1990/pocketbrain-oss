// SPDX-License-Identifier: AGPL-3.0-only
// The pre-push hook runs the suite from inside git, which exports GIT_DIR (and friends) to hooks.
// Test fixtures that run git would then write into the pushing repo itself, so the hook drops them first.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const hook = readFileSync(join(import.meta.dir, "..", ".githooks", "pre-push"), "utf8");

test("pre-push clears git's hook environment before running anything", () => {
  const lines = hook.split("\n");
  const first = lines.findIndex((l) => /^\s*(bun|bunx|git)\b/.test(l));
  const unset = lines.findIndex((l) => /^\s*unset\b/.test(l));
  expect(unset).toBeGreaterThan(-1);
  expect(unset).toBeLessThan(first);
  const prefix = lines.slice(0, unset + 1).join("\n") + '\necho "${GIT_DIR-none}|${GIT_WORK_TREE-none}|${GIT_INDEX_FILE-none}"\n';
  const out = Bun.spawnSync(["sh", "-c", prefix], { env: { ...process.env, GIT_DIR: "/x/.git", GIT_WORK_TREE: "/x", GIT_INDEX_FILE: "/x/.git/index" } });
  expect(out.stdout.toString().trim()).toBe("none|none|none");
});
