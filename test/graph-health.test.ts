// SPDX-License-Identifier: AGPL-3.0-only
// memory-graph.md item 5: the week report's Brain health counts notes linked to no other note and
// links to notes that don't exist (counts only), and a fact's page says how it ages: "check again
// in <month>" for a kind with a shelf life, "doesn't go out of date" for one declared without.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { brainHealth, healthLines } from "../src/health";
import { loadState } from "../src/dashboard/data";
import { notePage } from "../src/dashboard/html-brain";

test("Brain health counts islands and broken links, never a title", () => {
  const root = makeBrain();
  const p = join(root, "projects/course-b.md");
  writeFileSync(p, readFileSync(p, "utf8").replace(/\n*$/, "\nSee [[people/nobody-here]].\n"));
  const h = Object.fromEntries(brainHealth(root).map((l) => [l.key, l]));
  // Jane -> Course A -> Main bank are tied together; Course B, Paul and the bank decision aren't.
  expect(h.unlinked).toMatchObject({ count: 3, of: 6 });
  expect(h["broken-links"]).toMatchObject({ count: 1, of: 3 });
  const text = healthLines(brainHealth(root)).join("\n");
  expect(text).toContain("- Notes not linked to any other note: 50% (3 of 6). Fix: nothing by hand for names");
  expect(text).toContain("- Links to a note that doesn't exist: 33% (1 of 3). Fix:");
  for (const t of ["Course B", "Paul", "nobody-here", "Pick a bank"]) expect(text).not.toContain(t);
});

test("a fact's page says whether it changes, and when to check it again", () => {
  const root = makeBrain();
  const d = join(root, "decisions/2026-09-01-pick-bank.md");
  writeFileSync(d, readFileSync(d, "utf8").replace("---\nChose", 'facts:\n  outcome: { value: Keep the main bank, as_of: 2026-09-01, sources: ["gmail:f000000000000007"], verification: verified-by-source, by: steward, recorded: 2026-09-01 }\n---\nChose'));
  // A brain that declares a decision's outcome with no shelf life (the eval brain does).
  const c = join(root, "rules/checks.yaml");
  writeFileSync(c, readFileSync(c, "utf8").replace("  money:\n", "  decision:\n    attributes:\n      outcome: { merge: replace }\n  money:\n"));
  const s = loadState(root);
  const page = (id: string) => notePage(s, "x", loadBrain(root).find((n) => n.fm.id === id)!, "").body;
  // Jane's role: 180-day shelf life from 2026-09-01. Course A's next step: 14 days from 2026-10-01.
  expect(page("people/jane-roy")).toContain("check again in Feb 2027");
  expect(page("projects/course-a")).toContain("check again in Oct 2026");
  // A decision's outcome is declared with no shelf life.
  expect(page("decisions/2026-09-01-pick-bank")).toContain("doesn't go out of date");
});

test("a fact already past its shelf life says only that it may be out of date", () => {
  const root = makeBrain();
  const p = join(root, "projects/course-a.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("as_of: 2026-10-01, sources", "as_of: 2026-08-01, sources"));
  const html = notePage(loadState(root), "x", loadBrain(root).find((n) => n.fm.id === "projects/course-a")!, "").body;
  expect(html).toContain("may be out of date");
  expect(html).not.toContain("check again in");
});
