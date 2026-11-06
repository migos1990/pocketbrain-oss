// SPDX-License-Identifier: AGPL-3.0-only
// Demo-moment thread, 2026-10-29: after the owner's box wrote Jane Roy's next step, context_pack
// showed "#### Earlier notes" twice: over the old text, and again over the page's references.
// The references a page ends with belong to no section.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { contextPack } from "../src/core";
import { chunkNote } from "../src/retrieve";

test("a section's heading is never repeated over the page's references", () => {
  const { body } = chunkNote(["head", "Lead.[^p-a]\n\n## Earlier notes\nOld text.\n\n[^p-a]: Email, 2026-09-01 (gmail:f000000000000001)"], true);
  expect(body.filter((c) => c.startsWith("## Earlier notes"))).toHaveLength(1);
  expect(body.at(-1)).toBe("[^p-a]: Email, 2026-09-01 (gmail:f000000000000001)");
});

test("context_pack shows the hub's block once after the box writes a fact", () => {
  process.env.PB_NOW = "2026-10-08T14:00:00Z";
  const root = makeBrain();
  expect(ownerSay(root, "Jane Roy's next step is send the syllabus by Friday").kind).toBe("say.noted");
  const md = contextPack(root, "planner", "what's next with Jane");
  const at = md.indexOf("### Jane Roy"), end = md.indexOf("\n### ", at + 4);
  const jane = md.slice(at, end < 0 ? undefined : end);
  // Her page's own text stays on top and the hub's block sits beneath it once (G682).
  expect(jane.match(/#### From its facts/g) ?? []).toHaveLength(1);
  expect(jane).not.toContain("#### Earlier notes");
  delete process.env.PB_NOW;
});
