// SPDX-License-Identifier: AGPL-3.0-only
// Quiz budget for the belief radar (src/quizplan.ts, docs/memory-sync.md "Quiz budget"): at most N
// questions per assistant per week, spent on the facts most worth asking about first.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import * as ms from "../src/memsync";
import { quizPlan, runQuizPlan } from "../src/quizplan";
import { setFact } from "../src/dashboard/edit";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; delete process.env.PB_NOW; });

const NOW = new Date("2026-10-08T12:00:00Z");
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const plan = (root: string, agent: string, perWeek = 10, now = NOW) => quizPlan(root, { perWeek, now }).find((p) => p.agent === agent);

function answer(root: string, agent: string, key: string, text: string) {
  const [q] = ms.quiz(root, agent, 1, [key]);
  ms.memoryReply(root, agent, { answers: [{ id: q.id, answer: text }] });
}

test("never-asked facts come first, ranked by the person's standing, then by how often agents read the note", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "standing.yaml"), "people:\n  people/paul-advisor: { tier: inner }\n");
  mkdirSync(join(root, "log"), { recursive: true });
  for (let i = 0; i < 3; i++) appendFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-10-07T10:00:00Z", agent: "planner", op: "read", ids: ["projects/course-a"] }) + "\n");
  const keys = plan(root, "steward")!.keys;
  expect(keys[0]).toBe("people/paul-advisor#role");
  expect(keys[1]).toBe("projects/course-a#next_step");
  expect(keys.length).toBe(6);
});

test("a fact answered in the last 30 days isn't asked again; after that it is, behind the never-asked ones", () => {
  const root = makeBrain();
  process.env.PB_NOW = NOW.toISOString();
  answer(root, "helper", "people/jane-roy#role", "Program director");
  expect(plan(root, "helper")!.keys).not.toContain("people/jane-roy#role");
  const later = plan(root, "helper", 10, days(40))!.keys;
  expect(later.at(-1)).toBe("people/jane-roy#role");
});

test("the week's budget counts questions already asked; an open question isn't asked twice", () => {
  const root = makeBrain();
  process.env.PB_NOW = NOW.toISOString();
  ms.quiz(root, "steward", 2);
  const p = plan(root, "steward", 3)!;
  expect(p.asked).toBe(2);
  expect(p.left).toBe(1);
  expect(p.keys.length).toBe(1);
  expect(plan(root, "steward", 3, days(8))!.left).toBe(3);
});

test("paused agents, the gardener and agents whose memory is read directly get no plan", () => {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const y = require("node:fs").readFileSync(f, "utf8").replace("helper: { tier: trial,", "helper: { tier: trial, status: paused,").replace("planner: { tier: core,", "planner: { tier: core, memory: { files: [x.md] },");
  writeFileSync(f, y);
  expect(quizPlan(root, { perWeek: 10, now: NOW }).map((p) => p.agent)).toEqual(["steward"]);
});

test("running the plan asks at most the budget, and a second run the same week asks nothing", () => {
  const root = makeBrain();
  process.env.PB_NOW = NOW.toISOString();
  const first = runQuizPlan(root, { perWeek: 2, now: NOW });
  expect(first.steward.length).toBe(2);
  expect(first.helper.length).toBe(2);
  const second = runQuizPlan(root, { perWeek: 2, now: NOW });
  expect(Object.values(second).flat()).toEqual([]);
});

test("G196: questions the agent triggers itself (changes_seen) don't spend the owner's quiz budget", () => {
  process.env.PB_NOW = NOW.toISOString();
  const root = makeBrain();
  ms.memoryCheck(root, "helper"); // baseline
  const before = quizPlan(root, { perWeek: 3, now: NOW }).find((p) => p.agent === "helper")!;
  expect(before.left).toBe(3);
  setFact(root, "people/jane-roy", "role", "Department chair");
  setFact(root, "projects/course-a", "next_step", "Grade the final");
  const check = ms.memoryCheck(root, "helper");
  expect(check.changes).toBeDefined();
  ms.memoryReply(root, "helper", { changes_seen: check.changes!.id });
  // answer the recheck questions straight from the feed it was just handed
  const qs = ms.memoryCheck(root, "helper").questions;
  const items = check.changes!.items;
  ms.memoryReply(root, "helper", { answers: qs.map((q) => ({ id: q.id, answer: items.find((i) => q.question.includes(i.about.split(":")[0]))?.now ?? "nothing" })) });
  const after = quizPlan(root, { perWeek: 3, now: NOW }).find((p) => p.agent === "helper")!;
  expect(after.left).toBe(3);
});

test("G196: feed rechecks don't count in the memory exam either", () => {
  process.env.PB_NOW = NOW.toISOString();
  const root = makeBrain();
  ms.memoryCheck(root, "helper");
  setFact(root, "people/jane-roy", "role", "Department chair");
  const check = ms.memoryCheck(root, "helper");
  ms.memoryReply(root, "helper", { changes_seen: check.changes!.id });
  expect(ms.state(root).quizzes.filter((q) => q.agent === "helper").every((q) => q.feed === check.changes!.id)).toBe(true);
});

// The nightly pass (memsync syncPass, the gardener's memory_sync) and the budget: report-only
// until the owner sets memsync.quiz_budget in policy.yaml; then it asks the plan's top keys only.
const setBudget = (root: string, v: unknown) => {
  const f = join(root, "rules", "policy.yaml");
  writeFileSync(f, require("node:fs").readFileSync(f, "utf8") + `memsync:\n  quiz_budget: ${JSON.stringify(v)}\n`);
};

test("the nightly pass without a budget asks as before and says what the plan would ask", () => {
  const root = makeBrain();
  process.env.PB_NOW = NOW.toISOString();
  const r = ms.syncPass(root, 3);
  expect(r.steward.quizzed).toBe(3);
  expect(r.steward.planned).toBe(3);
  expect(r.steward.budget).toBeUndefined();
});

test("with memsync.quiz_budget the nightly pass asks the plan's top keys and stops at the week's budget", () => {
  const root = makeBrain();
  process.env.PB_NOW = NOW.toISOString();
  writeFileSync(join(root, "rules", "standing.yaml"), "people:\n  people/paul-advisor: { tier: inner }\n");
  setBudget(root, 4);
  const first = ms.syncPass(root, 3);
  expect(first.steward).toEqual({ quizzed: 3, planned: 3, budget: { per_week: 4, left: 1 } });
  const asked = ms.state(root).quizzes.filter((q) => q.agent === "steward").map((q) => q.key);
  expect(asked).toContain("people/paul-advisor#role");
  expect(ms.syncPass(root, 3).steward).toEqual({ quizzed: 1, planned: 1, budget: { per_week: 4, left: 0 } });
  expect(ms.syncPass(root, 3).steward).toEqual({ quizzed: 0, planned: 0, budget: { per_week: 4, left: 0 } });
});

test("quiz_budget: true is the default budget; a bad value counts as no budget", () => {
  const root = makeBrain();
  process.env.PB_NOW = NOW.toISOString();
  setBudget(root, true);
  expect(ms.syncPass(root, 3).steward.budget).toEqual({ per_week: 10, left: 7 });
  const other = makeBrain();
  setBudget(other, "lots");
  expect(ms.syncPass(other, 3).steward.budget).toBeUndefined();
});
