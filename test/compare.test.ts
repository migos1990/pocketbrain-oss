// SPDX-License-Identifier: AGPL-3.0-only
// Paired compare of an eval run against a saved baseline (evals/lib/compare.ts): flips by case
// id, the flaky-case rule for --k >= 3, open gaps never counting, and both file shapes.
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, toBaseline, loadRun, render, promptHash, baselinePath, type RunCase } from "../evals/lib/compare";

const c = (id: string, pass: boolean | "n/a", extra: Partial<RunCase> = {}): RunCase => ({ id, pass, ...extra });

test("pass->fail is a regression, fail->pass an improvement; new and missing are listed, not failed", () => {
  const r = compare([c("a", true), c("b", false), c("c", true), c("gone", true)], [c("a", false), c("b", true), c("c", true), c("fresh", false)]);
  expect(r.regressions.map((x) => x.id)).toEqual(["a"]);
  expect(r.improvements.map((x) => x.id)).toEqual(["b"]);
  expect(r.added).toEqual(["fresh"]);
  expect(r.missing).toEqual(["gone"]);
  expect(r.paired).toBe(3);
  expect(r.ok).toBe(false);
});

test("an open gap failing is not a regression; n/a on either side is not a flip", () => {
  const r = compare([c("g", true), c("n", true), c("m", "n/a")], [c("g", false, { gap: "G9" }), c("n", "n/a"), c("m", false)]);
  expect(r.regressions).toEqual([]);
  expect(r.gapFlips.map((x) => x.id)).toEqual(["g"]);
  expect(r.ok).toBe(true);
});

test("with k >= 3 a regression needs the pass count to drop by 2 or more of k", () => {
  const base = [c("x", true, { runs: { pass: 3, k: 3 } }), c("y", true, { runs: { pass: 3, k: 3 } }), c("z", false, { runs: { pass: 1, k: 3 } })];
  const cur = [c("x", false, { runs: { pass: 2, k: 3 } }), c("y", false, { runs: { pass: 1, k: 3 } }), c("z", true, { runs: { pass: 3, k: 3 } })];
  const r = compare(base, cur);
  expect(r.regressions.map((x) => x.id)).toEqual(["y"]);
  expect(r.improvements.map((x) => x.id)).toEqual(["z"]);
  expect(r.rates.find((x) => x.id === "x")!.delta).toBeCloseTo(-1 / 3);
  expect(r.flaky.map((x) => x.id)).toEqual(["x"]);
});

test("k below 3 falls back to plain pass/fail", () => {
  const r = compare([c("x", true, { runs: { pass: 2, k: 2 } })], [c("x", false, { runs: { pass: 1, k: 2 } })]);
  expect(r.regressions.map((x) => x.id)).toEqual(["x"]);
});

test("toBaseline keeps id, pass, gap, metrics, detail and runs; loadRun reads a baseline and a results.json alike", () => {
  const scored = [{ id: "a", dimension: "e2e", title: "t", gap: "G1", llm: true, run: async () => ({ pass: true }), ms: 3, result: { pass: false, detail: "d", metrics: { utility: 1 } }, runs: { pass: 1, k: 3 } }];
  const b = toBaseline("agents", { app_commit: "abc", driver: "scripted+llm(m, judge j, k=3)", at: "2026-10-15T00:00:00Z" }, scored as any, "deadbeef", { agent: "m", judge: "j" });
  expect(b).toMatchObject({ name: "agents", app_commit: "abc", prompt_hash: "deadbeef", model: { agent: "m", judge: "j" } });
  expect(b.cases[0]).toEqual({ id: "a", pass: false, gap: "G1", llm: true, detail: "d", metrics: { utility: 1 }, runs: { pass: 1, k: 3 } });
  const dir = mkdtempSync(join(tmpdir(), "pb-cmp-"));
  writeFileSync(join(dir, "b.json"), JSON.stringify(b));
  writeFileSync(join(dir, "r.json"), JSON.stringify({ summary: { app_commit: "def", driver: "scripted", prompt_hash: "beef" }, cases: scored }));
  const fromB = loadRun(join(dir, "b.json")), fromR = loadRun(join(dir, "r.json"));
  expect(fromB.cases).toEqual(fromR.cases.map((x) => ({ ...x })));
  expect(fromR.meta).toMatchObject({ app_commit: "def", prompt_hash: "beef" });
  expect(JSON.parse(readFileSync(join(dir, "b.json"), "utf8")).cases.length).toBe(1);
});

test("render gives a one-line verdict naming the baseline and the prompt change", () => {
  const r = compare([c("a", true)], [c("a", false)]);
  const out = render(r, { name: "det", prompt_hash: "aaa" }, { prompt_hash: "bbb" });
  expect(out).toContain("1 regression vs baseline det");
  expect(out).toContain("prompt changed since baseline (aaa -> bbb)");
  expect(render(compare([c("a", true)], [c("a", true)]), { name: "det", prompt_hash: "x" }, { prompt_hash: "x" })).toContain("no regression vs baseline det");
});

test("promptHash is stable for the sample brain; baseline names are plain words", async () => {
  const h = await promptHash();
  expect(h).toMatch(/^[0-9a-f]{12}$/);
  expect(await promptHash()).toBe(h);
  expect(baselinePath("agents")).toEndWith(join("evals", "baselines", "agents.json"));
  expect(() => baselinePath("../x")).toThrow();
});
