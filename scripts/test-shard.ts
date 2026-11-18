// SPDX-License-Identifier: AGPL-3.0-only
// One part of the test suite, for a CI job that runs a share of it (G982): the test files in order
// by path, dealt out in turn, so the parts are disjoint and together are every test file.
//   bun scripts/test-shard.ts <part> <parts>     prints part <part> (1-based) of <parts>, one line
//   PB_CELLS=1 bun test --timeout 20000 $(bun scripts/test-shard.ts 1 2)
// A bad argument prints nothing and exits 1, so the `bun test` it feeds runs every file: slower,
// never fewer tests. test/test-shard.test.ts holds the parts to the files `bun test` finds.
import { readdirSync } from "node:fs";
import { join } from "node:path";

// What `bun test` takes for a test file (its docs: *.test, *_test, *.spec, *_spec; js, jsx, ts, tsx).
export const TEST_FILE = /(\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]sx?)$/;

export function testFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else if (TEST_FILE.test(e.name)) out.push(`./${rel}${e.name}`);
    }
  };
  walk(root, "");
  return out.sort();
}

export const shard = (files: string[], part: number, parts: number) => files.filter((_, i) => i % parts === part - 1);

if (import.meta.main) {
  const [part, parts] = process.argv.slice(2).map(Number);
  if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || part < 1 || part > parts) process.exit(1);
  console.log(shard(testFiles(join(import.meta.dir, "..")), part, parts).join(" "));
}
