// SPDX-License-Identifier: AGPL-3.0-only
// CEO review 2026-11-09: the box answered "Noted: …. Seen by your assistants." for anything that
// wasn't private, whatever the assistants' slices, so it said so about pages no assistant can
// read, and "Seen by only you." for a private fact an assistant reads at its level. The sentence
// is now true: "your assistants" only when at least one assistant that reads the brain (not paused,
// not the Gardener) can read that very fact; otherwise "No assistant can read it yet." (G777).
// No access changes: only the words and their condition.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { setAgentStatus } from "../src/dashboard/actions";
import { loadRules } from "../src/rules";

test("a fact an assistant can read says so", () => {
  const root = makeBrain();
  expect(ownerSay(root, "Jane Roy's role is program director").text).toBe("Noted: Jane Roy is program director now. Seen by your assistants.");
});

test("a fact no assistant can read says so plainly, and the slices stay as they were", () => {
  const root = makeBrain();
  // Paul Advisor is in the personal area: planner and helper read only org and role of people
  // (contacts-basic), so only steward reads when they last met. With steward paused, no one does.
  setAgentStatus(root, "steward", "paused");
  const before = readFileSync(join(root, "rules", "policy.yaml"), "utf8");
  const r = ownerSay(root, "met Paul Advisor yesterday");
  expect(r.kind).toBe("say.noted");
  expect(r.text).toStartWith("Noted: ");
  expect(r.text).toContain("No assistant can read it yet.");
  expect(r.text).not.toContain("Seen by your assistants");
  expect(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).toBe(before);
  expect(loadRules(root).policy.agents.steward?.slices).toEqual(["all"]);
});

test("the Gardener reading it doesn't count as your assistants", () => {
  const root = makeBrain();
  for (const a of ["steward", "planner", "helper"]) setAgentStatus(root, a, "paused");
  const r = ownerSay(root, "Jane Roy's role is program director");
  expect(r.text).toContain("No assistant can read it yet.");
});

test("a sentence with two parts says each part's truth", () => {
  const root = makeBrain();
  setAgentStatus(root, "steward", "paused");
  const r = ownerSay(root, "Jane Roy's role is program director and I met Paul Advisor yesterday");
  expect(r.kind).toBe("say.noted");
  expect(r.text).not.toMatch(/Seen by only you/);
  expect(r.text).toContain("Seen by your assistants");
  expect(r.text).toContain("no assistant can read this yet");
});
