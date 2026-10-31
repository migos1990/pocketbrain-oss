// SPDX-License-Identifier: AGPL-3.0-only
// Flaky-test ledger (backlog #323): the gate reruns the test files that failed, once; a test that
// fails then passes is logged to flaky.jsonl by tree, and the same test flaking again on another
// tree blocks, so a real failure isn't excused as flaky twice. `gate.ts flaky` lists repeat offenders.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFailures, failureOutput, judgeFlakes, flakyReport, unaccounted, CHECK_REST, type FlakyEntry } from "../scripts/gate";

const OUT = `
test/server.test.ts:
(pass) no token gets nothing [3.00ms]
(fail) dropping an agent cuts its token off [12.00ms]

test/cell.test.ts:
(fail) a change-feed read that fails isn't remembered as 'nothing changed' > when cut short [43.55ms]
(fail) timed out with no log [5001.00ms]

 2 pass
 3 fail
`;

test("failing tests are read from bun's output with their file", () => {
  expect(parseFailures(OUT)).toEqual([
    { file: "test/server.test.ts", name: "dropping an agent cuts its token off" },
    { file: "test/cell.test.ts", name: "a change-feed read that fails isn't remembered as 'nothing changed' > when cut short" },
    { file: "test/cell.test.ts", name: "timed out with no log" },
  ]);
  expect(parseFailures(" 10 pass\n 0 fail\n")).toEqual([]);
});

// On GitHub Actions bun groups each file and adds ::error annotations (the CI test job, 2026-10-30).
test("failures are read from bun's GitHub Actions output too", () => {
  const gh = "::group::test/a.test.ts:\n(pass) one [1.00ms]\nerror: expect(received).toBe(expected)\n::error file=test/a.test.ts,line=3,col=1,title=error::Expected: true\n(fail) two [3.00ms]\n::endgroup::\n\n 1 pass\n 1 fail\n";
  expect(parseFailures(gh)).toEqual([{ file: "test/a.test.ts", name: "two" }]);
  expect(failureOutput(gh, { file: "test/a.test.ts", name: "two" })).toContain("::error file=test/a.test.ts");
});

const T1 = "1".repeat(40), T2 = "2".repeat(40);
const a = { file: "test/server.test.ts", name: "dropping an agent cuts its token off" };
const b = { file: "test/cell.test.ts", name: "timed out with no log" };

test("a failure's own output is what bun printed between the test before it and its (fail) line", () => {
  const out = "test/a.test.ts:\n(pass) one [1.00ms]\nerror: expect(received).toEqual(expected)\n- Expected  - 1\n+ Received  + 1\n(fail) two [3.00ms]\n(pass) three\n\ntest/b.test.ts:\n(fail) two [9.00ms]\n";
  expect(failureOutput(out, { file: "test/a.test.ts", name: "two" })).toBe("error: expect(received).toEqual(expected)\n- Expected  - 1\n+ Received  + 1\n(fail) two [3.00ms]");
  expect(failureOutput(out, { file: "test/b.test.ts", name: "two" })).toBe("(fail) two [9.00ms]");
  expect(failureOutput("x".repeat(9000) + "\ntest/c.test.ts:\n" + "y\n".repeat(5000) + "(fail) big\n", { file: "test/c.test.ts", name: "big" }).length).toBeLessThanOrEqual(4000);
});

test("a test that passes on rerun is flaky the first time; flaking again on another tree blocks; one still failing is real", () => {
  expect(judgeFlakes([a, b], [b], [], T1)).toEqual({ real: [b], flaky: [a], repeat: [] });
  const before: FlakyEntry[] = [{ at: "2026-10-15T10:00:00Z", file: a.file, test: a.name, tree: T2 }];
  expect(judgeFlakes([a], [], before, T1)).toEqual({ real: [], flaky: [], repeat: [{ ...a, before: before[0] }] });
  // The same tree gated again (a rerun of the same branch) is the same flake, not a second one.
  expect(judgeFlakes([a], [], [{ ...before[0], tree: T1 }], T1)).toEqual({ real: [], flaky: [a], repeat: [] });
});

test("the report lists tests that flaked twice or more in the window, most first", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const e = (t: string, at: string, tree: string): FlakyEntry => ({ at, file: "test/x.test.ts", test: t, tree });
  const ledger = [e("a", "2026-10-15T00:00:00Z", T1), e("a", "2026-10-16T00:00:00Z", T2), e("a", "2026-10-16T01:00:00Z", "3".repeat(40)),
    e("b", "2026-10-14T00:00:00Z", T1), e("b", "2026-10-15T00:00:00Z", T2), e("c", "2026-10-16T00:00:00Z", T1), e("d", "2026-09-01T00:00:00Z", T1), e("d", "2026-09-02T00:00:00Z", T2)];
  expect(flakyReport(ledger, 7, now)).toEqual([
    { file: "test/x.test.ts", test: "a", flakes: 3, trees: 3, last: "2026-10-16T01:00:00Z" },
    { file: "test/x.test.ts", test: "b", flakes: 2, trees: 2, last: "2026-10-15T00:00:00Z" },
  ]);
});

test("the gate's test run: a flake passes once and is logged; the same flake on another tree blocks; a real failure blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-gate-flaky-"));
  try {
    mkdirSync(join(dir, "test"));
    // Fails while the marker is missing, and leaves it behind, so the rerun passes.
    writeFileSync(join(dir, "test", "f.test.ts"), `import { test, expect } from "bun:test";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("flips", () => { const m = ${JSON.stringify(join(dir, "marker"))}; const ok = existsSync(m); writeFileSync(m, ""); expect(ok).toBe(true); });\n`);
    const ledger = join(dir, "flaky.jsonl");
    const run = (tree: string, changed: string[] = []) => {
      rmSync(join(dir, "marker"), { force: true });
      const r = Bun.spawnSync(["bun", "-e", `const g = await import(${JSON.stringify(join(import.meta.dir, "..", "scripts", "gate.ts"))}); console.log(JSON.stringify(g.testsWithRerun(${JSON.stringify(tree)}, "s", ${JSON.stringify(changed)})));`],
        { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_FLAKY: ledger } });
      return JSON.parse(r.stdout.toString().trim().split("\n").pop()!) as string[];
    };
    expect(run(T1)).toEqual([]);
    expect(readFileSync(ledger, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toMatchObject([{ file: "test/f.test.ts", test: "flips", tree: T1, output: expect.stringContaining("(fail) flips") }]);
    const again = run(T2);
    expect(again).toHaveLength(1);
    expect(again[0]).toStartWith("flaky twice: test/f.test.ts > flips");
    // A flake in a test this branch adds or changes blocks the first time.
    rmSync(ledger);
    expect(run("4".repeat(40), ["test/f.test.ts"])[0]).toStartWith("flaky in a changed test: test/f.test.ts > flips");
    // Another file that doesn't load prints no (fail) line, only " 1 error": never waved through on a rerun.
    writeFileSync(join(dir, "test", "g.test.ts"), `import { test } from "bun:test";\nimport "./no-such-module";\ntest("never runs", () => {});\n`);
    expect(run("5".repeat(40))[0]).toMatch(/^checks: `bun test` reported 1 error/);
    rmSync(join(dir, "test", "g.test.ts"));
    writeFileSync(join(dir, "test", "f.test.ts"), `import { test, expect } from "bun:test";\ntest("always", () => { expect(1).toBe(2); });\n`);
    expect(run(T1)[0]).toStartWith("checks: `bun test` failed, and failed again on rerun");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("bun's own counts must match the failures read", () => {
  expect(unaccounted(" 3 pass\n 1 fail\n", 1)).toBeUndefined();
  expect(unaccounted(" 3 pass\n 1 fail\n 1 error\n", 1)).toMatch(/1 error outside any test/);
  expect(unaccounted(" 3 pass\n 2 fail\n", 1)).toMatch(/2 failures but only 1 could be named/);
});

test("the gate's check steps are package.json's check script, split after bun test", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
  expect(pkg.scripts.check).toBe(`bun test && ${CHECK_REST}`);
});
