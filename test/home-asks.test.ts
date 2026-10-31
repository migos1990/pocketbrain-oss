// SPDX-License-Identifier: AGPL-3.0-only
// Who knows (the home until the owner app, 2026-10-30) shows the conversation, not the rows (Louis's fourth outside read, 2026-10-29, G502):
// under each assistant, what it asked the brain today and which pages it was told, newest first,
// with the time, in the owner's words. Owner-only, from the read log the hub already keeps.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { contextPack, search, readNote } from "../src/core";
import { appendChained } from "../src/readlog";
import { homeView, ASKS_PER_ASSISTANT } from "../src/dashboard/home";
import { whoPage } from "../src/dashboard/html-app";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { FORBIDDEN } from "./owner-copy.test";

const view = (root: string) => homeView(root, loadRules(root), loadBrain(root), new Date());

test("each assistant's row says what it asked today and what it was told, newest first", () => {
  const root = makeBrain();
  contextPack(root, "planner", "Course A");
  search(root, "planner", "Jane");
  readNote(root, "planner", "people/jane-roy");
  // Yesterday's question is not today's.
  appendChained(join(root, "log", "reads.jsonl"), { at: new Date(Date.now() - 2 * 86_400_000).toISOString(), agent: "steward", op: "search", ids: ["people/jane-roy"], q: "an old question" });
  const v = view(root);
  const planner = v.reads.find((r) => r.agent === "planner")!;
  expect(planner.asked!.map((a) => a.what)).toEqual(["opened Jane Roy", "searched “Jane”", "asked about “Course A”"]);
  expect(planner.asked![0]!.told).toBe("Jane Roy");
  expect(planner.asked![0]!.at).toMatch(/^\d{1,2}:\d{2}$/);
  expect(v.reads.find((r) => r.agent === "steward")!.asked ?? []).toEqual([]);
  const html = whoPage(v, "x");
  expect(html).toContain("searched “Jane”");
  expect(html).not.toContain("an old question");
  const words = v.reads.flatMap((r) => (r.asked ?? []).flatMap((a) => [a.what, a.told])).join(" ");
  expect(FORBIDDEN.filter((w) => new RegExp(`\\b${w}`, "i").test(words))).toEqual([]);
});

test("a page it couldn't see is said as such, never by its id, and the list is capped", () => {
  const root = makeBrain();
  try { readNote(root, "helper", "money/main-bank"); } catch { /* not in its view */ }
  for (let i = 0; i < ASKS_PER_ASSISTANT + 2; i++) search(root, "helper", `course ${i}`);
  const helper = view(root).reads.find((r) => r.agent === "helper")!;
  expect(helper.asked!.length).toBe(ASKS_PER_ASSISTANT);
  expect(helper.askedMore).toBe(3);
  const all = JSON.stringify(helper);
  expect(all).not.toContain("money/main-bank");
});

// Use-it check on the real brain, 2026-10-30: rows said "3 times" with no line under them. An
// assistant's connect and its orientation are reads too, and every read the row counts has a line.
test("every read the row counts has its line, a connect and an orientation too", () => {
  const root = makeBrain();
  const ops: [string, string[]][] = [["connect", []], ["orientation", []], ["whats_new", ["people/jane-roy"]], ["open_disputes", []], ["ask_read", ["people/jane-roy"]], ["log_search", ["log:a"]], ["log_read", ["log:a"]], ["memory_check", []]];
  for (const [op, ids] of ops) appendChained(join(root, "log", "reads.jsonl"), { at: new Date().toISOString(), agent: "steward", op, ids });
  const steward = view(root).reads.find((r) => r.agent === "steward")!;
  expect(steward.today).toBe(ops.length);
  expect((steward.asked ?? []).length + (steward.askedMore ?? 0)).toBe(ops.length);
  const words = (steward.asked ?? []).map((a) => `${a.what} ${a.told}`).join(" ");
  expect(FORBIDDEN.filter((w) => new RegExp(`\\b${w}`, "i").test(words))).toEqual([]);
});

test("the same read again and again is one line, counted", () => {
  const root = makeBrain();
  for (let i = 0; i < 4; i++) appendChained(join(root, "log", "reads.jsonl"), { at: new Date().toISOString(), agent: "steward", op: "connect", ids: [] });
  contextPack(root, "steward", "Course A");
  const steward = view(root).reads.find((r) => r.agent === "steward")!;
  expect(steward.today).toBe(5);
  expect(steward.asked!.map((a) => a.what)).toEqual(["asked about “Course A”", "connected (4 times)"]);
});
