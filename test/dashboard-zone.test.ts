// SPDX-License-Identifier: AGPL-3.0-only
// Dashboard dates and times in the owner's zone (backlog 353): they rendered in UTC, so a save at
// 21:30 in Toronto showed as the next day at 01:30 and the owner stopped trusting the history.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerLocal } from "../src/clock";
import { loadState, activityByDay } from "../src/dashboard/data";
import { weekPage } from "../src/dashboard/html-history";
import type { Save } from "../src/dashboard/history";

test("a timestamp reads in the owner's zone; a bare date stays as it is", () => {
  expect(ownerLocal("2026-10-17T01:30:00Z")).toBe("2026-10-16T21:30");
  expect(ownerLocal("2026-10-17T01:30:00.000Z")).toBe("2026-10-16T21:30");
  expect(ownerLocal("2026-10-16T21:30:00-04:00")).toBe("2026-10-16T21:30");
  expect(ownerLocal("2026-10-17")).toBe("2026-10-17");
  expect(ownerLocal("not a date")).toBe("not a date");
});

test("an evening's reads count on that evening's day, and an evening save is today at its local time", () => {
  const root = makeBrain();
  const now = new Date("2026-10-17T02:00:00Z"); // 22:00 on the 16th in Toronto
  const s = loadState(root, now);
  const agent = s.agents[0].name;
  const days = activityByDay({ ...s, reads: [{ at: "2026-10-17T01:30:00Z", agent }], writes: [] } as never, 2);
  expect(days.map((d) => d.day)).toEqual(["2026-10-15", "2026-10-16"]);
  expect(days[1].counts[agent]).toBe(1);

  const save = { hash: "a".repeat(40), at: "2026-10-17T01:30:00Z", author: "owner", email: "owner@pocketbrain.local", message: "x", id: s.notes[0].fm.id, actor: "owner", changes: [] } as unknown as Save;
  const body = weekPage(s, [save], 7).body;
  expect(body).toContain(">Today<");
  expect(body).toContain("21:30");
  expect(body).not.toContain("01:30");
});
