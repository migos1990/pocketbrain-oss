// SPDX-License-Identifier: AGPL-3.0-only
// A kind's list in logical sections (owner's phone, 2026-11-03: "all of them are related", "there
// should be logical section under project"; G638). A project and its sub-pages read as one block:
// pages sit under their area's heading, a page named "X: …" sits under "X (…)", and a page whose
// `parent:` is on the list sits under that page. Display only; every page still opens on its own.
import { test, expect } from "bun:test";
import { memoryPage, foldRows, type MemoryPage, type MemoryView } from "../src/dashboard/html-app";

const view = (pages: MemoryPage[]): MemoryView => ({ pages: pages.length, people: 0, name: "Sam", kinds: [], week: [], kind: { label: "Projects", pages, folder: "projects" } });
const rowsOf = (html: string) => [...html.matchAll(/<b>([^<]*)<\/b>/g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

const PLOTS: MemoryPage[] = [
  { id: "projects/house-rules", title: "Allotment plot rules", area: "allotment" },
  { id: "projects/allotment", title: "Riverside allotment (plot keeper)", area: "allotment" },
  { id: "projects/allotment-wait", title: "Riverside allotment: 2029 waiting list", area: "allotment" },
  { id: "projects/allotment-key", title: "Riverside allotment: shed key handover (Mar 3)", area: "allotment" },
  { id: "projects/garden", title: "Book club planning", area: "personal" },
  { id: "projects/survey", title: "Survey contest", area: "personal" },
  { id: "projects/roadmap", title: "Q1 roadmap", area: "work" },
];

test("a page named 'X: …' sits under 'X (…)', said by what follows the name", () => {
  const rows = foldRows(PLOTS.filter((p) => p.area === "allotment"));
  const plot = rows.find((r) => r.page?.id === "projects/allotment")!;
  expect(plot.sub.map((s) => s.rest)).toEqual(["2029 waiting list", "shed key handover (Mar 3)"]);
  expect(rows.map((r) => r.title)).toEqual(["Allotment plot rules", "Riverside allotment (plot keeper)"]);
});

test("a page whose parent is on the list sits under it, whatever its name", () => {
  const ps: MemoryPage[] = [
    { id: "projects/allotment", title: "Riverside allotment (plot keeper)", area: "allotment" },
    { id: "projects/house-rules", title: "Allotment plot rules", area: "allotment", parent: "projects/allotment" },
    { id: "projects/elsewhere", title: "Roof repair", area: "allotment", parent: "projects/not-on-the-list" },
  ];
  const rows = foldRows(ps);
  expect(rows.find((r) => r.page?.id === "projects/allotment")!.sub.map((s) => s.page.id)).toEqual(["projects/house-rules"]);
  expect(rows.map((r) => r.title)).toEqual(["Riverside allotment (plot keeper)", "Roof repair"]);
});

test("Projects come in sections, one per area, biggest first, each headed by its area and dot", () => {
  const html = memoryPage(view(PLOTS));
  const heads = [...html.matchAll(/<h3 class="section">([\s\S]*?)<\/h3>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
  expect(heads).toEqual(["Allotment", "Personal", "Work"]);
  // Every page is still listed once, under its area.
  const rows = rowsOf(html);
  for (const p of PLOTS) expect(rows.some((r) => p.title.endsWith(r))).toBe(true);
  const plotPart = html.slice(html.indexOf(">Allotment<"), html.indexOf(">Personal<"));
  expect(plotPart).toContain("Allotment plot rules");
  expect(plotPart).toContain("2029 waiting list");
  // The headings name the areas, so no separate key.
  expect(html).not.toContain('<p class="key">');
});

test("one area only: no section heading, the list reads as before", () => {
  const html = memoryPage(view(PLOTS.filter((p) => p.area === "allotment")));
  expect(html).not.toContain('class="section"');
});
