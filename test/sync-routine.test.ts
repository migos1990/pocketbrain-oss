// SPDX-License-Identifier: AGPL-3.0-only
// The sync routine (docs/memory-sync.md, "Sync routine"): nothing can wake a hosted assistant, so
// each one schedules memory_check itself and says which it did in its memory_check reply; the exam
// shows an agent that uses the brain but never calls memory_check.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { appendChained } from "../src/readlog";
import * as ms from "../src/memsync";
import { exam, examText } from "../src/exam";
import { appendJsonl, readJsonl } from "../src/util";

const NOW = "2026-10-08T12:00:00.000Z";
const at = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); process.env.PB_NOW = NOW; });
afterEach(() => { delete process.env.PB_CONFIG_DIR; delete process.env.PB_NOW; });

const events = (root: string) => readJsonl<Record<string, any>>(join(root, "log", "memsync.jsonl"));
const row = (root: string, agent: string) => exam(root).find((r) => r.agent === agent)!;
function setPolicy(root: string, patch: (p: any) => void) {
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  patch(p);
  writeFileSync(f, YAML.stringify(p));
}
const called = (root: string, agent: string, tool: string, h: number, refused?: string) => appendJsonl(join(root, "log", "calls.jsonl"), { at: at(h), agent, tool, ...(refused ? { refused } : {}) });
// A write that read its note first, so only the routine can put the agent on watch.
const wrote = (root: string, agent: string, h: number) => {
  appendChained(join(root, "log", "reads.jsonl"), { at: at(h + 1), agent, op: "read", ids: ["projects/course-a"] });
  appendChained(join(root, "log", "writes.jsonl"), { at: at(h), agent, key: "projects/course-a#room", outcome: "committed", checks: [] });
};

test("an agent's reply says which routine it set up; the hub logs it, refuses an unknown one", () => {
  const root = makeBrain();
  expect(ms.memoryReply(root, "helper", { routine: "hourly" } as never).routine).toMatch(/noted/);
  expect(ms.memoryReply(root, "helper", { routine: "every full moon" } as never).routine).toMatch(/hourly, daily, asked-owner or none/);
  const r = events(root).filter((e) => e.ev === "routine");
  expect(r).toHaveLength(1);
  expect(r[0]).toMatchObject({ agent: "helper", routine: "hourly" });
  expect(ms.state(root).routines.get("helper")).toMatchObject({ routine: "hourly" });
});

test("a read-only or paused agent's routine is not logged", () => {
  const root = makeBrain();
  setPolicy(root, (p) => { p.agents.helper.status = "read-only"; });
  expect(() => ms.memoryReply(root, "helper", { routine: "hourly" } as never)).toThrow();
  setPolicy(root, (p) => { p.agents.helper.status = "paused"; });
  expect(() => ms.memoryReply(root, "helper", { routine: "daily" } as never)).toThrow();
  expect(events(root).filter((e) => e.ev === "routine")).toHaveLength(0);
});

test("exam: the last memory_check comes from the call log, through any door; a refused call doesn't count", () => {
  const root = makeBrain();
  called(root, "helper", "memory_check", 30);
  called(root, "helper", "POST /v1/memory-check", 20);
  called(root, "helper", "memory_check", 1, "paused by the owner");
  called(root, "planner", "GET /b/memory-check", 5);
  called(root, "planner", "whats_new", 1);
  expect(row(root, "helper").routine.lastCheck).toBe(at(20));
  expect(row(root, "planner").routine.lastCheck).toBe(at(5));
});

test("exam: an agent that uses the brain but hasn't called memory_check in 2 days is on watch", () => {
  const root = makeBrain();
  wrote(root, "helper", 3);
  const r = row(root, "helper");
  expect(r.routine).toMatchObject({ lastCheck: undefined });
  expect(r.grade).toBe("watch");
  expect(r.why.join(" ")).toMatch(/hasn't called memory_check in 2 days/);
});

test("exam: an hourly routine with a check today passes, and the table shows the routine", () => {
  const root = makeBrain();
  wrote(root, "helper", 3);
  called(root, "helper", "memory_check", 2);
  ms.memoryReply(root, "helper", { routine: "hourly" } as never);
  const r = row(root, "helper");
  expect(r.routine).toEqual({ said: "hourly", lastCheck: at(2) });
  expect(r.grade).toBe("pass");
  expect(examText(exam(root), 7)).toMatch(/\| helper \| pass \|.*\| hourly \|/);
});

test("exam: a check 3 days ago is too old, an idle agent stays 'no data', a paused one isn't chased", () => {
  const root = makeBrain();
  called(root, "helper", "memory_check", 72);
  wrote(root, "helper", 3);
  expect(row(root, "helper").grade).toBe("watch");
  expect(row(root, "planner").grade).toBe("no data");
  wrote(root, "planner", 3);
  setPolicy(root, (p) => { p.agents.planner.status = "paused"; });
  expect(row(root, "planner").why.join(" ")).not.toMatch(/memory_check in 2 days/);
});
