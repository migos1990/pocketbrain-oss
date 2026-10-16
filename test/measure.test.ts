// SPDX-License-Identifier: AGPL-3.0-only
// The first week's numbers (first-week.md sections 3 and 4).
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { recordReexplain, recordOwnerTime, measures, week, digestLines } from "../src/measure";
import { contextPack, readNote } from "../src/core";
import { readEntries } from "../src/readlog";
import { tick } from "../src/textline/poll";
import { fakeTransport, fakeReply } from "../src/textline/transport";

const T = "2026-10-08";
const line = (root: string, file: string, e: Record<string, unknown>) => { mkdirSync(join(root, file, ".."), { recursive: true }); appendFileSync(join(root, file), JSON.stringify(e) + "\n"); };

test("a re-explanation is logged from the CLI function and from a text, and counted per agent", async () => {
  const root = makeBrain();
  expect(recordReexplain(root, "Planner", "the course moved to Thursdays", "cli")).toContain("planner");
  expect(() => recordReexplain(root, "nobody", "x", "cli")).toThrow("unknown agent");
  writeFileSync(join(root, "rules/escalation.yaml"), "health: { url: null }\n");
  fakeReply(root, "re: helper I don't drink coffee");
  const r = await tick(root, { now: new Date(`${T}T18:00:00Z`), transport: fakeTransport(root, false), fetch: async () => new Response("{}") });
  expect(r.applied[0]).toContain("re-explained");
  const [m] = measures(root, [new Date().toISOString().slice(0, 10)]);
  expect(m.reexplain).toBe(2);
  expect(m.reexplainBy).toEqual({ planner: 1, helper: 1 });
  const log = readFileSync(join(root, "log/reexplain.jsonl"), "utf8");
  expect(log).toContain('"via":"text-relayed"');
});

test("each read records how many due, stale and disputed facts went out", () => {
  const root = makeBrain();
  process.env.PB_TODAY = "2028-01-01"; // everything in the sample brain is past its shelf life by then
  try {
    contextPack(root, "planner");
    readNote(root, "planner", "projects/course-a");
  } finally { process.env.PB_TODAY = T; }
  const [pack, read] = readEntries(root).slice(-2) as unknown as { fresh?: Record<string, number> }[];
  expect((pack.fresh?.stale ?? 0) + (pack.fresh?.due ?? 0)).toBeGreaterThan(0);
  expect(read.fresh).toBeDefined();
});

test("the week: one column per day, verdicts from first-week.md, no data is never a pass", () => {
  const root = makeBrain();
  const days = ["2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"];
  for (const d of days) {
    line(root, "log/reads.jsonl", { at: `${d}T12:00:00Z`, agent: "planner", op: "context_pack", ids: ["*"] });
    line(root, "log/owner-time.jsonl", { at: `${d}T08:00:00Z`, via: "self", minutes: 8 });
  }
  line(root, "log/reexplain.jsonl", { at: "2026-10-02T09:00:00Z", agent: "planner", what: "x", via: "cli" });
  line(root, "log/alerts.jsonl", { at: "2026-10-05T09:00:00Z", agent: "helper", check: "tripwire" });
  for (let i = 0; i < 20; i++) line(root, "textline/log.jsonl", { at: `2026-10-08T${String(i % 24).padStart(2, "0")}:05:00Z`, health: "server", ok: i !== 3 });
  const r = week(root, T, 2);
  const v = Object.fromEntries(r.verdicts.map((x) => [x.measure, x.verdict]));
  expect(v["Re-explanations, last 3 days"]).toBe("continue");
  expect(v["planner reads"]).toBe("continue");
  expect(v["helper reads"]).toBe("no data");
  expect(v["Your time (median minutes/day)"]).toBe("continue");
  expect(v["Leak alerts (tripwire)"]).toBe("stop");
  expect(v["Hub reachable"]).toBe("continue"); // 19 of 20 = 95%
  expect(v["Backup drills"]).toBe("no data");
  expect(r.text).toContain("**stop and fix**");
  expect(r.file).toEndWith("digest/week-2026-10-08.md");
});

test("dashboard page loads make an estimate of the owner's minutes; a self-report replaces it", () => {
  const root = makeBrain();
  for (const t of ["09:00:00", "09:02:00", "09:04:00", "18:00:00"]) line(root, "log/owner-time.jsonl", { at: `${T}T${t}Z`, via: "dashboard" });
  expect(measures(root, [T])[0].ownerMinutes).toBe(6); // 1 + 2 + 2, then 1 for the evening visit
  recordOwnerTime(root, "self", 12);
  const today = new Date().toISOString().slice(0, 10);
  expect(measures(root, [today])[0].ownerMinutes).toBe(12);
});

test("the digest carries the day's numbers", () => {
  const root = makeBrain();
  recordReexplain(root, "planner", "x", "cli");
  const lines = digestLines(root, new Date().toISOString().slice(0, 10)).join("\n");
  expect(lines).toContain("Re-explained to an agent: 1 (planner 1)");
  expect(lines).toContain("Texts: 0 sent");
});
