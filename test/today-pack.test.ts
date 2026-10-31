// SPDX-License-Identifier: AGPL-3.0-only
// The orientation opens with a short "today" pack (docs/agent-instructions.md#today): what's coming
// up in the agent's own view, how many notes changed there since it last asked, and how many of its
// proposals still wait. An assistant that reads only the orientation starts a chat informed.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { orientation, whatsNew, remember } from "../src/core";
import { pullSource } from "../src/pull";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const commit = (root: string, msg: string) => { sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", msg); };
const edit = (root: string, rel: string, from: string, to: string) => { const f = join(root, rel); writeFileSync(f, readFileSync(f, "utf8").replace(from, to)); };
const pack = (text: string) => text.split("\n## ")[1]?.startsWith("Today") ? text.split("\n## ")[1] : "";

test("the orientation opens with what's coming up in the agent's own view, and nothing it can't see", () => {
  const root = makeBrain();
  // A next step on a private money note: the steward sees it, the planner (no money) never does.
  edit(root, "money/main-bank.md", "facts:\n", "facts:\n  next_payment: { value: Pay the card by 2026-10-20, as_of: 2026-10-05, sources: [\"gmail:f000000000000009\"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }\n");
  commit(root, "louis: card");
  const planner = orientation(root, "planner", "mcp");
  const p = pack(planner.text);
  expect(p).toContain("Coming up");
  expect(p).toContain("Course A (next_step): Grade the midterm");
  expect(p).not.toContain("Pay the card");
  expect(planner.text).not.toContain("Pay the card");
  expect(planner.today?.next.map((n) => n.id)).toEqual(["projects/course-a"]);
  const steward = pack(orientation(root, "steward", "mcp").text);
  // Dated steps come first, soonest first; undated ones after.
  expect(steward.indexOf("Pay the card by 2026-10-20")).toBeGreaterThan(-1);
  expect(steward.indexOf("Pay the card")).toBeLessThan(steward.indexOf("Grade the midterm"));
  // The pack sits before the rest of the guide, and the guide still fits a hosted assistant.
  expect(planner.text.indexOf("## Today")).toBeLessThan(planner.text.indexOf("## What you can see"));
  expect(planner.text.length).toBeLessThan(6400);
});

test("a next step that went by is served from the calendar in the pack too", async () => {
  const root = makeBrain();
  edit(root, "projects/course-a.md", "value: Grade the midterm, as_of: 2026-10-01", "value: Grade the midterm by 2026-10-05, as_of: 2026-09-01");
  writeFileSync(join(root, "cal.json"), JSON.stringify([{ id: "next1", etag: '"2"', status: "confirmed", summary: "Course A class", start: { dateTime: "2026-10-14T18:30:00-04:00" }, location: "Room 12" }]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "cal.json", upcoming: true } } }));
  commit(root, "louis: calendar");
  expect(pack(orientation(root, "planner", "mcp").text)).not.toContain("Course A (next_step)"); // stale: left out
  await pullSource(root, "cal", { model: null });
  expect(pack(orientation(root, "planner", "mcp").text)).toContain("Course A (next_step): Course A class, 2026-10-14 18:30, Room 12 (from the calendar)");
});

test("the pack counts notes changed since the agent last asked, without moving its whats_new mark", () => {
  const root = makeBrain();
  whatsNew(root, "planner");
  expect(pack(orientation(root, "planner", "mcp").text)).toContain("Nothing changed in your view since you last asked.");
  edit(root, "projects/course-a.md", "value: Grade the midterm,", "value: Grade the final,");
  commit(root, "louis: course a");
  const o = orientation(root, "planner", "mcp");
  expect(pack(o.text)).toContain("1 note changed in your view since you last asked: whats_new lists it.");
  expect(o.today?.changed).toBe(1);
  // Reading the orientation is not reading the changes: whats_new still has it.
  expect(whatsNew(root, "planner").changes.map((c) => c.id)).toEqual(["projects/course-a"]);
  expect(pack(orientation(root, "planner", "mcp").text)).toContain("Nothing changed in your view since you last asked.");
});

test("the pack counts the agent's own proposals still waiting for the owner", () => {
  const root = makeBrain();
  const r = remember(root, "helper", { id: "projects/course-a", attribute: "next_step", value: "Post the grades", as_of: "2026-10-07", sources: ["gmail:f000000000000004"] });
  expect(r.outcome).toBe("inbox");
  const o = orientation(root, "helper", "api");
  expect(pack(o.text)).toContain("1 of your proposals waits for Robin.");
  expect(o.today?.waiting).toBe(1);
});

test("no pack in the connect contract or for the gardener", () => {
  const root = makeBrain();
  expect(orientation(root, "planner", "mcp", "connect").contract).not.toContain("Today");
  const g = orientation(root, "gardener", "mcp");
  expect(g.text).not.toContain("## Today");
  expect(g.today).toBeUndefined();
});
