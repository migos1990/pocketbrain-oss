// SPDX-License-Identifier: AGPL-3.0-only
// After the deck and tabs went (2026-10-27), /note/<id> is only the owner's edit page, reached from
// "Edit this page" on /p. Every other owner page opens a page at /p.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage, PAGE_COPY } from "../src/dashboard/html-page";
import { brainResults } from "../src/dashboard/html-brain";

test("a page links to its edit page once, by name", () => {
  const root = makeBrain();
  const s = loadState(root, new Date());
  const n = s.notes.find((x) => x.fm.id === "people/jane-roy")!;
  const html = ownerPage(s, "t", n, []);
  expect(html).toContain(`<a href="/note/people/jane-roy">${PAGE_COPY.edit}</a>`);
  expect(html.match(/href="\/note\//g)).toHaveLength(1);
});

test("the brain list opens pages at /p; only Change opens the edit page", () => {
  const root = makeBrain();
  const s = loadState(root, new Date());
  const html = brainResults(s, "t", "Jane");
  expect(html).toContain('href="/p/people/jane-roy"');
  expect([...html.matchAll(/href="\/note\/[^"]*"/g)].map((m) => m[0]).filter((h) => !h.includes("?edit="))).toEqual([]);
});

test("no other owner page links to /note", () => {
  const dir = join(import.meta.dir, "..", "src", "dashboard");
  for (const f of ["people.ts", "html-map.ts", "html.ts", "html-consent.ts"])
    expect(`${f}: ${readFileSync(join(dir, f), "utf8").match(/href="\/note\/|`\/note\/\$\{/g)?.length ?? 0}`).toBe(`${f}: 0`);
});
