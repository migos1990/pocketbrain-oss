// SPDX-License-Identifier: AGPL-3.0-only
// The owner's page on the demo brain (outside review 2026-10-29, item 2): a page with the hub's
// lead, "Earlier notes" and references put its sections as <h3> right under the page's <h1>, a
// heading jump the UI audit fails. The 7-note sample never had a section, so nobody saw it.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";
import { DEMO_NOW } from "../scripts/demo-brain";

test("the owner's page puts its text's sections one level under its title, never a jump from h1 to h3", async () => {
  const { root } = await makeDemoBrain();
  const s = loadState(root, new Date(DEMO_NOW));
  const n = s.notes.find((x) => x.fm.id === "projects/atlas-launch")!;
  expect(n.body).toContain("## Earlier notes");
  const html = ownerPage(s, "", n, []);
  const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
  expect(levels[0]).toBe(1);
  levels.forEach((l, i) => { if (i) expect(l - levels[i - 1]!).toBeLessThanOrEqual(1); });
  expect(html).toContain("<h2>Earlier notes</h2>");
  expect(html).toContain("<h2>References</h2>");
}, 60_000);
