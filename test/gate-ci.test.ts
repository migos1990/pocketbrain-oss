// SPDX-License-Identifier: AGPL-3.0-only
// G521: GitHub CI on main was red from 2026-10-15 to 2026-10-30 while every gate said MERGE. A full
// gate run now reads main's latest CI runs and blocks while main has been red for over a day.
import { test, expect } from "bun:test";
import { ciVerdict, type CiRun } from "../scripts/gate";

const run = (created_at: string, conclusion: string | null, head_sha = "0123456789abcdef"): CiRun => ({ created_at, conclusion, head_sha });
const NOW = Date.parse("2026-10-30T07:00:00Z");

test("main red for two weeks blocks, naming when it went red and the last green day", () => {
  const runs = [run("2026-10-30T06:56:00Z", "failure"), run("2026-10-20T10:00:00Z", "failure"), run("2026-10-15T23:00:00Z", "failure", "fedcba9876543210"), run("2026-10-15T22:26:00Z", "success")];
  const v = ciVerdict(runs, NOW)!;
  expect(v).toContain("red since 2026-10-15T23:00Z (fedcba98)");
  expect(v).toContain("last green 2026-10-15");
});

test("green on top, red for under a day, still running or no runs at all don't block", () => {
  expect(ciVerdict([run("2026-10-30T06:00:00Z", "success"), run("2026-10-29T06:00:00Z", "failure")], NOW)).toBeUndefined();
  expect(ciVerdict([run("2026-10-30T01:00:00Z", "failure"), run("2026-10-29T20:00:00Z", "success")], NOW)).toBeUndefined();
  expect(ciVerdict([run("2026-10-30T06:58:00Z", null), run("2026-10-29T20:00:00Z", "success")], NOW)).toBeUndefined();
  expect(ciVerdict([], NOW)).toBeUndefined();
});

test("red with no green run in sight blocks too", () => {
  expect(ciVerdict([run("2026-10-30T06:00:00Z", "failure"), run("2026-10-20T06:00:00Z", "cancelled")], NOW)).toContain("no green run in the last 2");
});
