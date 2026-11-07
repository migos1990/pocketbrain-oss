// SPDX-License-Identifier: AGPL-3.0-only
// Next-level D2 (2026-11-06, the owner's "go" on the top five): "every person page says when I last
// saw them and when I will." The calendar the owner consented to already knows. Its cache keeps each
// event's guests as hashes of their addresses, never the addresses, and the past quarter as well as
// the coming 60 days (G695); a person's page reads "Last met …, next … , n meetings this quarter"
// from the events whose guests include one of the person's addresses, or whose title names them in
// full (G694). A line, never a card, and nothing is written to the brain.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { makeDemoBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";
import { DEMO_NOW, DEMO_DAY } from "../scripts/demo-brain";
import { toUpcoming, saveUpcoming, upcomingFile, loadUpcoming } from "../src/upcoming";

const ev = (id: string, summary: string, start: string, guests: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ id, etag: `"${id}1"`, summary, start: { dateTime: `${start}T15:00:00Z` }, attendees: [{ email: "robin@example.org", self: true }, ...guests.map((email) => ({ email }))], ...extra });
const page = (s: ReturnType<typeof loadState>, id: string, fresh = true) => ownerPage(s, "", s.notes.find((x) => x.fm.id === id)!, [], { fresh });
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();

async function brain(events: Record<string, unknown>[], sensitivity?: "private") {
  const { root } = await makeDemoBrain();
  saveUpcoming(root, "calendar", events.flatMap((e) => toUpcoming(e, "calendar", sensitivity) ?? []), DEMO_DAY);
  return root;
}

test("G695 the calendar cache keeps guests as hashes, never their addresses, and the past quarter", async () => {
  const root = await brain([
    ev("e1", "Pilot check-in", "2026-10-02", ["Ben.Carter@example.org"]),
    ev("e0", "Too old", "2026-06-01", ["ben.carter@example.org"]),
    ev("e2", "Export review", "2026-10-14", ["ben.carter@example.org", "room-4@resource.calendar.google.com"]),
  ]);
  const file = readFileSync(upcomingFile(root), "utf8");
  expect(file).not.toContain("example.org");
  expect(file).not.toContain("robin");
  expect(file).toContain("Pilot check-in"); // 6 days back: kept
  expect(file).not.toContain("Too old"); // over a quarter back: not
  // What's coming, as before: only today and later.
  expect(loadUpcoming(root, DEMO_DAY).map((e) => e.id)).toEqual(["e2"]);
}, 60_000);

test("G694 a person's page says when you last met, when you meet next and how often this quarter", async () => {
  const root = await brain([
    ev("e1", "Pilot check-in", "2026-10-02", ["Ben.Carter@example.org"]),
    ev("e3", "Kickoff", "2026-07-20", ["ben.carter@example.org"]), // last quarter: not counted
    ev("e2", "Export review", "2026-10-14", ["ben.carter@example.org"]),
    ev("e4", "Lunch with Ben Carter", "2026-10-06"), // his full name in the title, no guest list
  ]);
  const head = git(root, "rev-parse", "HEAD");
  const s = loadState(root, new Date(DEMO_NOW));
  const html = page(s, "people/ben-carter");
  expect(html).toContain('<p class="kind meet">Last met 6 Oct · Next: Export review, 14 Oct · 2 meetings so far this quarter</p>');
  // Someone in none of them gets no line.
  expect(page(s, "people/chloe-gagnon")).not.toContain('class="kind meet"');
  // Nothing written, no card.
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(s.asks.length).toBe(loadState(root, new Date(DEMO_NOW)).asks.length);
}, 60_000);

test("G694 a private calendar's meetings show only right after a sign-in", async () => {
  const root = await brain([ev("e1", "Pilot check-in", "2026-10-02", ["ben.carter@example.org"])], "private");
  const s = loadState(root, new Date(DEMO_NOW));
  expect(page(s, "people/ben-carter", true)).toContain("Last met 2 Oct");
  expect(page(s, "people/ben-carter", false)).not.toContain('class="kind meet"');
}, 60_000);

test("G694 a short or one-word name in a title ties no meeting to a page", async () => {
  const root = await brain([ev("e1", "Ben and the team", "2026-10-02")]);
  const s = loadState(root, new Date(DEMO_NOW));
  expect(page(s, "people/ben-carter")).not.toContain('class="kind meet"');
}, 60_000);

// The product bar (an odd sentence is a bug): the page never says "Last met 2 Oct" over prose that
// says "last in touch 24 Sep". When the calendar has a meeting after the stored last contact (the
// nightly capture lags), the calendar line wins and the stale sentence leaves that page (G696).
test("G696 a meeting newer than the stored last contact drops the stale sentence; an older one keeps it", async () => {
  const newer = await brain([ev("e1", "Pilot check-in", "2026-10-02", ["ben.carter@example.org"])]);
  const s = loadState(newer, new Date(DEMO_NOW));
  for (const fresh of [true, false]) {
    const html = page(s, "people/ben-carter", fresh);
    expect(html).toContain("Last met 2 Oct");
    expect(html).not.toContain("last in touch with Ben");
    expect(html).toContain("Ben Carter is the head of partnerships"); // the rest of the prose stands
  }
  const older = await brain([ev("e1", "Pilot check-in", "2026-09-10", ["ben.carter@example.org"])]);
  const o = loadState(older, new Date(DEMO_NOW));
  expect(page(o, "people/ben-carter")).toContain("Last met 10 Sep");
  expect(page(o, "people/ben-carter")).toContain("last in touch with Ben on 24 Sep");
}, 60_000);

// A title shaped like health, money or legal names only the day on the 30-day sign-in (G696).
test("G696 a sensitive-shaped meeting title shows only its day unless just signed in", async () => {
  const root = await brain([ev("e2", "Lawyer call", "2026-10-14", ["ben.carter@example.org"])]);
  const s = loadState(root, new Date(DEMO_NOW));
  expect(page(s, "people/ben-carter", true)).toContain("Next: Lawyer call, 14 Oct");
  const shut = page(s, "people/ben-carter", false);
  expect(shut).toContain("Next: 14 Oct");
  expect(shut).not.toContain("Lawyer");
}, 60_000);
