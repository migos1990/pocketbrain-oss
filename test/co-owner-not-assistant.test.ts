// SPDX-License-Identifier: AGPL-3.0-only
// Re-audit follow-up 2026-10-30 (G533): a household co-owner's assistant (docs/household.md) works
// for the co-owner, a person, as a collaborator's does (G529). It was still listed under the owner's
// "Your assistants", in the belief radar, and quizzed about the owner's facts. Never, now.
import { test, expect, beforeEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadRules, ownAssistant } from "../src/rules";
import { quiz } from "../src/memsync";
import { beliefs } from "../src/beliefs";
import { assistantReads } from "../src/dashboard/home";

beforeEach(() => { process.env.PB_TODAY = "2026-10-08"; });

function household() {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.areas.household = { owner: "steward" };
  p.agents["sam-assistant"] = { tier: "core", slices: ["area:household", "area:work"] };
  p.co_owners = { sam: { name: "Sam Roy", areas: ["household"], agents: ["sam-assistant"] } };
  writeFileSync(f, YAML.stringify(p));
  Bun.spawnSync(["git", "commit", "-qam", "household"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  return root;
}

test("a co-owner's assistant is not under Your assistants, not in the belief radar, never quizzed", () => {
  const root = household();
  const rows = assistantReads(root, loadRules(root), new Date("2026-10-08T15:00:00Z"));
  expect(rows.map((r) => r.agent)).not.toContain("sam-assistant");
  expect(rows.map((r) => r.agent)).toContain("planner");
  expect(beliefs(root).agents).not.toContain("sam-assistant");
  expect(quiz(root, "sam-assistant", 3)).toEqual([]);
});

test("the rule takes the whole policy: a co-owner's or a collaborator's assistant is never the owner's", () => {
  const rules = loadRules(household());
  expect(ownAssistant(rules, "sam-assistant")).toBe(false);
  expect(ownAssistant(rules, "planner")).toBe(true);
  expect(ownAssistant(rules, "nobody")).toBe(false);
});
