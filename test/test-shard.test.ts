// SPDX-License-Identifier: AGPL-3.0-only
// CI's cells suite runs in two jobs, each a part of the test files (scripts/test-shard.ts, G982).
// Splitting must never drop a test: the parts are disjoint, together they are every test file in
// the repo, and they are the files `bun test` itself finds.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { testFiles, shard, TEST_FILE } from "../scripts/test-shard";

const ROOT = join(import.meta.dir, "..");
const files = testFiles(ROOT);

test("the parts are disjoint and together are every test file, for any number of parts", () => {
  expect(files.length).toBeGreaterThan(500);
  for (const n of [1, 2, 3, 5]) {
    const parts = Array.from({ length: n }, (_, i) => shard(files, i + 1, n));
    expect(parts.flat().sort()).toEqual(files);
    expect(new Set(parts.flat()).size).toBe(files.length);
    for (const p of parts) expect(Math.abs(p.length - files.length / n)).toBeLessThan(1);
  }
});

test("the list is what git tracks as a test file, this file included", () => {
  const tracked = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT }).stdout.toString().split("\n").filter((f) => TEST_FILE.test(f) && !f.split("/").some((d) => d.startsWith("."))).map((f) => `./${f}`).sort();
  expect(files).toEqual(tracked);
  expect(files).toContain("./test/test-shard.test.ts");
});

test("the command prints one part, and nothing on a bad argument (so bun test then runs every file)", () => {
  const run = (...a: string[]) => Bun.spawnSync(["bun", join(ROOT, "scripts", "test-shard.ts"), ...a], { stdout: "pipe", stderr: "pipe" });
  const one = run("1", "2"), two = run("2", "2");
  expect(one.exitCode).toBe(0);
  expect([...one.stdout.toString().trim().split(" "), ...two.stdout.toString().trim().split(" ")].sort()).toEqual(files);
  for (const bad of [[], ["0", "2"], ["3", "2"], ["a", "2"], ["1", "0"]]) { const r = run(...bad); expect(r.exitCode).toBe(1); expect(r.stdout.toString()).toBe(""); }
});

test.each([["suite-cells", "PB_CELLS=1 bun test"], ["suite-plain", "bun test"]])("CI's %s job runs each part once: the matrix names every part of the number the step asks for", (name, start) => {
  const ci = YAML.parse(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8"));
  const job = ci.jobs[name];
  const step = (job.steps as { run?: string }[]).map((s) => s.run ?? "").find((r) => r.startsWith(start))!;
  const m = step.match(/\$\(bun scripts\/test-shard\.ts \$\{\{ matrix\.part \}\} (\d+)\)/);
  expect(m).not.toBeNull();
  expect(job.strategy.matrix.part).toEqual(Array.from({ length: Number(m![1]) }, (_, i) => i + 1));
  // One part failing must not cancel the other: both results are wanted.
  expect(job.strategy["fail-fast"]).toBe(false);
});
