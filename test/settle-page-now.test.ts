// SPDX-License-Identifier: AGPL-3.0-only
// Filming on the demo brain, 2026-11-07: after a pick on the settle screen, an assistant read the
// new next step as current while the page's own text still said the old one, "A different value is
// waiting to be checked.", until the night writer ran. A pick on the settle screen (and keep both)
// writes the page's text at once, as a word in the box already does (G707).
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { ownerDecide, ownerKeepBoth, readNote, ownerConflicts } from "../src/core";

const text = (root: string) => (readNote(root, "claude", "projects/atlas-launch") as { body: string }).body;

test("G707 a pick on the settle screen rewrites the page's text at once", async () => {
  const { root } = await makeDemoBrain();
  const c = ownerConflicts(root).find((x) => x.id === "c-0001")!;
  expect(c.fact_key).toBe("projects/atlas-launch#next_step");
  expect(text(root)).toContain("A different value is waiting to be checked.");
  const side = c.sides.find((s) => /22/.test(String(s.value)))!;
  ownerDecide(root, "c-0001", side.n);
  const after = text(root);
  expect(after).not.toContain("A different value is waiting to be checked.");
  expect(after).not.toContain("15 October");
  expect(after).toMatch(/22 Oct/);
}, 60_000);

test("G707 keep both rewrites it at once too", async () => {
  const { root } = await makeDemoBrain();
  ownerKeepBoth(root, "c-0001");
  expect(text(root)).not.toContain("A different value is waiting to be checked.");
}, 60_000);
