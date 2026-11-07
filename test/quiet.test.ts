// SPDX-License-Identifier: AGPL-3.0-only
// Did my assistant stop reading the brain? (next-level F4, G697, G698): one line on the home, never
// counted, when a connected assistant has gone quiet measured against its own habit; nothing when
// every connected assistant has read recently.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { issueToken, revokeTokens } from "../src/auth";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { quietAssistants, quietLine, usualGap, quietAfter } from "../src/quiet";
import { homeView, waitingCount } from "../src/dashboard/home";
import { homePage, whoPage } from "../src/dashboard/html-app";

const H = 3_600_000, D = 24 * H;
const NOW = new Date("2026-11-06T15:00:00Z");
function reads(root: string, agent: string, everyHours: number, lastAgoHours: number, n = 12) {
  mkdirSync(join(root, "log"), { recursive: true });
  const last = NOW.getTime() - lastAgoHours * H;
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ at: new Date(last - (n - 1 - i) * everyHours * H).toISOString(), agent, op: "search", ids: [], q: "x" }));
  appendFileSync(join(root, "log", "reads.jsonl"), lines.join("\n") + "\n");
}

test("each assistant is measured against its own habit: a daily reader is quiet after days, a weekly reader isn't (G698)", () => {
  const root = makeBrain();
  issueToken(root, "planner"); issueToken(root, "helper");
  reads(root, "planner", 24, 4 * 24);   // read daily, last 4 days ago: quiet
  reads(root, "helper", 7 * 24, 9 * 24, 6); // reads weekly, last 9 days ago: not quiet yet
  const q = quietAssistants(root, loadRules(root), NOW);
  expect(q.map((x) => [x.agent, x.days])).toEqual([["planner", 4]]);
  expect(quietAfter(usualGap(Array.from({ length: 10 }, (_, i) => i * D))!)).toBe(3 * D);
  expect(quietAfter(usualGap(Array.from({ length: 10 }, (_, i) => i * H))!)).toBe(D); // an hourly reader: a day at the least
  expect(quietAfter(usualGap(Array.from({ length: 6 }, (_, i) => i * 7 * D))!)).toBe(14 * D); // weekly: two weeks at most
  expect(usualGap([0, D, 2 * D])).toBeUndefined(); // too little history says nothing
});

test("the home says one line, not counted, linking to Who knows; nothing when every connected assistant read recently (G697)", () => {
  const root = makeBrain();
  issueToken(root, "planner");
  const rules = loadRules(root), notes = loadBrain(root);
  reads(root, "planner", 24, 3);
  const calm = homeView(root, rules, notes, NOW);
  expect(calm.quiet).toBeUndefined();
  const count = waitingCount(root, NOW);
  const root2 = makeBrain();
  issueToken(root2, "planner");
  reads(root2, "planner", 24, 9 * 24);
  const v = homeView(root2, loadRules(root2), loadBrain(root2), NOW);
  expect(v.quiet).toBe("Planner has not read your brain in 9 days. Who knows has the details.");
  expect(waitingCount(root2, NOW)).toBe(count);
  expect(homePage(v, "c")).toContain('<a class="late" role="status" href="/who">Planner has not read your brain in 9 days. Who knows has the details.</a>');
  expect(whoPage(v, "c")).toContain("Last read 9 days ago; it used to read about every day");
});

test("a paused assistant, one with no token or sign-in, the gardener and one with too little history never show", () => {
  const root = makeBrain();
  reads(root, "planner", 24, 9 * 24);      // no token
  issueToken(root, "gardener");
  reads(root, "gardener", 24, 9 * 24);     // the gardener isn't one of the owner's assistants on the home
  issueToken(root, "helper");
  reads(root, "helper", 24, 9 * 24, 3);    // three sessions only
  expect(quietAssistants(root, loadRules(root), NOW)).toEqual([]);
  expect(quietLine([], (a) => a)).toBeUndefined();
  expect(quietLine([{ agent: "a", last: "", days: 9, usualHours: 24 }, { agent: "b", last: "", days: 5, usualHours: 24 }], (a) => a.toUpperCase())).toBe("A has not read your brain in 9 days, and 1 more assistant has gone quiet. Who knows has the details.");
});

test("a revoked assistant drops off within the hour, and a long read history doesn't break the home (review of PR 115)", () => {
  const root = makeBrain();
  issueToken(root, "planner");
  reads(root, "planner", 24, 9 * 24);
  expect(quietAssistants(root, loadRules(root), NOW).map((q) => q.agent)).toEqual(["planner"]);
  revokeTokens(root, "planner");
  expect(quietAssistants(root, loadRules(root), NOW)).toEqual([]);
  const root2 = makeBrain();
  issueToken(root2, "planner");
  reads(root2, "planner", 24, 9 * 24);
  reads(root2, "planner", 0.0001, 9 * 24, 200_000); // a burst on its last day: far more reads than a spread can take
  expect(quietAssistants(root2, loadRules(root2), NOW).map((q) => q.agent)).toEqual(["planner"]);
});
