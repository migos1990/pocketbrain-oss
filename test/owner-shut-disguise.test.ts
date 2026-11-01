// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10 (2026-11-01, G614): on the 30-day sign-in a page's prose hid a private value only when it
// was spelled exactly (scrubExact), so "MapleTrust Bank", "Maple Trust Bank", a spaced-out spelling
// or look-alike letters still showed on /p and in Ask. The owner's screens now use the same disguise
// matcher as an assistant's view (match.ts findCarried): a line that carries the value is withheld.
import { test, expect } from "bun:test";
import type { Note } from "../src/brain";
import { shutBody } from "../src/dashboard/home";

const note = (body: string): Note => ({
  path: "people/jane-roy.md",
  body,
  fm: {
    id: "people/jane-roy", type: "person", title: "Jane Roy", area: "personal", sensitivity: "personal", status: "active",
    created: "2026-10-01", updated: "2026-10-01", by: "owner",
    facts: { bank: { value: "Maple-Trust Bank", as_of: "2026-10-01", sources: ["owner:2026-10-01/dashboard"], verification: "confirmed-by-owner", by: "owner", recorded: "2026-10-01", sensitivity: "private" } },
  },
} as unknown as Note);

const SPELLINGS = ["Maple-Trust Bank", "MapleTrust Bank", "Maple Trust Bank", "maple trust bank", "M a p l e - T r u s t B a n k", "Mаple-Trust Bаnk"];

for (const s of SPELLINGS) test(`a private value spelled "${s}" never shows on the 30-day sign-in (G614)`, () => {
  const out = shutBody(note(`Jane banks at ${s} since the move.\n\nShe likes long walks.`), "(private)");
  expect(out.toLowerCase().replace(/[^a-z]/g, "")).not.toContain("mapletrust");
  expect(out).toContain("(private)");
  // Only the line that carries it goes: the rest of the page stays readable.
  expect(out).toContain("She likes long walks.");
});

test("a page with nothing private keeps its text as it is", () => {
  const n = note("Jane likes Maple Trust Bank's old building.");
  (n.fm.facts!.bank as { sensitivity?: string }).sensitivity = "personal";
  expect(shutBody(n)).toBe("Jane likes Maple Trust Bank's old building.");
});
