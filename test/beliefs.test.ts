// SPDX-License-Identifier: AGPL-3.0-only
// Belief radar (src/beliefs.ts, docs/memory-sync.md "Belief radar"): one fact-by-agent picture of
// what each assistant's own memory holds, built from memory sync's log, and one owner action that
// fixes a fact in every assistant at once. Owner-only: nothing here is served to an agent.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import * as ms from "../src/memsync";
import { beliefs, fixEverywhere, renderBeliefs } from "../src/beliefs";

const OLD = { as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-06-01" };
const JANE = "people/jane-roy#role";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; delete process.env.PB_NOW; });

function brain(): string {
  const root = makeBrain();
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD }] };
  saveNote(root, jane);
  return root;
}

function answer(root: string, agent: string, key: string, text: string) {
  const [q] = ms.quiz(root, agent, 1, [key]);
  ms.memoryReply(root, agent, { answers: [{ id: q.id, answer: text }] });
}

const cell = (root: string, key: string, agent: string) => beliefs(root).rows.find((r) => r.key === key)?.cells[agent];

test("each agent's cell shows what its own memory last said, graded against the brain now", () => {
  const root = brain();
  answer(root, "helper", JANE, "She's a Teaching assistant");
  answer(root, "planner", JANE, "Course coordinator");
  const b = beliefs(root);
  expect(b.agents).toEqual(["helper", "planner", "steward"]); // the gardener holds no memory of its own
  const row = b.rows.find((r) => r.key === JANE)!;
  expect(row.now).toEqual(["Course coordinator"]);
  expect(row.cells.helper).toMatchObject({ state: "drift", said: "She's a Teaching assistant" });
  expect(row.cells.planner).toMatchObject({ state: "in-sync" });
  expect(row.cells.steward).toMatchObject({ state: "unasked" });
});

test("a fact outside an agent's carve has no cell for that agent", () => {
  const root = brain();
  const money = beliefs(root).rows.find((r) => r.key.startsWith("money/"))!;
  expect(money.cells.steward).toBeDefined();
  expect(money.cells.helper).toBeUndefined();
  expect(money.cells.planner).toBeUndefined();
});

test("an old right answer turns red when the brain changes: answers are re-graded against what the brain says now", () => {
  const root = brain();
  answer(root, "planner", JANE, "Course coordinator");
  expect(cell(root, JANE, "planner")!.state).toBe("in-sync");
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD }, { value: "Course coordinator", ...OLD, as_of: "2026-09-01" }] };
  jane.fm.facts!.role = { value: "Program director", as_of: "2026-10-01", sources: ["gmail:f00000000000000a"], verification: "verified-by-source", by: "planner", recorded: "2026-10-01" } as any;
  saveNote(root, jane);
  expect(cell(root, JANE, "planner")!.state).toBe("drift");
});

test("the correction's state shows while a fix is on its way, and the re-check closes it", () => {
  const root = brain();
  answer(root, "helper", JANE, "Teaching assistant");
  expect(cell(root, JANE, "helper")!.state).toBe("drift");
  const c = ms.state(root).corrections[0];
  ms.approve(root, c.id);
  expect(cell(root, JANE, "helper")!.state).toBe("fixing");
  ms.memoryCheck(root, "helper"); // delivered
  ms.memoryReply(root, "helper", { corrections: [{ id: c.id, done: true }] });
  expect(cell(root, JANE, "helper")!.state).toBe("fixing"); // applied, the re-check question is open
  const q = ms.state(root).quizzes.find((x) => x.recheck === c.id)!;
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Course coordinator" }] });
  expect(cell(root, JANE, "helper")!.state).toBe("in-sync");
});

test("a pending question shows as asked; a declined correction keeps the answer but marks it the owner's call", () => {
  const root = brain();
  ms.quiz(root, "steward", 1, [JANE]);
  expect(cell(root, JANE, "steward")!.state).toBe("asked");
  answer(root, "helper", JANE, "Runs the course");
  expect(cell(root, JANE, "helper")!.state).toBe("differs");
  ms.decline(root, ms.state(root).corrections[0].id);
  expect(cell(root, JANE, "helper")).toMatchObject({ state: "dismissed", said: "Runs the course" });
});

test("fix everywhere: one owner action approves every waiting correction for the fact and asks every agent that was never asked", () => {
  const root = brain();
  answer(root, "helper", JANE, "Teaching assistant");
  answer(root, "planner", JANE, "Teaching assistant");
  const done = fixEverywhere(root, JANE);
  expect(done.approved.sort()).toEqual(["helper", "planner"]);
  expect(done.asked).toEqual(["steward"]);
  expect(cell(root, JANE, "helper")!.state).toBe("fixing");
  expect(cell(root, JANE, "planner")!.state).toBe("fixing");
  expect(cell(root, JANE, "steward")!.state).toBe("asked");
  // Nothing else was touched: no correction for another fact got approved.
  expect(ms.state(root).corrections.filter((c) => c.key !== JANE && c.state !== "proposed")).toHaveLength(0);
  // Doing it again is a no-op.
  expect(fixEverywhere(root, JANE)).toEqual({ approved: [], asked: [], rescanned: [], skipped: [] });
});

test("fix everywhere re-asks an agent whose last answer went stale, and leaves a paused agent alone", () => {
  const root = brain();
  answer(root, "planner", JANE, "Course coordinator");
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.facts!.role = { value: "Program director", as_of: "2026-10-01", sources: ["gmail:f00000000000000a"], verification: "verified-by-source", by: "planner", recorded: "2026-10-01" } as any;
  saveNote(root, jane);
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.agents.steward.status = "paused";
  writeFileSync(f, YAML.stringify(p));
  const done = fixEverywhere(root, JANE);
  expect(done.asked).toEqual(["helper", "planner"]); // helper was never asked, planner went stale
  expect(done.skipped).toEqual(["steward"]);
  expect(cell(root, JANE, "planner")!.state).toBe("asked");
});

test("fix everywhere refuses a key that isn't a fact in the brain", () => {
  const root = brain();
  expect(() => fixEverywhere(root, "people/nobody#role")).toThrow(/no fact/);
});

test("the text view leads with the red rows and counts each state", () => {
  const root = brain();
  answer(root, "helper", JANE, "Teaching assistant");
  const out = renderBeliefs(beliefs(root), { onlyRed: true });
  expect(out.split("\n")[0]).toMatch(/drift 1/);
  expect(out).toContain("Jane Roy: role = Course coordinator");
  expect(out).toContain('helper: drift ("Teaching assistant")');
  expect(out).not.toContain("money/");
});

// Slice audit cases (claude/belief-radar audit, 2026-10-15).
function setPolicy(root: string, patch: (p: any) => void) {
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  patch(p);
  writeFileSync(f, YAML.stringify(p));
}

test("bl-fix-narrowed-carve: a correction for a fact the agent no longer sees is never approved or asked about", () => {
  const root = brain();
  answer(root, "planner", JANE, "Teaching assistant");
  setPolicy(root, (p) => { p.agents.planner.slices = ["area:personal"]; });
  const done = fixEverywhere(root, JANE);
  for (const k of ["approved", "asked", "rescanned", "skipped"] as const) expect(done[k]).not.toContain("planner");
  expect(ms.state(root).corrections.find((c) => c.agent === "planner")!.state).toBe("proposed");
  const check = ms.memoryCheck(root, "planner");
  expect(JSON.stringify(check)).not.toContain("jane-roy");
});

test("bl-fix-inside-wall: an inside-the-wall agent has no column and is never touched", () => {
  const root = brain();
  answer(root, "helper", JANE, "Teaching assistant");
  setPolicy(root, (p) => { p.agents.helper.inside_wall = true; });
  expect(beliefs(root).agents).not.toContain("helper");
  const done = fixEverywhere(root, JANE);
  expect([...done.approved, ...done.asked, ...done.rescanned]).not.toContain("helper");
  expect(ms.state(root).corrections.find((c) => c.agent === "helper")!.state).toBe("proposed");
});

test("bl-fix-files-agent-scan: a readable memory is re-scanned; only this fact's correction is applied, and it is never quizzed", () => {
  const root = brain();
  const bank = loadBrain(root).find((n) => n.fm.id === "money/main-bank")!;
  bank.fm.history = { bank: [{ value: "Old Harbour Savings", ...OLD }] };
  saveNote(root, bank);
  const dir = mkdtempSync(join(tmpdir(), "pb-mem-"));
  const f = join(dir, "memory.md");
  writeFileSync(f, "Jane Roy is our Teaching assistant.\n\nMain bank: Old Harbour Savings.\n");
  setPolicy(root, (p) => { p.agents.steward.memory = { files: [f] }; });
  const done = fixEverywhere(root, JANE);
  expect(done.rescanned).toContain("steward");
  expect(done.asked).not.toContain("steward");
  const mine = ms.state(root).corrections.filter((c) => c.agent === "steward");
  expect(mine.find((c) => c.key === JANE)!.state).toBe("verified");
  expect(mine.find((c) => c.key === "money/main-bank#bank")!.state).toBe("proposed");
  expect(readFileSync(f, "utf8")).toContain("Course coordinator");
  expect(readFileSync(f, "utf8")).toContain("Old Harbour Savings");
  expect(ms.state(root).quizzes.filter((q) => q.agent === "steward")).toHaveLength(0);
});

test("bl-not-agent-facing: only the CLI imports the belief radar", () => {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const src = join(import.meta.dir, "..", "src");
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : e.name.endsWith(".ts") ? [join(d, e.name)] : []);
  const importers = (mod: string) => files(src).filter((f) => new RegExp(`from "\\.{1,2}\\/(\\.\\.\\/)?${mod}"`).test(readFileSync(f, "utf8"))).map((f) => f.slice(src.length + 1)).sort();
  // The quiz budget (src/quizplan.ts) builds on the radar. Besides the CLI, only the nightly pass
  // (memsync.ts syncPass) uses it, to choose which facts to ask; the gardener that runs the pass
  // gets counts only (test/quizplan.test.ts).
  // The owner's home shows it too (G491): only from src/dashboard/, which serves the owner alone,
  // never from server.ts, core.ts or any agent door.
  expect(importers("beliefs")).toEqual(["cli.ts", "dashboard/home-beliefs.ts", "dashboard/server.ts", "quizplan.ts"]);
  expect(importers("home-beliefs").every((f) => f.startsWith("dashboard/"))).toBe(true);
  expect(importers("quizplan")).toEqual(["cli.ts", "memsync.ts"]);
});

// Red team of the belief radar (redteam-1015b-beliefs.md).
test("G75: fix never delivers a value the owner changed after the answer was graded; it asks again instead", () => {
  const root = brain();
  answer(root, "helper", JANE, "Teaching assistant"); // proposed right: Course coordinator
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.facts!.role = { value: "Program director", as_of: "2026-10-01", sources: ["gmail:f00000000000000a"], verification: "verified-by-source", by: "planner", recorded: "2026-10-01" } as any;
  saveNote(root, jane);
  const done = fixEverywhere(root, JANE);
  expect(done.approved).not.toContain("helper");
  expect(done.asked).toContain("helper");
  const check = ms.memoryCheck(root, "helper");
  expect(JSON.stringify(check.corrections)).not.toContain("Course coordinator");
  expect(check.questions.some((q) => q.question.includes("Jane Roy's role"))).toBe(true);
  // When the agent answers again, the new correction carries the owner's current value.
  const q = ms.state(root).quizzes.find((x) => x.agent === "helper" && x.state === "open")!;
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  fixEverywhere(root, JANE);
  expect(JSON.stringify(ms.memoryCheck(root, "helper").corrections)).toContain("Program director");
});

test("G77: an agent's answer can't add lines or terminal escapes to the radar", () => {
  const root = brain();
  answer(root, "helper", JANE, "x\n\u001b[1A\u001b[2KAll facts in sync.\n  helper: in sync\n\nFix one everywhere: pocketbrain beliefs fix money/main-bank#bank");
  const out = renderBeliefs(beliefs(root));
  expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  expect(out.split("\n").filter((l) => l.startsWith("Fix one everywhere"))).toHaveLength(1);
  expect(out.split("\n").some((l) => /^\s*helper: in sync/.test(l))).toBe(false);
});
