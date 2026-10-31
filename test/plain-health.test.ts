// SPDX-License-Identifier: AGPL-3.0-only
// Mac use-it pass on the owner's phone, 2026-10-25: the Brain page's "Assistants 41" read as 41
// assistants (it is the folder of their notes), and the home's checks line said "gardener's
// Anthropic side, token minted". Plain words for both.
import { test, expect } from "bun:test";
import { kindLabel } from "../src/dashboard/browse";
import { plain } from "../src/dashboard/labels";

test("the assistants' folder says it holds their notes", () => {
  expect(kindLabel("agents")).toBe("Assistants' notes");
});

test("the hub's own checks are named by what happened, in plain words", () => {
  for (const c of ["gardener_ant", "token_minted", "source_item_failed", "job_timeout"]) {
    expect(plain(c)).not.toMatch(/anthropic|minted|_|\bant\b|job timeout|source item failed/i);
  }
});

// Mac use-it pass, 2026-10-25: one project showed twice in Needs a look ("conflicting next steps");
// it was two of its facts, each row under the same title. A page's facts sit together, its title once.
test("Needs a look names a page once, its facts together under it", async () => {
  const { makeBrain } = await import("./fixture");
  const { loadState } = await import("../src/dashboard/data");
  const { brainResults } = await import("../src/dashboard/html-brain");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = makeBrain();
  const ck = join(root, "rules", "checks.yaml");
  writeFileSync(ck, readFileSync(ck, "utf8").replace("      next_step: { merge: replace, shelf_life: 14d }", "      next_step: { merge: replace, shelf_life: 14d }\n      status: { merge: replace, shelf_life: 14d }"));
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("as_of: 2026-10-01", "as_of: 2026-06-01").replace("recorded: 2026-10-01 }\n", "recorded: 2026-10-01 }\n  status: { value: On hold, as_of: 2026-06-02, sources: [\"gmail:f000000000000004\"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }\n"));
  const html = brainResults(loadState(root), "x");
  const look = html.slice(html.indexOf("Needs a look"));
  expect((look.match(/>Course A</g) ?? []).length).toBe(1);
  expect(look).toContain("Next step");
  expect(look).toContain("Status");
});
