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
