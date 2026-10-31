// SPDX-License-Identifier: AGPL-3.0-only
// The memories on the home read as sentences in the owner's words (owner app brief 2026-10-30:
// "homeView lines reworded as sentences"), on the demo brain: "Antoine Lavoie is head TA now",
// "Next for Kitchen renovation: …", never "Page: attribute is now value". The words are one
// catalog (LINE_COPY in src/dashboard/home.ts), checked by test/owner-copy.test.ts.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { homeView, LINE_COPY, lineWords } from "../src/dashboard/home";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";

test("every memory on the home is a sentence, never a page name, a colon and an attribute", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    const notes = loadBrain(root);
    const v = homeView(root, loadRules(root), notes, new Date(DEMO_NOW), { all: true });
    const lines = [...v.since, ...v.earlier.flatMap((d) => d.lines)].map((l) => l.what);
    const waiting = v.waiting.map((w) => w.what);
    expect(lines.length).toBeGreaterThan(10);
    const titles = notes.map((n) => String(n.fm.title));
    for (const s of [...lines, ...waiting]) {
      expect(titles.filter((t) => s.startsWith(`${t}: `))).toEqual([]);
      expect(s).toMatch(/^[A-Z0-9“"]/u);
    }
    expect(lines).toContain("Antoine Lavoie is head TA now");
    expect(lines).toContain("Next for Kitchen renovation: take the tile delivery on 12 October");
    expect(lines).toContain("You were last in touch with Martin Leclerc on 8 Oct 2026");
    expect(lines).toContain("Diego Alvarez prefers long novels nobody else has read");
    expect(waiting).toContain("Two sources disagree on what's next for Atlas launch");
    expect(waiting).toContain("Two sources disagree on Grace Liu's role");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a name ending in s takes its apostrophe alone, and every line comes from the catalog", () => {
  expect(lineWords("changed", { title: "Thomas", attr: "city", value: "Laval" })).toBe("Thomas' city is now Laval");
  expect(lineWords("changed", { title: "Jane Roy", attr: "city", value: "Laval" })).toBe("Jane Roy's city is now Laval");
  for (const s of Object.values(LINE_COPY)) expect(s).not.toMatch(/^\{title\}: /);
});
