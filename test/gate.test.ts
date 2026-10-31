// SPDX-License-Identifier: AGPL-3.0-only
// Contract of the merge gate's rules (scripts/gate.ts): what each kind of diff requires.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rules, checkFailures, splitEvidence, type Change, type Entry } from "../scripts/gate";

const M = (...p: string[]): Change[] => p.map((x) => ({ status: x.startsWith("+") ? "A" : "M", path: x.replace(/^\+/, "") }));
const T = "a".repeat(40);
const has = (out: string[], s: string) => out.some((x) => x.startsWith(s));

test("code without a test is blocked, unless a No-Test trailer says why", () => {
  expect(has(rules(M("src/digest.ts"), "", T, []), "test first")).toBe(true);
  expect(rules(M("src/digest.ts", "test/digest.test.ts"), "", T, [])).toEqual([]);
  expect(rules(M("src/digest.ts"), "fix wording\n\nNo-Test: comment only", T, [])).toEqual([]);
  expect(rules(M("docs/hub.md"), "", T, [])).toEqual([]);
});

test("a new src file or a CLI change needs a doc in the same branch", () => {
  expect(has(rules(M("+src/new.ts", "test/new.test.ts"), "", T, []), "docs")).toBe(true);
  expect(has(rules(M("src/cli.ts", "test/cli.test.ts"), "", T, []), "docs")).toBe(true);
  expect(rules(M("+src/new.ts", "test/new.test.ts", "CLAUDE.md"), "", T, [])).toEqual([]);
});

test("the access core needs a clear slice audit recorded for this exact tree", () => {
  const d = M("src/carve.ts", "test/carve.test.ts");
  expect(has(rules(d, "", T, []), "slice audit")).toBe(true);
  const audit = (tree: string, result: string): Entry => ({ tree, kind: "slice-audit", result });
  expect(has(rules(d, "", T, [audit("b".repeat(40), "clear")]), "slice audit")).toBe(true);
  expect(has(rules(d, "", T, [audit(T, "regression")]), "slice audit")).toBe(true);
  expect(rules(d, "", T, [audit(T, "clear")])).toEqual([]);
});

test("a prompt change needs a passing agent eval run for this tree", () => {
  for (const p of ["src/orientation.ts", "src/judge.ts", "evals/cases/agents.ts"]) {
    const d = M(p, "test/orientation.test.ts");
    expect(has(rules(d, "", T, []), "agent evals")).toBe(true);
    expect(rules(d, "", T, [{ tree: T, kind: "agent-evals", result: "pass" }])).toEqual([]);
  }
});

test("a check run passes only with no failure and no skip (backlog #278)", () => {
  expect(checkFailures(0, " 1367 pass\n 0 fail\n")).toEqual([]);
  expect(checkFailures(0, " 1353 pass\n 14 skip\n 0 fail\n")).toEqual(["checks: 14 tests skipped; every test must run (install what test/tools.ts names)"]);
  expect(has(checkFailures(1, "(fail) backups encrypt\n 1 fail\n"), "checks: `bun run check` failed")).toBe(true);
});

// git quotes a non-ASCII path in plain --name-status output ("rules/instructions/na\303\257ve.md"),
// so the quoted path matched no rule and the gate said MERGE for an unevaluated prompt (backlog #308).
test("a non-ASCII prompt path still needs its agent eval run", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-gate-quote-"));
  const sh = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const commit = (m: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --no-verify -m '${m}'`);
  expect(sh("git init -q -b main").exitCode).toBe(0);
  writeFileSync(join(dir, "README.md"), "x\n");
  expect(commit("base").exitCode).toBe(0);
  expect(sh("git checkout -q -b topic").exitCode).toBe(0);
  mkdirSync(join(dir, "rules/instructions"), { recursive: true });
  writeFileSync(join(dir, "rules/instructions/naïve.md"), "be brief\n");
  expect(commit("reword an instruction").exitCode).toBe(0);
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/gate.ts"), "main", "--no-run"],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_GATES: join(dir, "gates.jsonl") } });
  const out = r.stdout.toString();
  expect(out).toContain("agent evals");
  expect([r.exitCode, out.trim().split("\n").pop()]).toEqual([1, "BLOCKED"]);
});

// The red run unpacks the base into a temp folder; it used to stay behind after every gate run.
test("the red run removes its temp folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-gate-red-clean-"));
  const tmp = mkdtempSync(join(tmpdir(), "pb-gate-red-tmp-"));
  const sh = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const commit = (m: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --no-verify -m '${m}'`);
  expect(sh("git init -q -b main").exitCode).toBe(0);
  writeFileSync(join(dir, "README.md"), "x\n");
  expect(commit("base").exitCode).toBe(0);
  expect(sh("git checkout -q -b topic").exitCode).toBe(0);
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test/x.test.ts"), `import { test } from "bun:test";\ntest("x", () => {});\n`);
  expect(commit("a test").exitCode).toBe(0);
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/gate.ts"), "main"],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, TMPDIR: tmp, PB_GATES: join(dir, "gates.jsonl") } });
  expect(r.stdout.toString()).toContain("also pass on");
  expect(readdirSync(tmp).filter((f) => f.startsWith("pb-gate-red-"))).toEqual([]);
}, 60_000);

// CI has no ledger (it lives beside the builder, not in the repo): with --no-ledger, the evidence
// rules print as what the builder still needs, and every other rule still blocks.
test("--no-ledger: evidence rules become notes, the rest still block", () => {
  const out = rules(M("src/carve.ts", "src/orientation.ts", "src/cli.ts"), "", T, []);
  const { block, needs } = splitEvidence(out);
  expect(needs.map((x) => x.split(":")[0]).sort()).toEqual(["agent evals", "slice audit"]);
  expect(block.map((x) => x.split(":")[0]).sort()).toEqual(["docs", "test first"]);
});

test("gate --no-run --no-ledger in a repo: an access-core change without a ledger passes with a note; a missing test still blocks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-gate-noledger-"));
  const sh = (cmd: string) => Bun.spawnSync(["sh", "-c", cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const commit = (m: string) => sh(`git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q --no-verify -m '${m}'`);
  const gate = () => Bun.spawnSync(["bun", join(import.meta.dir, "../scripts/gate.ts"), "main", "--no-run", "--no-ledger"],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, PB_GATES: join(dir, "absent.jsonl") } });
  expect(sh("git init -q -b main").exitCode).toBe(0);
  writeFileSync(join(dir, "README.md"), "x\n");
  expect(commit("base").exitCode).toBe(0);
  expect(sh("git checkout -q -b topic").exitCode).toBe(0);
  mkdirSync(join(dir, "src")); mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "src/carve.ts"), "export {};\n");
  writeFileSync(join(dir, "test/carve.test.ts"), "export {};\n");
  mkdirSync(join(dir, "docs")); writeFileSync(join(dir, "docs/carve.md"), "x\n");
  expect(commit("carve").exitCode).toBe(0);
  let r = gate(), out = r.stdout.toString();
  expect(out).toContain("needs evidence the builder records: slice audit");
  expect([r.exitCode, out.trim().split("\n").pop()]).toEqual([0, "MERGE"]);
  // A code change with no test on a branch of its own still blocks.
  expect(sh("git checkout -q -b bare main").exitCode).toBe(0);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/digest.ts"), "export {};\n");
  expect(commit("no test").exitCode).toBe(0);
  r = gate(); out = r.stdout.toString();
  expect(out).toContain("test first");
  expect([r.exitCode, out.trim().split("\n").pop()]).toEqual([1, "BLOCKED"]);
});
