// SPDX-License-Identifier: AGPL-3.0-only
// Audit v4: the hub's recurring jobs went from 4 to 6 in a day, one running git log every minute,
// and nothing noticed. The gate counts them (setInterval in src/start.ts) and blocks a branch that
// adds one without a "Job-Budget: <reason>" trailer.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rules, recurringJobs } from "../scripts/gate";

const T = "t".repeat(40);
const change = [{ status: "M", path: "src/start.ts" }, { status: "M", path: "test/x.test.ts" }];

test("a branch that adds a recurring hub job is blocked unless it says why", () => {
  expect(rules(change, "start: tick", T, [], { base: 6, head: 7 }).join("\n")).toContain("Job-Budget");
  expect(rules(change, "start: tick\n\nJob-Budget: replaces the hourly pull with a minute one", T, [], { base: 6, head: 7 })).toEqual([]);
  expect(rules(change, "start: tick", T, [], { base: 7, head: 6 })).toEqual([]);
  expect(rules(change, "start: tick", T, [], { base: 6, head: 6 })).toEqual([]);
});

test("the count is the hub's setInterval calls, and today's number is pinned", () => {
  expect(recurringJobs("setInterval(a, 1); x.setInterval(b, 2); // setTimeout(c)")).toBe(2);
  // daily, gardener tend, probe, pulls, filing, diary catch-up, relay. Changing this number is the
  // decision the trailer records.
  expect(recurringJobs(readFileSync(join(import.meta.dir, "..", "src", "start.ts"), "utf8"))).toBe(7);
});
