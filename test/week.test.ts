// SPDX-License-Identifier: AGPL-3.0-only
// The week, built by code across pages (plans/next-level.md F1): on the owner's own page, Right now
// reads the coming seven days by day (due dates, dated next steps, birthdays, the calendar), what
// went past its due date, what comes later and the next steps with no date, every page a link
// (G688). An assistant asking context_pack about its week gets one dated block from the notes and
// facts its own carve shows, each line naming its note and source, and nothing it can't see (G689).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage, PAGE_COPY } from "../src/dashboard/html-page";
import { contextPack } from "../src/core";
import { saveUpcoming } from "../src/upcoming";
import { gitRun } from "../src/git";

const OWNER = "people/robin-lefebvre";
const DAY = "2026-11-04";
const section = (html: string, head: string) => {
  const i = html.indexOf(`>${head}</h2>`);
  if (i < 0) return "";
  const j = html.indexOf('<h2 class="sec"', i + 1);
  return html.slice(i, j < 0 ? undefined : j);
};
const page = (root: string, fresh = false) => { const s = loadState(root); return ownerPage(s, "t", s.notes.find((n) => n.fm.id === OWNER)!, [], { fresh }); };

let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = { PB_NOW: process.env.PB_NOW, PB_TODAY: process.env.PB_TODAY }; });
afterEach(() => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
const at = (day: string) => { process.env.PB_NOW = `${day}T14:00:00Z`; process.env.PB_TODAY = day; };

async function brain() {
  const { root } = await makeDemoBrain();
  at(DAY);
  saveUpcoming(root, "gcal-work", [
    { id: "e1", version: "1", summary: "Pricing page refresh review", location: "Room 4", start: "2026-11-06T10:00:00-05:00", source: "gcal-work" },
    { id: "e2", version: "1", summary: "Dentist", start: "2026-11-09", source: "gcal-work" },
  ], DAY);
  return root;
}

test("Right now on the owner's own page is the week, by day, every page a link (G688)", async () => {
  const root = await brain();
  const now = section(page(root), PAGE_COPY.bookNow);
  // Past due, on a project still going.
  expect(now).toContain(PAGE_COPY.weekPast);
  expect(now).toMatch(/<a href="\/p\/projects\/atlas-launch">[^<]+<\/a> was due 3 Nov/);
  // Tomorrow: a birthday, the person's page a link.
  expect(now).toContain(`>${PAGE_COPY.weekTomorrow}<`);
  expect(now).toMatch(/<a href="\/p\/people\/marc-lefebvre">[^<]+<\/a>&#39;s birthday|<a href="\/p\/people\/marc-lefebvre">[^<]+<\/a>'s birthday/);
  // A calendar event, its time, the page its title names a link.
  expect(now).toMatch(/10:00 <a href="\/p\/projects\/pricing-page-refresh">Pricing page refresh<\/a> review, Room 4/);
  // An event that names no page is still the owner's week.
  expect(now).toContain("Dentist");
  // A due date later in the week, under its weekday.
  expect(now).toContain("Tuesday 10 Nov");
  expect(now).toMatch(/<a href="\/p\/projects\/pricing-page-refresh">[^<]+<\/a> is due/);
  // Later this month.
  expect(now).toContain(PAGE_COPY.weekLater);
  expect(now).toContain('href="/p/projects/q1-roadmap"');
  // The days come in order.
  expect(now.indexOf(PAGE_COPY.weekTomorrow)).toBeLessThan(now.indexOf("Tuesday 10 Nov"));
  expect(now.indexOf("Tuesday 10 Nov")).toBeLessThan(now.indexOf(PAGE_COPY.weekLater));
  // The projects still going stay linked.
  expect(now).toContain('href="/p/projects/atlas-launch"');
}, 60_000);

test("a private project's due date or a private event shows on the week only right after a sign-in (G688)", async () => {
  const root = await brain();
  const f = join(root, "projects/pricing-page-refresh.md");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^sensitivity: \w+$/m, "sensitivity: private"));
  gitRun(root, ["add", "-A"]); gitRun(root, ["commit", "-qm", "owner: private"]);
  saveUpcoming(root, "gcal-work", [{ id: "e3", version: "1", summary: "Therapy session", start: "2026-11-06T09:00:00-05:00", source: "gcal-work", sensitivity: "private" }], DAY);
  const shut = section(page(root), PAGE_COPY.bookNow);
  expect(shut).not.toContain("pricing-page-refresh");
  expect(shut).not.toContain("Therapy");
  const open = section(page(root, true), PAGE_COPY.bookNow);
  expect(open).toContain('href="/p/projects/pricing-page-refresh"');
  expect(open).toContain("Therapy session");
}, 60_000);

test("context_pack about the week has one dated block, each line its note and source, from the agent's own carve (G689)", async () => {
  const root = await brain();
  const pack = contextPack(root, "claude", "what's next this week");
  expect(pack).toContain(`## Your week, ${DAY} to 2026-11-10`);
  expect(pack).toMatch(/- 2026-11-05 Thu: Marc Lefebvre \(people\/marc-lefebvre\): birthday \(/);
  expect(pack).toMatch(/- 2026-11-10 Tue: [^(]+\(projects\/pricing-page-refresh\): due \(/);
  expect(pack).toMatch(/Past due:[^\n]*\n- 2026-11-03 Tue: [^(]+\(projects\/atlas-launch\): due \(/);
  // The calendar's raw events are the owner's: an event no note the agent sees names isn't served.
  expect(pack).not.toContain("Dentist");
  // Gemini's carve holds work and basic contacts only: no family birthday, no personal project.
  const gem = contextPack(root, "gemini", "what's next this week");
  expect(gem).toContain("## Your week");
  expect(gem).toContain("projects/pricing-page-refresh");
  expect(gem).not.toContain("marc-lefebvre");
  expect(gem).not.toContain("Marc Lefebvre");
  expect(gem).not.toContain("kitchen-renovation");
  // A topic about something else carries no week block.
  expect(contextPack(root, "claude", "Pinecrest pilot success numbers")).not.toContain("## Your week");
  // The whole view stays the notes alone: it is the pasted file's exact view (docs/hub.md).
  expect(contextPack(root, "claude")).not.toContain("## Your week");
}, 60_000);

test("a next step that names its day goes on that day; one whose day went by leaves the week (G688)", async () => {
  const { root } = await makeDemoBrain();
  at("2026-10-08");
  const now = section(page(root), PAGE_COPY.bookNow);
  const tue = now.indexOf("Tuesday 13 Oct");
  expect(tue).toBeGreaterThan(-1);
  expect(now.slice(tue)).toMatch(/^Tuesday 13 Oct<\/h3><ul class="book"><li><span><a href="\/p\/projects\/product-discovery-course">[^<]+<\/a>: return the midterm reflections on 13 October/);
  // Past the seven days, under Coming up with its day.
  expect(now).toMatch(/<a href="\/p\/projects\/atlas-launch">Atlas launch<\/a>: freeze the beta build on 15 October<\/span>/);
  expect(now).toContain("Monday 12 Oct");
  // A project a line above names isn't listed again under Also going.
  const going = now.slice(now.indexOf(PAGE_COPY.weekGoing));
  if (going.length && now.includes(PAGE_COPY.weekGoing)) expect(going).not.toContain("atlas-launch");
  at(DAY);
  const later = section(page(root), PAGE_COPY.bookNow);
  expect(later).not.toContain("by 9 October");
  expect(later).not.toContain("on 12 October");
  expect(contextPack(root, "claude", "what's due this week")).not.toContain("on 12 October (");
}, 60_000);

test("an event a page's next step already serves is listed once, a comma in its title or not (G688)", async () => {
  const { weekOf } = await import("../src/week");
  const { loadRules } = await import("../src/rules");
  const { root } = await makeDemoBrain();
  const rec = { value: "Lunch, Sarah, 2026-11-05 12:00 (from the calendar)", as_of: DAY, sources: ["gcal:e9@1"], by: "calendar" };
  const w = weekOf([{ id: "projects/x", title: "Lunch plans", type: "project", facts: [["next_step", rec as never]] }], loadRules(root),
    [{ id: "e9", version: "1", summary: "Lunch, Sarah", start: "2026-11-05T12:00:00-05:00", source: "gcal" }], DAY, () => "Lunch plans");
  expect(w.days.flatMap((d) => d.lines).filter((l) => l.kind === "event")).toHaveLength(1);
}, 60_000);
