// SPDX-License-Identifier: AGPL-3.0-only
// The real-use bar: 14 days in a row of daily use with no hand fix, plus one clean restore drill.
import { test, expect } from "bun:test";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { recordFix, recordDrill, bar, measures, week, lastDays } from "../src/measure";

const line = (root: string, file: string, e: Record<string, unknown>) => { mkdirSync(join(root, file, ".."), { recursive: true }); appendFileSync(join(root, file), JSON.stringify(e) + "\n"); };
const used = (root: string, days: string[]) => { for (const d of days) line(root, "log/reads.jsonl", { at: `${d}T12:00:00Z`, agent: "planner", op: "context_pack", ids: ["*"] }); };

test("a hand fix is logged with what was done, and needs a description", () => {
  const root = makeBrain();
  expect(recordFix(root, "restarted the hub by hand", "cli")).toContain("restarted the hub");
  expect(() => recordFix(root, "  ", "cli")).toThrow();
  expect(measures(root, [new Date().toISOString().slice(0, 10)])[0].fixes).toBe(1);
});

test("the streak counts used days back from today and stops at a hand fix", () => {
  const root = makeBrain();
  const days = lastDays(10, "2026-10-20");
  used(root, days);
  line(root, "log/fixes.jsonl", { at: "2026-10-14T09:00:00Z", what: "re-pasted the standing instruction", via: "cli" });
  const b = bar(root, "2026-10-20");
  expect(b.days).toBe(6); // 15th to 20th
  expect(b.lastBreak).toEqual({ date: "2026-10-14", why: "hand fix: re-pasted the standing instruction" });
  expect(b.met).toBe(false);
  expect(b.text).toContain("day 6 of 14");
});

test("a hub failure caught by the probe breaks the streak, and so does a day nobody used it", () => {
  const root = makeBrain();
  used(root, lastDays(5, "2026-10-20"));
  line(root, "log/alerts.jsonl", { at: "2026-10-18T03:00:00Z", agent: "hub", check: "probe_public_door", from: "502" });
  expect(bar(root, "2026-10-20").lastBreak?.why).toContain("hub check failed: probe_public_door");
  expect(bar(root, "2026-10-20").days).toBe(2);
  const quiet = makeBrain();
  used(quiet, ["2026-10-18", "2026-10-20"]);
  expect(bar(quiet, "2026-10-20")).toMatchObject({ days: 1, lastBreak: { date: "2026-10-19", why: "no assistant read the brain" } });
});

test("today without reads yet doesn't break the streak; the gardener's reads aren't use", () => {
  const root = makeBrain();
  // The gardener's line comes first, so the brain's first log line (where the bar starts) is that
  // day whatever the real clock says.
  line(root, "log/reads.jsonl", { at: "2026-10-16T12:00:00Z", agent: "gardener", op: "context_pack", ids: ["*"] });
  used(root, lastDays(3, "2026-10-19"));
  expect(bar(root, "2026-10-20").days).toBe(3);
  expect(bar(root, "2026-10-20").lastBreak?.date).toBe("2026-10-16");
});

test("the bar is met only with 14 clean days and a clean restore drill", () => {
  const root = makeBrain();
  used(root, lastDays(14, "2026-10-20"));
  expect(bar(root, "2026-10-20")).toMatchObject({ days: 14, met: false });
  expect(bar(root, "2026-10-20").text).toContain("restore drill: not yet");
  // Dated inside the bar's window: recordDrill stamps the real clock, which passed 2026-10-20.
  line(root, "log/drills.jsonl", { at: "2026-10-20T11:00:00Z", ok: true });
  const b = bar(root, "2026-10-20");
  expect(b.met).toBe(true);
  expect(b.text).toContain("Bar met");
});

test("a probe failure is a hub outage, not a forged commit", () => {
  const root = makeBrain();
  line(root, "log/alerts.jsonl", { at: "2026-10-18T03:00:00Z", agent: "hub", check: "probe_public_door", from: "502" });
  line(root, "log/alerts.jsonl", { at: "2026-10-18T04:00:00Z", agent: "hub", check: "history_unverified", from: "x" });
  const [m] = measures(root, ["2026-10-18"]);
  expect(m.forged).toBe(1);
  expect(m.hubDown).toBe(1);
  const v = Object.fromEntries(week(root, "2026-10-18").verdicts.map((x) => [x.measure, x.value]));
  expect(v["Forged or wrong-author commits"]).toBe("1");
  expect(v["Hand fixes and hub failures"]).toBe("1");
});

test("days before the brain existed don't break the streak (stranger rehearsal 2)", () => {
  // A brain started yesterday, used yesterday and today: no break on the day before it existed.
  const root = makeBrain({ git: false });
  used(root, ["2026-10-19", "2026-10-20"]);
  const b = bar(root, "2026-10-20");
  expect(b.lastBreak).toBeUndefined();
  expect(b.days).toBe(2);
  // A gap after the first day still breaks it.
  const gap = makeBrain({ git: false });
  used(gap, ["2026-10-17", "2026-10-20"]);
  expect(bar(gap, "2026-10-20")).toMatchObject({ days: 1, lastBreak: { date: "2026-10-19", why: "no assistant read the brain" } });
});

test("the week scorecard names no doc that isn't in the repo", () => {
  const root = makeBrain();
  const text = week(root, "2026-10-20").text;
  for (const ref of text.match(/[\w./-]+\.md\b/g) ?? []) {
    if (ref.startsWith("digest/")) continue;
    expect([ref, existsSync(join(import.meta.dir, "..", ref.includes("/") ? ref : join("docs", ref)))]).toEqual([ref, true]);
  }
});
