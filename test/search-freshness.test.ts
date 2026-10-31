// SPDX-License-Identifier: AGPL-3.0-only
// Search hits carry freshness (backlog 316): each hit says the least fresh of the facts the agent
// can see on it, so a stale or disputed note isn't stated as current from the hit list alone.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { search } from "../src/core";

const keep = process.env.PB_TODAY;
afterEach(() => { if (keep === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = keep; });
const jane = (root: string) => search(root, "steward", "Jane coordinator").find((h) => h.id === "people/jane-roy")!;

test("a hit is current, due or stale by its least fresh visible fact", () => {
  const root = makeBrain();
  process.env.PB_TODAY = "2026-10-10";
  expect(jane(root).freshness).toBe("current");
  process.env.PB_TODAY = "2027-04-15"; // role is 180 days old: past its shelf life
  expect(jane(root).freshness).toBe("due");
  process.env.PB_TODAY = "2028-01-15"; // twice the shelf life
  expect(jane(root).freshness).toBe("stale");
});

test("every hit has a freshness, and a note with no visible facts says so", () => {
  const root = makeBrain();
  const hits = search(root, "steward", "course");
  expect(hits.length).toBeGreaterThan(0);
  for (const h of hits) expect(["current", "due", "stale", "disputed", "no facts"]).toContain(h.freshness);
});

test("a fact hidden from the agent never sets its hit's freshness", () => {
  const root = makeBrain();
  const f = join(root, "projects/course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("\nfacts:\n", `\nfacts:\n  review_plan: { value: Reorder the quiz, as_of: 2026-09-01, review_after: 2026-09-15, share_with: [steward], sources: ["gmail:f000000000000003"], verification: verified-by-source, by: steward, recorded: 2026-09-01 }\n`));
  git(root, ["commit", "-qam", "hidden review_plan\n\nprojects/course-a#review_plan"]);
  process.env.PB_TODAY = "2026-10-05";
  const hit = (agent: string) => search(root, agent, "course").find((h) => h.id === "projects/course-a")!;
  expect(hit("steward").freshness).toBe("due"); // steward sees the overdue review
  expect(hit("helper").freshness).toBe("current"); // helper's view holds only the current next_step
});
