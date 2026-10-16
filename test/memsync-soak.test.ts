// SPDX-License-Identifier: AGPL-3.0-only
// The 14-day memory sync soak (scripts/memsync-soak.ts) as a regression bar: every change reaches
// both assistants within their offline gap, the owner spends a few minutes, and nothing wrong
// sticks in a memory or in the brain.
import { test, expect } from "bun:test";
import { runSoak } from "../scripts/memsync-soak";

test("soak: 14 days of edits, drift, a stale write-back, a forget and a hub restart converge with little owner time", async () => {
  const r = await runSoak();
  expect(r.stuck).toEqual([]);
  expect(r.changes.length).toBe(5);
  expect(Math.max(...r.changes.map((c) => c.converged ?? 99))).toBeLessThanOrEqual(3); // instinct's 3 days offline
  expect(r.ownerMinutes).toBeLessThanOrEqual(5);
  expect(r.cards.filter((c) => c.kind === "change to approve")).toEqual([]); // no dispute or inbox item from stale memory
  expect(r.notes.join("\n")).toContain("refused (replaced_value)");
}, 60_000);
