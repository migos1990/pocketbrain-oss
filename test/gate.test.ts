// SPDX-License-Identifier: AGPL-3.0-only
// Contract of the merge gate's rules (scripts/gate.ts): what each kind of diff requires.
import { test, expect } from "bun:test";
import { rules, checkFailures, type Change, type Entry } from "../scripts/gate";

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
