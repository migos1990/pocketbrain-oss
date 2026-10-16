// SPDX-License-Identifier: AGPL-3.0-only
// A gardener run that doesn't happen is a failing probe check (docs/gardener.md): for each of its
// hours windows, the latest one that has ended must show the gardener connecting. The weekly run
// calls no upkeep_run, so this is its only detector.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { jobChecks } from "../src/probe";

const NOW = new Date("2026-10-20T12:00:00Z"); // Tuesday 08:00 in Toronto
const reads = (root: string, ats: string[]) => { mkdirSync(join(root, "log"), { recursive: true }); writeFileSync(join(root, "log", "reads.jsonl"), ats.map((at) => JSON.stringify({ at, agent: "gardener", op: "orientation", ids: [] })).join("\n") + "\n"); };
const check = (root: string) => jobChecks(root, NOW).find((c) => c.name === "gardener_runs");

test("a gardener that never connected has no run check", () => {
  expect(check(makeBrain())).toBeUndefined();
});

test("a missed nightly or weekly window fails the check, naming the window and the day", () => {
  const root = makeBrain();
  reads(root, ["2026-10-19T07:31:00Z"]); // Monday 03:31: last night's window (Tuesday 03:25) and Sunday's were missed
  const c = check(root)!;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("daily 03:25-05:00 on 2026-10-20");
  expect(c.detail).toContain("sun 09:55-12:00 on 2026-10-18");
});

test("runs in the latest daily and weekly windows pass", () => {
  const root = makeBrain();
  reads(root, ["2026-10-18T14:02:00Z", "2026-10-20T07:31:00Z"]); // Sunday 10:02, Tuesday 03:31
  expect(check(root)).toMatchObject({ ok: true });
});

test("a window still open now isn't counted as missed yet", () => {
  const root = makeBrain();
  reads(root, ["2026-10-18T14:02:00Z", "2026-10-19T07:31:00Z"]);
  const at4 = new Date("2026-10-20T08:00:00Z"); // Tuesday 04:00, inside tonight's window
  expect(jobChecks(root, at4).find((c) => c.name === "gardener_runs")).toMatchObject({ ok: true });
});
