// SPDX-License-Identifier: AGPL-3.0-only
// One change ran the whole suite four times (G982): the gate, the pre-push hook, and CI twice in a
// row. The gate now records a first-time pass of its long checks for the git tree, and the hook runs
// them again unless every pushed commit has that record. Nothing is loosened: any doubt is "not proved".
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proved, mayRecord, leftClean, EVAL_ROW, thisMachine, CHECK_PROOF_HOURS, type Entry, type LongChecks } from "../scripts/gate";

const T1 = "a".repeat(40), T2 = "b".repeat(40);
const here = { bun: "1.4.2", os: "linux-x64" };
const NOW = Date.parse("2026-11-17T12:00:00Z");
const pass = (tree: string, over: Partial<Entry> = {}): Entry => ({ tree, kind: "check", result: "pass", at: "2026-11-17T10:00:00Z", ...here, ...over });

test("a recorded first-time pass for the exact tree, on this bun and machine kind, within a day, is proof", () => {
  expect(proved([T1], [pass(T1)], here, NOW)).toBeUndefined();
  expect(proved([T1, T2], [pass(T2), pass(T1)], here, NOW)).toBeUndefined();
});

test("anything unsure is not proved", () => {
  expect(CHECK_PROOF_HOURS).toBe(24);
  expect(proved([], [pass(T1)], here, NOW)).toBe("no commit named");
  expect(proved([T2], [pass(T1)], here, NOW)).toContain("no full gate pass recorded for tree bbbbbbb");
  expect(proved([T1, T2], [pass(T1)], here, NOW)).toContain("tree bbbbbbb"); // every pushed commit, not one of them
  expect(proved([T1], [pass(T1, { result: "fail" })], here, NOW)).toBeDefined();
  expect(proved([T1], [pass(T1, { kind: "slice-audit", result: "clear" })], here, NOW)).toBeDefined(); // other evidence is not a test pass
  expect(proved([T1], [pass(T1, { bun: "1.4.4" })], here, NOW)).toBeDefined();
  expect(proved([T1], [pass(T1, { os: "darwin-arm64" })], here, NOW)).toBeDefined();
  expect(proved([T1], [pass(T1, { bun: undefined })], here, NOW)).toBeDefined();
  expect(proved([T1], [pass(T1, { at: "2026-11-16T11:59:59Z" })], here, NOW)).toBeDefined(); // over a day old
  expect(proved([T1], [pass(T1, { at: "2026-11-17T12:00:01Z" })], here, NOW)).toBeDefined(); // dated ahead
  expect(proved([T1], [pass(T1, { at: undefined })], here, NOW)).toBeDefined();
  expect(proved([T1], [pass(T1, { at: "soon" })], here, NOW)).toBeDefined();
  expect(proved(["HEAD"], [pass("HEAD")], here, NOW)).toContain("not a git tree");
});

test("a run is recorded only when every long check passed first time on a clean checkout that didn't move", () => {
  const ok: LongChecks = { cleanBefore: true, cleanAfter: true, testsFirstTime: true, rest: 0, northStar: 0, treeBefore: T1, treeAfter: T1 };
  expect(mayRecord(ok)).toBe(true);
  expect(mayRecord({ ...ok, cleanBefore: false })).toBe(false); // files not committed: the tests ran on something else
  expect(mayRecord({ ...ok, cleanAfter: false })).toBe(false);
  expect(mayRecord({ ...ok, testsFirstTime: false })).toBe(false); // a failure, a skip, or a pass only on rerun
  expect(mayRecord({ ...ok, rest: 1 })).toBe(false);
  expect(mayRecord({ ...ok, northStar: 1 })).toBe(false);
  expect(mayRecord({ ...ok, rest: -1 })).toBe(false); // never ran
  expect(mayRecord({ ...ok, treeAfter: T2 })).toBe(false); // a commit landed mid-run
  expect(mayRecord({ ...ok, treeBefore: "", treeAfter: "" })).toBe(false);
});

const GATE = join(import.meta.dir, "..", "scripts", "gate.ts");
const ROOT = join(import.meta.dir, "..");
const run = (args: string[], ledger: string) => Bun.spawnSync(["bun", GATE, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_GATES: ledger } });

test("`gate.ts proved` exits 0 only with the record, and 1 for a commit it can't resolve or no commit at all", () => {
  const ledger = join(mkdtempSync(join(tmpdir(), "pb-proof-")), "gates.jsonl");
  const tree = Bun.spawnSync(["git", "rev-parse", "HEAD^{tree}"], { cwd: ROOT, stdout: "pipe" }).stdout.toString().trim();
  writeFileSync(ledger, "");
  expect(run(["proved", "HEAD"], ledger).exitCode).toBe(1);
  expect(run(["proved"], ledger).exitCode).toBe(1);
  writeFileSync(ledger, JSON.stringify({ tree, kind: "check", result: "pass", at: new Date(Date.now() - 60_000).toISOString(), ...thisMachine() }) + "\n");
  const yes = run(["proved", "HEAD"], ledger);
  expect(yes.stdout.toString()).toContain("proved: the gate's long checks passed first time on this exact tree");
  expect(yes.exitCode).toBe(0);
  expect(run(["proved", "HEAD", "0123456789012345678901234567890123456789"], ledger).exitCode).toBe(1);
  expect(run(["proved", "HEAD", "--anything"], ledger).exitCode).toBe(1);
});

test("nobody records a test pass by hand: `record` refuses the kind", () => {
  const ledger = join(mkdtempSync(join(tmpdir(), "pb-proof-")), "gates.jsonl");
  expect(run(["record", "check", "pass"], ledger).exitCode).toBe(2);
});

// The hook itself: the long checks are skipped only on `proved`, and the gate's rules on a push to
// main run either way.
const hook = readFileSync(join(ROOT, ".githooks", "pre-push"), "utf8");
const body = hook.slice(hook.indexOf("long_checks() {"));
const push = (stdin: string, isProved: boolean) => Bun.spawnSync(["sh", "-c", "set -e\nrefs=$(cat)\n" + body.replace(/^\s*bunx? .*$/gm, (l) =>
  l.includes("gate.ts proved") ? `echo "asked $shas"; ${isProved} && proved=yes || true` : l.includes("gate.ts") ? 'echo "rules $rsha"' : "echo long")], { stdin: new TextEncoder().encode(stdin) }).stdout.toString().trim().split("\n");

test("pre-push asks about every commit it pushes, skips the long checks only when proved, and still runs the rules on main", () => {
  const z = "0".repeat(40), a = "a".repeat(40), b = "b".repeat(40), c = "c".repeat(40);
  expect(hook).toContain("long_checks() {");
  expect(push(`refs/heads/x ${b} refs/heads/x ${a}\n`, false)).toEqual([`asked ${b} `, "long", "long", "long", "long", "long"]);
  const skipped = push(`refs/heads/x ${b} refs/heads/x ${a}\n`, true);
  expect(skipped[0]).toBe(`asked ${b} `);
  expect(skipped).not.toContain("long");
  expect(skipped.at(-1)).toContain("not run again");
  expect(push(`refs/heads/x ${b} refs/heads/x ${a}\nrefs/heads/y ${c} refs/heads/y ${z}\n`, false)[0]).toBe(`asked ${b} ${c} `);
  expect(push(`refs/heads/main ${b} refs/heads/main ${a}\n`, true).at(-1)).toBe(`rules ${a}`);
  // A push that only deletes a ref names no commit: nothing is asked, everything runs.
  expect(push(`(delete) ${z} refs/heads/x ${a}\n`, true)).toEqual(["long", "long", "long", "long", "long"]);
});

test("after the checks, only the eval run's own history row may differ from what was committed (G982)", () => {
  // Seen on the first full gate run of this branch: the eval step appends its row, the checkout
  // was no longer clean, and a run that passed first time was never recorded.
  expect(leftClean("")).toBe(true);
  expect(leftClean(` M ${EVAL_ROW}\n`)).toBe(true);
  expect(leftClean(` M ${EVAL_ROW}\n M src/write.ts\n`)).toBe(false);
  expect(leftClean(" M src/write.ts\n")).toBe(false);
  expect(leftClean("?? test/new.test.ts\n")).toBe(false);
  expect(leftClean(`M  ${EVAL_ROW}\n`)).toBe(false); // staged: someone means to commit it
  expect(leftClean(`?? ${EVAL_ROW}\n`)).toBe(false);
  expect(leftClean(` D ${EVAL_ROW}\n`)).toBe(false);
  expect(leftClean(` M ${EVAL_ROW}.bak\n`)).toBe(false);
});

test("the gate reads the checkout the same way before and after its checks (code review of PR 228)", () => {
  // An earlier run's eval row made the next run start "dirty", so no pass was ever recorded twice in a row.
  const src = readFileSync(join(import.meta.dir, "..", "scripts", "gate.ts"), "utf8");
  expect(src).not.toMatch(/"--porcelain"\) === ""/);
  expect(src.match(/cleanBefore: run && clean\(\)/)).not.toBeNull();
  expect(src.match(/long\.cleanAfter = clean\(\)/)).not.toBeNull();
});
