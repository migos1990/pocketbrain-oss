// SPDX-License-Identifier: AGPL-3.0-only
// Found while building G685-G687: once a project page said where its people work, asking for it by
// its title ("Pinecrest pilot") returned a decision titled "Three-month Pinecrest pilot" first; a
// longer page scored lower on the same words. A note whose title is the question comes first (G693).
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { search } from "../src/core";

const fact = (value: string) => `{ value: "${value}", as_of: 2026-10-05, sources: ["gmail:f0000000000000a1"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;

test("G693 the note titled as the question comes first, ahead of a shorter one that names it", () => {
  const root = makeBrain();
  const filler = Array.from({ length: 40 }, (_, i) => `Week ${i + 1} went to the reading list, the room and the marking scheme.`).join(" ");
  writeFileSync(join(root, "projects", "harbour-walk.md"), `---\nid: projects/harbour-walk\ntype: project\ntitle: Harbour walk\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  status: ${fact("planning")}\n---\n${filler}\n`);
  writeFileSync(join(root, "projects", "harbour-walk-length.md"), `---\nid: projects/harbour-walk-length\ntype: project\ntitle: Two-day harbour walk\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nThe harbour walk is two days, a harbour walk decided.\n`);
  const hits = search(root, "steward", "Harbour walk").map((h) => h.id);
  expect(hits.slice(0, 2)).toContain("projects/harbour-walk-length"); // still found
  expect(hits[0]).toBe("projects/harbour-walk");
  // Case, accents and spaces don't matter.
  expect(search(root, "steward", "  harbour   WALK ")[0]?.id).toBe("projects/harbour-walk");
});
