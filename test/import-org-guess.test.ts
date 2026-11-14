// SPDX-License-Identifier: AGPL-3.0-only
// G843 (absorbs G653): the Notion import turned a person's free-text Org field into an org page and
// a "works at" link, and set the person's area by matching that free text against the import's area
// hints. On the owner's brain a page "A / B" glued two names into one organisation, filed in an area,
// with one person said to work there who never did. Free text is a guess (plans/wrong-grouping-family,
// rule 5): it never creates a page, a link or an area. The Org field is kept as the person's org in
// its own words, unlinked; a field naming two organisations is listed in the import report.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importNotion } from "../src/import/notion";
import { loadBrain } from "../src/brain";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function brainWith(org: string, importYaml = "areas: {}\n"): string {
  const root = mkdtempSync(join(tmpdir(), "pb-import-org-"));
  roots.push(root);
  mkdirSync(join(root, "import/raw/people/bodies"), { recursive: true });
  writeFileSync(join(root, "import/raw/people/rows.json"), JSON.stringify([{
    Name: "Theo Marsh", Role: "Former colleague", Org: org, "Source type": "an assistant's memory",
    Source: "Instinct memory note entities/people/theo", Verification: "Unverified", Confidence: "Stated",
    Sensitive: "__NO__", "Author agent": "Instinct", Fingerprint: "Instinct \\| created \\| 2026-10-04",
    "date:Date:start": "2026-10-04", url: "https://app.notion.com/p/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1",
  }]));
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "rules/import.yaml"), importYaml);
  return root;
}

const theo = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/theo-marsh")!;
const orgValue = (root: string) => (theo(root).fm.facts?.org as { value?: unknown } | undefined)?.value;

test("an Org field makes no org page and no link: the person's org is its own words", () => {
  const root = brainWith("Acme Labs");
  importNotion(root);
  expect(loadBrain(root).filter((n) => n.fm.type === "org")).toHaveLength(0);
  expect(orgValue(root)).toBe("Acme Labs");
});

test("an Org field naming two organisations is kept as written and listed in the report", () => {
  const root = brainWith("Acme Labs / Birch Health");
  const r = importNotion(root);
  expect(loadBrain(root).filter((n) => n.fm.type === "org")).toHaveLength(0);
  expect(orgValue(root)).toBe("Acme Labs / Birch Health");
  const report = readFileSync(r.report, "utf8");
  expect(report).toContain("Two organizations in one Org field");
  expect(report).toContain("Acme Labs / Birch Health");
});

test("the Org and Role words never pick the person's area", () => {
  const root = brainWith("Acme Labs", "areas: {}\narea_hints:\n  work: [\"Acme\", \"colleague\"]\n");
  importNotion(root);
  expect(theo(root).fm.area).toBe("personal");
});
