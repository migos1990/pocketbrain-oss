// SPDX-License-Identifier: AGPL-3.0-only
// Owner's phone, 2026-11-03, circling a Memory list of his projects: "all of them are related",
// "its like wiki". A page "Lakeside cabin: check-in" is part of "Lakeside cabin (rental host)", and a
// page whose own fact names the cabin's page is part of it too. Upkeep sets `parent:` on such a
// page (one reflect commit with the run's Undo), so Memory and the page tree put it under the
// cabin. A name that fits two pages, a page that already has a parent, or a parent that would loop
// is left alone (G640).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { upkeep, undoRun } from "../src/upkeep";

const project = (root: string, slug: string, title: string, extra = "") => writeFileSync(join(root, "projects", `${slug}.md`), `---\nid: projects/${slug}\ntype: project\ntitle: ${JSON.stringify(title)}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\n${extra}---\n`);
const links = (attr: string, to: string) => `facts:\n  ${attr}: { value: "[[${to}]]", as_of: 2026-10-28, sources: ["gmail:f000000000000051"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`;
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: pages"], { cwd: root }); };
// The owner turned it on (`pocketbrain wiki parents on`): off, upkeep only counts.
function brain(): string {
  const root = makeBrain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8") + "page_parents: true\n");
  return root;
}
const parentOf = (root: string, slug: string) => loadBrain(root).find((n) => n.fm.id === `projects/${slug}`)!.fm.parent;

test("G640 a page named 'X: …' or 'X, …' goes under the one page named X or 'X (…)', and Undo takes it back", () => {
  const root = brain();
  project(root, "lakeside-cabin", "Lakeside cabin (rental host)");
  project(root, "lakeside-cabin-check-in", "Lakeside cabin: check-in for the Moss family");
  project(root, "lakeside-cabin-2027", "Lakeside cabin, 2027 rebooking inquiry");
  project(root, "lakeside-cabins-tour", "Lakeside cabins tour");
  commit(root);
  const r = upkeep(root, { now: "2026-11-03" });
  expect(parentOf(root, "lakeside-cabin-check-in")).toBe("projects/lakeside-cabin");
  expect(parentOf(root, "lakeside-cabin-2027")).toBe("projects/lakeside-cabin");
  expect(parentOf(root, "lakeside-cabins-tour")).toBeUndefined();
  expect(parentOf(root, "lakeside-cabin")).toBeUndefined();
  // The finding names no page title or value: the commit says what changed.
  const f = r.findings.filter((x) => x.rule === "page-parent");
  expect(f).toHaveLength(2);
  for (const x of f) expect(x.detail).not.toMatch(/Lakeside|cabin/i);
  expect(undoRun(root, r.run)).not.toMatch(/conflict|no auto-fix/);
  expect(parentOf(root, "lakeside-cabin-check-in")).toBeUndefined();
  expect(parentOf(root, "lakeside-cabin-2027")).toBeUndefined();
  // Undo is for good: the next run doesn't put them back.
  upkeep(root, { now: "2026-11-04" });
  expect(parentOf(root, "lakeside-cabin-check-in")).toBeUndefined();
});

test("G640 a page whose own fact names exactly one other project goes under it", () => {
  const root = brain();
  project(root, "lakeside-cabin", "Lakeside cabin (rental host)");
  project(root, "house-rules", "House rules policy", links("property", "projects/lakeside-cabin"));
  project(root, "two-places", "Cleaning rota", `facts:\n  places: { value: "[[projects/lakeside-cabin]] and [[projects/house-rules]]", as_of: 2026-10-28, sources: ["gmail:f000000000000052"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`);
  commit(root);
  upkeep(root, { now: "2026-11-03" });
  expect(parentOf(root, "house-rules")).toBe("projects/lakeside-cabin");
  expect(parentOf(root, "two-places")).toBeUndefined(); // two pages: which one is a guess
});

test("G640 a name two pages share, a parent already set, or a loop: nothing changes", () => {
  const root = brain();
  project(root, "harbour-fair", "Harbour fair (2025)");
  project(root, "harbour-fair-2026", "Harbour fair (2026)");
  project(root, "harbour-fair-stalls", "Harbour fair: stalls");
  project(root, "garden", "Garden");
  project(root, "garden-beds", "Garden: raised beds", "parent: projects/harbour-fair\n");
  project(root, "pond", "Pond", links("part_of", "projects/pond-pump"));
  project(root, "pond-pump", "Pond pump", "parent: projects/pond\n");
  commit(root);
  const r = upkeep(root, { now: "2026-11-03" });
  expect(parentOf(root, "harbour-fair-stalls")).toBeUndefined();
  expect(parentOf(root, "garden-beds")).toBe("projects/harbour-fair");
  expect(parentOf(root, "pond")).toBeUndefined();
  expect(r.findings.filter((x) => x.rule === "page-parent")).toHaveLength(0);
  // A count under no page's id: a line on the page would tell an assistant that sees it that a
  // page with its name exists, maybe outside its view.
  const held = r.findings.filter((x) => x.rule === "parent-ambiguous");
  expect(held.map((x) => x.key)).toEqual(["parent-ambiguous"]);
  expect(held[0].detail).toMatch(/^1 project page/);
  expect(held[0].detail).not.toMatch(/Harbour/i);
});

// Audit v11, 2026-11-03: a parent drawn from a link some reader can't see would tell that reader
// the link (both pages in its view, the fact not). Only a fact every reader of the page sees sets
// a parent: none more private than the page, none shared with one person, none an assistant's
// rules hide.
test("G640 a link a reader of the page can't see sets no parent", () => {
  const root = brain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }", "helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money], exclude: [projects/rota#site] }"));
  const work = (slug: string, title: string, extra = "") => writeFileSync(join(root, "projects", `${slug}.md`), `---\nid: projects/${slug}\ntype: project\ntitle: ${JSON.stringify(title)}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\n${extra}---\n`);
  const rec = (attr: string, to: string, more = "") => `facts:\n  ${attr}: { value: "[[${to}]]", as_of: 2026-10-28, sources: ["gmail:f000000000000053"], verification: verified-by-source, by: steward, recorded: 2026-10-28${more} }\n`;
  work("office", "Office move");
  work("private-link", "Lease review", rec("building", "projects/office", ", sensitivity: private"));
  work("rota", "Desk rota", rec("site", "projects/office"));
  work("shared-link", "Parking plan", rec("site", "projects/office", ", share_with: [people/maya-chen]"));
  work("plain", "Moving boxes", rec("site", "projects/office"));
  // A parent outside the helper's view (a personal-area page) for a page it sees: never set.
  writeFileSync(join(root, "projects", "home-office.md"), `---\nid: projects/home-office\ntype: project\ntitle: Home office\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\n---\n`);
  work("home-office-desk", "Home office: desk order");
  commit(root);
  upkeep(root, { now: "2026-11-03" });
  expect(parentOf(root, "private-link")).toBeUndefined(); // the trial helper sees the page, not the private fact
  expect(parentOf(root, "rota")).toBeUndefined(); // the helper's rules hide the fact
  expect(parentOf(root, "shared-link")).toBeUndefined(); // shared with one person only
  expect(parentOf(root, "plain")).toBe("projects/office");
  expect(parentOf(root, "home-office-desk")).toBeUndefined();
});

test("G640 off until the owner turns it on: a count under no page's id, nothing set", () => {
  const root = makeBrain();
  project(root, "lakeside-cabin", "Lakeside cabin (rental host)");
  project(root, "lakeside-cabin-check-in", "Lakeside cabin: check-in");
  commit(root);
  const r = upkeep(root, { now: "2026-11-03" });
  expect(parentOf(root, "lakeside-cabin-check-in")).toBeUndefined();
  const would = r.findings.filter((x) => x.rule === "parent-would-set");
  expect(would.map((x) => x.key)).toEqual(["parent-would-set"]);
  expect(would[0].detail).toMatch(/^1 project page is part of another page; `pocketbrain wiki parents on`/);
  expect(r.findings.some((x) => x.rule === "page-parent")).toBe(false);
});

// Builder's slice audit F1: a page some reader can't see never counts, so whether a page gets a
// parent says nothing about what lies outside that reader's view.
test("G640 a same-name page a reader of the page can't see doesn't count", () => {
  const root = brain();
  const page = (slug: string, title: string, area: string) => writeFileSync(join(root, "projects", `${slug}.md`), `---\nid: projects/${slug}\ntype: project\ntitle: ${JSON.stringify(title)}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\n---\n`);
  page("office", "Office move", "work");
  page("office-home", "Office move (home)", "personal"); // outside the trial helper's work-only view
  page("office-boxes", "Office move: boxes", "work");
  commit(root);
  const r = upkeep(root, { now: "2026-11-03" });
  expect(parentOf(root, "office-boxes")).toBe("projects/office");
  expect(r.findings.some((x) => x.rule === "parent-ambiguous")).toBe(false);
});
