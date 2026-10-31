// SPDX-License-Identifier: AGPL-3.0-only
// Re-audit 2026-10-30 (first audit's high finding, still reproduced on 6e15f79): a collaborator is a
// person the owner lent a slice to (docs/share.md), not one of the owner's assistants. Memory sync's
// pass left them out, but quiz() itself, the belief radar (and its one-tap Fix everywhere) and the
// home's "Your assistants" did not: the collaborator's assistant was quizzed about the owner's facts
// and listed as the owner's own. One rule now: a collaborator is never the owner's assistant (G529).
import { test, expect, beforeEach } from "bun:test";
import { makeBrain } from "./fixture";
import { loadRules, ownAssistant } from "../src/rules";
import { addShare } from "../src/share";
import { quiz, memoryCheck } from "../src/memsync";
import { write } from "../src/write";
import { beliefs } from "../src/beliefs";
import { assistantReads } from "../src/dashboard/home";

beforeEach(() => { process.env.PB_TODAY = "2026-10-08"; });

function brain() {
  const root = makeBrain();
  addShare(root, { agent: "alice", name: "Alice Roy", slices: ["area:work"], days: 30 });
  return root;
}

test("a collaborator's assistant is never quizzed, by any path", () => {
  const root = brain();
  expect(quiz(root, "alice", 3)).toEqual([]);
  expect(quiz(root, "planner", 1).length).toBe(1);
  // Nor told what to rewrite in its own memory when the owner's facts change.
  memoryCheck(root, "alice");
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "Program director", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  expect(memoryCheck(root, "alice").changes).toBeUndefined();
});

test("the belief radar and the home's Your assistants leave the collaborator out", () => {
  const root = brain();
  expect(beliefs(root).agents).not.toContain("alice");
  const rows = assistantReads(root, loadRules(root), new Date("2026-10-08T15:00:00Z"));
  expect(rows.map((r) => r.agent)).not.toContain("alice");
  expect(rows.map((r) => r.agent)).toContain("planner");
});

test("the rule", () => {
  const rules = loadRules(brain());
  expect(ownAssistant(rules, "alice")).toBe(false);
  expect(ownAssistant(rules, "planner")).toBe(true);
});
