// SPDX-License-Identifier: AGPL-3.0-only
// The whole-wiki pages number beside the week's (scripts/north-star.ts wholeWiki, G1022): reported,
// never part of pass, of the pinned --json keys or of what pages_ok counts.
import { expect, test } from "bun:test";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import { git } from "../src/git";
import { measure, wholeWiki, wholeWikiLine, counts, report } from "../scripts/north-star";

test("the whole-wiki line counts every content page with a live fact, touched this week or not", () => {
  const root = makeBrain();
  const now = new Date("2026-10-08T12:00:00Z");
  // Nothing was touched in the window: the week's number has no pages, the whole wiki still does.
  const m = measure(root, "2030-01-01T00:00:00Z", now);
  expect(m.pages).toBe(0);
  const w = wholeWiki(root, now);
  expect(w.pages).toBeGreaterThan(5);
  expect(w.pages_ok).toBeLessThanOrEqual(w.pages);
  expect(w.stubs).toBeGreaterThan(0);
  expect(m.wiki).toEqual(w);
  // Reported only: pass and the pinned counts are as they were without it.
  expect(Object.keys(counts(m))).not.toContain("wiki");
  expect(m.pass).toBe(measure(root, "2030-01-01T00:00:00Z", now).pass);
  expect(report(m, "x")).toContain(wholeWikiLine(w));
  expect(wholeWikiLine(w)).toContain("(reported, not in pass)");
});

test("a page whose every fact has ended is left out and counted as left out; a long page is no stub", () => {
  const root = makeBrain();
  const now = new Date("2026-10-08T12:00:00Z");
  const before = wholeWiki(root, now);
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  n.body = `${Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ")}\n`;
  saveNote(root, n);
  const p = loadBrain(root).find((x) => x.fm.id === "people/paul-advisor")!;
  p.fm.history = { role: [{ ...(p.fm.facts!.role as object), valid_to: "2026-10-02" }] } as never;
  p.fm.facts = {};
  saveNote(root, p);
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: one long page, one emptied"], "louis");
  const after = wholeWiki(root, now);
  expect(after.pages).toBe(before.pages - 1);
  expect(after.left_out).toBe(before.left_out + 1);
  expect(after.stubs).toBeLessThan(before.stubs);
});
