// SPDX-License-Identifier: AGPL-3.0-only
// The memory exam (src/exam.ts, docs/memory-sync.md "Memory exam"): one scorecard per agent from
// the logs alone. Does its own memory agree with the brain, does it read before it writes, does
// it cite, and does it stay in its slice?
import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import { appendChained } from "../src/readlog";
import { appendJsonl } from "../src/util";
import * as ms from "../src/memsync";
import { exam, examRun, examLines, examDue } from "../src/exam";
import { digest } from "../src/digest";

const OLD = { as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-06-01" };
const NOW = "2026-10-08T12:00:00.000Z";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); process.env.PB_NOW = NOW; });
afterEach(() => { delete process.env.PB_CONFIG_DIR; delete process.env.PB_NOW; });

// Jane Roy's role changed (Teaching assistant -> the current value), so a stale memory has
// something to be wrong about.
function brain(): string {
  const root = makeBrain();
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD }] };
  saveNote(root, jane);
  return root;
}
const janeRole = (root: string) => String((loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as { value: string }).value);
const row = (root: string, agent: string, days = 7) => exam(root, days).find((r) => r.agent === agent)!;
const askJane = (root: string, agent: string) => ms.quiz(root, agent, 1, ["people/jane-roy#role"])[0];

test("an agent that answers from a stale memory fails, and the drift shows", () => {
  const root = brain();
  const q = askJane(root, "helper");
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "She is a teaching assistant." }] });
  const r = row(root, "helper");
  expect(r.memory).toMatchObject({ asked: 1, answered: 1, drift: 1 });
  expect(r.grade).toBe("fail");
  expect(r.why.join(" ")).toMatch(/stale/);
});

test("an agent whose memory agrees with the brain passes", () => {
  const root = brain();
  const q = askJane(root, "helper");
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: janeRole(root) }] });
  const r = row(root, "helper");
  expect(r.memory).toMatchObject({ answered: 1, inSync: 1, drift: 0 });
  expect(r.grade).toBe("pass");
});

test("not keeping a copy is fine: 'nothing' is brain-first, not a failure", () => {
  const root = brain();
  const q = askJane(root, "helper");
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "nothing" }] });
  expect(row(root, "helper").grade).toBe("pass");
});

test("questions left unanswered for a day mean the agent never checks its memory: watch", () => {
  const root = brain();
  process.env.PB_NOW = "2026-10-06T12:00:00.000Z";
  askJane(root, "helper");
  process.env.PB_NOW = NOW;
  const r = row(root, "helper");
  expect(r.memory).toMatchObject({ asked: 1, answered: 0, unanswered: 1 });
  expect(r.grade).toBe("watch");
  expect(r.why.join(" ")).toMatch(/memory_check/);
});

test("a fixed drift counts as fixed: a verified correction leaves the agent passing", () => {
  const root = brain();
  const q = askJane(root, "helper");
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  const fix = ms.state(root).corrections.find((c) => c.agent === "helper")!;
  ms.approve(root, fix.id);
  ms.memoryCheck(root, "helper");
  ms.memoryReply(root, "helper", { corrections: [{ id: fix.id, done: true }] });
  const re = ms.state(root).quizzes.find((x) => x.recheck === fix.id)!;
  ms.memoryReply(root, "helper", { answers: [{ id: re.id, answer: janeRole(root) }] });
  const r = row(root, "helper");
  expect(r.corrections.verified).toBe(1);
  expect(r.grade).toBe("pass");
});

test("writes without a read first, refused citations and slice probes are counted", () => {
  const root = brain();
  const at = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
  appendChained(join(root, "log", "reads.jsonl"), { at: at(5), agent: "planner", op: "read", ids: ["projects/course-a"] });
  appendChained(join(root, "log", "writes.jsonl"), { at: at(4), agent: "planner", key: "projects/course-a#room", outcome: "committed", checks: [] });
  appendChained(join(root, "log", "writes.jsonl"), { at: at(3), agent: "planner", key: "people/jane-roy#role", outcome: "committed", checks: [] });
  appendChained(join(root, "log", "writes.jsonl"), { at: at(2), agent: "planner", key: "people/jane-roy#role", outcome: "refused", checks: ["source_resolvable"] });
  appendChained(join(root, "log", "reads.jsonl"), { at: at(1), agent: "planner", op: "read", ids: [], asked: "money/main-bank" });
  const r = row(root, "planner");
  expect(r.brainFirst).toEqual({ writes: 3, unread: 2 });
  expect(r.citations).toEqual({ writes: 3, refused: 1 });
  expect(r.slice.probes).toBe(1);
  expect(r.grade).toBe("watch");
});

test("a leak alert on an agent fails it", () => {
  const root = brain();
  appendJsonl(join(root, "log", "alerts.jsonl"), { at: NOW, agent: "helper", check: "leak_tripwire", from: "money/main-bank#name" });
  const r = row(root, "helper");
  expect(r.slice.alerts).toBe(1);
  expect(r.grade).toBe("fail");
});

test("old events fall outside the window; an agent with nothing to grade says so", () => {
  const root = brain();
  process.env.PB_NOW = "2026-09-01T12:00:00.000Z";
  const q = askJane(root, "helper");
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  process.env.PB_NOW = NOW;
  expect(row(root, "helper").grade).toBe("no data");
});

test("the gardener and agents inside the wall are not examined", () => {
  const agents = exam(brain()).map((r) => r.agent);
  expect(agents).toContain("helper");
  expect(agents).not.toContain("reflect");
});

test("the exam never names a value: only keys and counts", () => {
  const root = brain();
  const q = askJane(root, "helper");
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "She is a teaching assistant." }] });
  const r = examRun(root);
  const text = readFileSync(r.file, "utf8");
  expect(text).toContain("people/jane-roy#role");
  expect(text.toLowerCase()).not.toContain("teaching assistant");
  expect(text).not.toContain(janeRole(root));
  expect(existsSync(join(root, "log", "exam.jsonl"))).toBe(true);
});

test("the digest carries the latest exam, and a failing agent lands in Needs you", () => {
  const root = brain();
  const q = askJane(root, "helper");
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Teaching assistant" }] });
  examRun(root);
  expect(examLines(root).numbers.join("\n")).toMatch(/Memory exam.*helper fail/);
  const d = digest(root).text;
  expect(d).toMatch(/Memory exam/);
  expect(d.split("## Needs you")[1].split("## ")[0]).toMatch(/helper.*memory exam/i);
});

test("the exam runs weekly: on Sundays, or when the last run is over a week old", () => {
  const root = brain();
  const sun = new Date("2026-10-11T12:00:00Z"), mon = new Date("2026-10-12T12:00:00Z");
  expect(examDue(root, mon)).toBe(false); // a new hub waits for its first Sunday
  expect(examDue(root, sun)).toBe(true);
  process.env.PB_NOW = sun.toISOString();
  examRun(root);
  expect(examDue(root, sun)).toBe(false); // once a day at most
  expect(examDue(root, mon)).toBe(false);
  expect(examDue(root, new Date("2026-10-18T12:00:00Z"))).toBe(true);
  expect(examDue(root, new Date("2026-10-19T12:00:00Z"))).toBe(true); // slept through Sunday
});

test("questions just asked, not yet due, grade nothing", () => {
  const root = brain();
  askJane(root, "helper");
  expect(row(root, "helper").grade).toBe("no data");
});

test("live sync: changed facts an agent hasn't confirmed for a day put it on watch", async () => {
  const { makeBrain } = await import("./fixture");
  const { loadBrain, saveNote } = await import("../src/brain");
  const ms = await import("../src/memsync");
  const { exam } = await import("../src/exam");
  const root = makeBrain();
  process.env.PB_NOW = "2026-10-10T08:00:00Z";
  ms.memoryCheck(root, "helper"); // baseline
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  const was = jane.fm.facts!.role as any;
  jane.fm.history = { role: [{ ...was }] };
  jane.fm.facts!.role = { ...was, value: "Program director", as_of: "2026-10-09" };
  saveNote(root, jane);
  ms.memoryCheck(root, "helper"); // the list goes out
  process.env.PB_NOW = "2026-10-11T12:00:00Z";
  const r = exam(root).find((x) => x.agent === "helper")!;
  expect(r.sync).toEqual({ sent: 1, confirmed: 0, unconfirmed: 1 });
  expect(r.grade).toBe("watch");
  expect(r.why.join(" ")).toContain("not confirmed");
  delete process.env.PB_NOW;
});
