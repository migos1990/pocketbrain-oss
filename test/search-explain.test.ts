// SPDX-License-Identifier: AGPL-3.0-only
// Search hits explain themselves (backlog 303): each hit says which of the agent's words it
// matched, which related words (synonyms, the French-English map) carried it, and how strong the
// match is, so a weak match isn't stated as a fact. The same line heads each topic-pack note.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { search, contextPack } from "../src/core";

test("every word of the query found is a strong hit, naming the words", () => {
  const root = makeBrain();
  const hit = search(root, "steward", "Jane coordinator").find((h) => h.id === "people/jane-roy")!;
  expect(hit.strength).toBe("strong");
  expect(hit.matched).toEqual(["jane", "coordinator"]);
  expect(hit.via).toEqual([]);
});

test("some of the words is partial; only related words is weak, naming what carried it", () => {
  const root = makeBrain();
  const partial = search(root, "steward", "Jane plumber").find((h) => h.id === "people/jane-roy")!;
  expect(partial.strength).toBe("partial");
  expect(partial.matched).toEqual(["jane"]);
  const weak = search(root, "steward", "examen").find((h) => h.id === "projects/course-a")!;
  expect(weak.strength).toBe("weak");
  expect(weak.matched).toEqual([]);
  expect(weak.via).toContain("midterm");
});

test("a topic pack heads each note with what it matched and how strongly", () => {
  const root = makeBrain();
  const out = contextPack(root, "steward", "examen");
  expect(out).toMatch(/Matched only related words: midterm \(weak: check it is what was asked before relying on it\)/);
  const strong = contextPack(root, "steward", "Jane coordinator");
  expect(strong).toMatch(/Matched: jane, coordinator \(strong\)/);
});

// A query word that matches only by its stem is named by the stem the note holds, never by the
// agent's own spelling: a carved value typed as a query (Northfield, when only "north" is shown)
// must not come back in the answer (red team rt-search-side-channel).
test("a word matched only by its stem is shown as that stem, not as the query word", () => {
  const root = makeBrain();
  const hit = search(root, "steward", "Jane coordinators").find((h) => h.id === "people/jane-roy")!;
  expect(hit.matched).toContain("jane");
  expect(hit.matched).not.toContain("coordinators");
  expect(hit.matched.some((w) => w.endsWith("*") && "coordinator".startsWith(w.slice(0, -1)))).toBe(true);
});
