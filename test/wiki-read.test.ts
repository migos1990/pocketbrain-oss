// SPDX-License-Identifier: AGPL-3.0-only
// Wiki slice 6 (docs/wiki.md): agents read a page's summary and can read one section. The summary
// is text like the body (scrubbed of carved values, only with the body grant); a parent hidden
// from the reader answers like no parent, and never reaches its cell.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { readNote } from "../src/core";
import { buildCell, cellDir } from "../src/cell";

const JANE = "people/jane-roy";
const page = (root: string, fm: string, body = "") => {
  const f = join(root, `${JANE}.md`);
  writeFileSync(f, readFileSync(f, "utf8").replace("aliases: [Jane]", `aliases: [Jane]\n${fm}`).replace(/\n?$/, body));
};

test("an agent reads the page's summary, in the note and in its Markdown", () => {
  const root = makeBrain();
  page(root, "summary: Coordinates Course A.");
  const r = readNote(root, "planner", JANE);
  expect(r.summary).toBe("Coordinates Course A.");
  expect(r.markdown).toContain("Coordinates Course A.");
});

test("a summary carrying a value hidden from the reader is withheld, like the body", () => {
  const root = makeBrain();
  page(root, "summary: Banks with Maple Trust Bank.");
  expect(readNote(root, "planner", JANE).summary).not.toContain("Maple Trust");
  expect(readNote(root, "planner", JANE).markdown).not.toContain("Maple Trust");
  expect(readNote(root, "steward", JANE).summary).toContain("Maple Trust");
});

test("a parent the reader can't see answers like no parent, and its id never reaches the cell", () => {
  const root = makeBrain();
  page(root, "parent: money/main-bank");
  expect(readNote(root, "planner", JANE).parent).toBeUndefined();
  expect(readNote(root, "steward", JANE).parent).toBe("money/main-bank");
  buildCell(root, "planner");
  const dir = cellDir(root, "planner");
  const all = readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  expect(all).not.toContain("money/main-bank");
  expect(all).toContain("Jane Roy");
});

test("read one section: its text and the references it cites; an unknown section is a 404", () => {
  const root = makeBrain();
  page(root, "summary: S.", "\n\n## Who they are\nA coordinator.[^1]\n\n## Open threads\nThe syllabus.[^2]\n\n[^1]: Email, Sep 1 (gmail:f000000000000001)\n[^2]: Email, Oct 2\n");
  const r = readNote(root, "planner", JANE, "Who they are");
  expect(r.section).toBe("Who they are");
  expect(r.body).toBe("## Who they are\nA coordinator.[^1]\n\n[^1]: Email, Sep 1 (gmail:f000000000000001)");
  expect(r.markdown).toContain("A coordinator.");
  expect(r.markdown).not.toContain("The syllabus.");
  expect(() => readNote(root, "planner", JANE, "Nope")).toThrow("no section Nope in people/jane-roy");
  // A note outside the view still answers like a missing one, section or not.
  expect(() => readNote(root, "planner", "money/main-bank", "Who they are")).toThrow("no note money/main-bank in your view");
});
