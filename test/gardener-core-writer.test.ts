// SPDX-License-Identifier: AGPL-3.0-only
// Outside review v3, 2026-10-26: the Gardener's prompt capped it at 5 synced pages, 3 missing
// pages and 5 proposals a night, told it it only proposes, and asked for a [^1] on its summary
// line (15 summaries showed a raw marker). Shipped with the owner's tier flip (docs/gardener.md).
import { test, expect } from "bun:test";
import { gardenerSteps } from "../src/tend";

test("the Gardener's prompts let it write the wiki at the brain's pace, and its summaries carry no marker", () => {
  const n = gardenerSteps.nightly("Robin"), w = gardenerSteps.weekly("Robin");
  expect(n).toContain("For up to 20 pages among the changed notes");
  expect(n).toContain("For the first 10, `read` the page");
  expect(w).toContain("for up to 20 pages in `last_run`'s `wiki_missing`");
  for (const p of [n, w]) {
    expect(p).toContain("summary in plain words (no reference marker)");
    expect(p).not.toMatch(/Propose at most \d/);
    expect(p).not.toContain("you only propose");
  }
  expect(n).toContain("The summary is plain words with no reference marker");
  // It still never settles a conflict.
  expect(n).toContain("Never settle a conflict");
  expect(w).toContain("Don't settle disputes");
});
