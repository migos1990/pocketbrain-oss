// SPDX-License-Identifier: AGPL-3.0-only
// A kind's list in logical sections (owner's phone, 2026-11-03: "all of them are related", "there
// should be logical section under project"; G638). A project and its sub-pages read as one block:
// pages sit under their area's heading, a page named "X: …" sits under "X (…)", and a page whose
// `parent:` is on the list sits under that page. Display only; every page still opens on its own.
import { test, expect } from "bun:test";
import { memoryPage, foldRows, type MemoryPage, type MemoryView } from "../src/dashboard/html-app";

const view = (pages: MemoryPage[]): MemoryView => ({ pages: pages.length, people: 0, name: "Sam", kinds: [], week: [], kind: { label: "Projects", pages, folder: "projects" } });
const rowsOf = (html: string) => [...html.matchAll(/<b>([^<]*)<\/b>/g)].map((m) => m[1]!.replace(/&#39;/g, "'").replace(/&amp;/g, "&"));

const CABIN: MemoryPage[] = [
  { id: "projects/house-rules", title: "Rental house rules", area: "cabin" },
  { id: "projects/cabin", title: "Lakeside cabin (rental host)", area: "cabin" },
  { id: "projects/cabin-rebook", title: "Lakeside cabin: 2027 rebooking inquiry", area: "cabin" },
  { id: "projects/cabin-checkin", title: "Lakeside cabin: guest check-in (Oct 12)", area: "cabin" },
  { id: "projects/garden", title: "Garden planning", area: "personal" },
  { id: "projects/survey", title: "Survey contest", area: "personal" },
  { id: "projects/roadmap", title: "Q1 roadmap", area: "work" },
];

test("a page named 'X: …' sits under 'X (…)', said by what follows the name", () => {
  const rows = foldRows(CABIN.filter((p) => p.area === "cabin"));
  const cabin = rows.find((r) => r.page?.id === "projects/cabin")!;
  expect(cabin.sub.map((s) => s.rest)).toEqual(["2027 rebooking inquiry", "guest check-in (Oct 12)"]);
  expect(rows.map((r) => r.title)).toEqual(["Rental house rules", "Lakeside cabin (rental host)"]);
});

test("a page whose parent is on the list sits under it, whatever its name", () => {
  const ps: MemoryPage[] = [
    { id: "projects/cabin", title: "Lakeside cabin (rental host)", area: "cabin" },
    { id: "projects/house-rules", title: "Rental house rules", area: "cabin", parent: "projects/cabin" },
    { id: "projects/elsewhere", title: "Roof repair", area: "cabin", parent: "projects/not-on-the-list" },
  ];
  const rows = foldRows(ps);
  expect(rows.find((r) => r.page?.id === "projects/cabin")!.sub.map((s) => s.page.id)).toEqual(["projects/house-rules"]);
  expect(rows.map((r) => r.title)).toEqual(["Lakeside cabin (rental host)", "Roof repair"]);
});

test("Projects come in sections, one per area, biggest first, each headed by its area and dot", () => {
  const html = memoryPage(view(CABIN));
  const heads = [...html.matchAll(/<h3 class="section">([\s\S]*?)<\/h3>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
  expect(heads).toEqual(["Cabin", "Personal", "Work"]);
  // Every page is still listed once, under its area.
  const rows = rowsOf(html);
  for (const p of CABIN) expect(rows.some((r) => p.title.endsWith(r))).toBe(true);
  const cabinPart = html.slice(html.indexOf(">Cabin<"), html.indexOf(">Personal<"));
  expect(cabinPart).toContain("Rental house rules");
  expect(cabinPart).toContain("2027 rebooking inquiry");
  // The headings name the areas, so no separate key.
  expect(html).not.toContain('<p class="key">');
});

test("one area only: no section heading, the list reads as before", () => {
  const html = memoryPage(view(CABIN.filter((p) => p.area === "cabin")));
  expect(html).not.toContain('class="section"');
});
