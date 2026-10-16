// SPDX-License-Identifier: AGPL-3.0-only
// The owner is "owner" in code and new records; brains written when the code said "louis" still read.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { registerLouisMessages, louisMessages } from "../src/louis";
import { loadBrain, type FactRecord } from "../src/brain";
import { git } from "../src/git";
import { runChecks } from "../src/checks";

const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr] as FactRecord;
const base = { agent: "steward", id: "people/paul-advisor", attribute: "role", as_of: "2026-10-08", sources: ["imsg:phonemsg-01M5OWNERREALTEXTQQQQQQQ01"] };

test("a legacy confirmed-by-louis write is stored as confirmed-by-owner, and still outranks sources", () => {
  const root = makeBrain();
  expect(write(root, { ...base, value: "Retired advisor", verification: "confirmed-by-louis" }).outcome).toBe("committed");
  expect(fact(root, "people/paul-advisor", "role").verification).toBe("confirmed-by-owner");
  // A verified source doesn't override the owner's word, whichever spelling it was stored under.
  const r = write(root, { ...base, agent: "planner", value: "Advisor", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  expect(r.outcome).not.toBe("committed");
  expect(fact(root, "people/paul-advisor", "role").value).toBe("Retired advisor");
});

test("owner:<date>/<channel> and louis:<date>/<channel> refs both count as the owner's word", () => {
  const root = makeBrain();
  registerLouisMessages(root, ["owner:2026-10-08/text-1", "louis:2026-10-08/text-2"]);
  for (const [attr, ref] of [["status", "owner:2026-10-08/text-1"], ["phone_note", "louis:2026-10-08/text-2"]])
    expect(write(root, { ...base, attribute: attr, value: "x " + attr, sources: [ref], verification: "confirmed-by-owner" }).outcome, ref).toBe("committed");
});

test("a new brain keeps message ids in owner-messages.yaml; an old one keeps louis-messages.yaml", () => {
  const fresh = makeBrain();
  registerLouisMessages(fresh, ["imsg:phonemsg-A"]);
  expect(existsSync(join(fresh, "rules/owner-messages.yaml"))).toBe(true);
  expect(existsSync(join(fresh, "rules/louis-messages.yaml"))).toBe(false);
  const old = makeBrain();
  writeFileSync(join(old, "rules/louis-messages.yaml"), "messages:\n  - { id: imsg:phonemsg-OLD, added: 2026-10-01 }\n");
  registerLouisMessages(old, ["imsg:phonemsg-B"]);
  expect([...louisMessages(old)].sort()).toEqual(["imsg:phonemsg-B", "imsg:phonemsg-OLD"]);
  expect(existsSync(join(old, "rules/owner-messages.yaml"))).toBe(false);
});

test("the owner's commits carry their name; a brain whose owner is Louis keeps the author louis", () => {
  const root = makeBrain(); // owner.name is Robin
  registerLouisMessages(root, ["imsg:phonemsg-C"]);
  expect(git(root, ["log", "-1", "--format=%an %ae"])).toBe("Robin owner@pocketbrain.local");
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("owner: { name: Robin }", "owner: { name: Louis }"));
  git(root, ["commit", "-qam", "owner is Louis"], "owner");
  registerLouisMessages(root, ["imsg:phonemsg-E"]);
  expect(git(root, ["log", "-1", "--format=%an %ae"])).toBe("louis louis@pocketbrain.local");
  writeFileSync(p, readFileSync(p, "utf8").replace("owner: { name: Louis }", "owner: { name: Sam Rivera }"));
  git(root, ["commit", "-qam", "rename owner"], "owner");
  registerLouisMessages(root, ["imsg:phonemsg-D"]);
  expect(git(root, ["log", "-1", "--format=%an %ae"])).toBe("Sam Rivera owner@pocketbrain.local");
});

test("a claimed approval is caught by the owner's own name too", () => {
  const req = { agent: "planner", id: "projects/course-a", attribute: "status", as_of: "2026-10-08", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const };
  for (const v of ["Sam approved the budget", "the owner signed off", "Louis said yes"])
    expect(runChecks({ ...req, value: v }, new Set(), "Sam").some((f) => f.check === "approval_needs_message_id"), v).toBe(true);
  expect(runChecks({ ...req, value: "Sam emailed the budget" }, new Set(), "Sam").some((f) => f.check === "approval_needs_message_id")).toBe(false);
});
