// SPDX-License-Identifier: AGPL-3.0-only
// Switch day in one command (docs/switch-day.md): `pocketbrain add <new> --like <old>` starts the
// new assistant from the old one's carve. Only what narrows carries over: the new agent is trial
// whatever the old one was, never gets more than personal, never the all slice, and keeps the old
// one's leave-outs plus money. A name that is an area is refused, since carve gives an agent every
// note of the area it is named after.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { loadRules } from "../src/rules";
import { likeAgent, previewNewAgent, addAgent } from "../src/addagent";
import { carve, grantFor } from "../src/carve";
import { loadBrain } from "../src/brain";
import { resetEnrollLimits } from "../src/invite";

function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } finally { console.log = log; console.error = err; }
  return { code, out: out.join("\n") };
}
const policy = (root: string) => YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents;
const sees = (root: string, agent: string) => {
  const rules = loadRules(root);
  return [...carve(loadBrain(root), rules, grantFor(rules, agent)).visible.keys()].sort();
};
function setAgent(root: string, name: string, a: object) {
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["agents", name], doc.createNode(a, { flow: true }));
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
}

test("--like copies the slices and leave-outs but starts trial: a core agent's private notes stay out", () => {
  const root = makeBrain();
  const like = likeAgent(loadRules(root), "planner");
  expect(like.slices).toEqual(["area:work", "contacts-basic"]);
  expect(like.exclude_types).toContain("money");
  // A core agent on the personal area holds a private decision; its copy must not.
  setAgent(root, "homebot", { tier: "core", slices: ["area:personal"] });
  addAgent(root, { agent: "nova", ...likeAgent(loadRules(root), "homebot") });
  expect(policy(root).nova).toMatchObject({ tier: "trial", slices: ["area:personal"], exclude_types: ["money"] });
  const nova = sees(root, "nova"), old = sees(root, "homebot");
  expect(nova.every((id) => old.includes(id))).toBe(true);
  const priv = loadBrain(root).filter((n) => n.fm.sensitivity === "private" && old.includes(n.fm.id));
  expect(priv.length).toBeGreaterThan(0);
  for (const n of priv) expect(nova).not.toContain(n.fm.id);
  expect(grantFor(loadRules(root), "nova").ceiling).toBe("personal");
});

test("--like never copies a ceiling above trial's, but keeps one below it", () => {
  const root = makeBrain();
  setAgent(root, "wide", { tier: "core", max_sensitivity: "private", slices: ["area:work"], exclude: ["people/x"] });
  setAgent(root, "narrow", { tier: "trial", max_sensitivity: "public", slices: ["area:work"] });
  const wide = likeAgent(loadRules(root), "wide");
  expect(wide.max_sensitivity).toBeUndefined();
  expect(wide.exclude).toEqual(["people/x"]);
  expect(likeAgent(loadRules(root), "narrow").max_sensitivity).toBe("public");
  // And a hand-built request can't ask for more than trial's ceiling either.
  expect(() => previewNewAgent(root, { agent: "nova", slices: ["area:work"], max_sensitivity: "private" })).toThrow(/personal/);
});

test("--like refuses agents whose access isn't a carve to copy", () => {
  const root = makeBrain();
  setAgent(root, "pal", { tier: "trial", slices: ["area:work"], collaborator: { name: "Sam", until: "2099-01-01" } });
  setAgent(root, "inner", { tier: "core", inside_wall: true, slices: ["all"] });
  const rules = loadRules(root);
  expect(() => likeAgent(rules, "nobody")).toThrow(/policy.yaml/);
  expect(() => likeAgent(rules, "steward")).toThrow(/all slice/);
  expect(() => likeAgent(rules, "gardener")).toThrow(/gardener/);
  expect(() => likeAgent(rules, "pal")).toThrow(/share/);
  expect(() => likeAgent(rules, "inner")).toThrow(/inside the wall/);
});

test("a new agent can't be named after an area: carve would give it the whole area", () => {
  const root = makeBrain();
  expect(() => previewNewAgent(root, { agent: "work", slices: ["contacts-basic"] })).toThrow(/area/);
  // An area that is only on notes, not declared in policy.yaml, counts too.
  const area = loadBrain(root).map((n) => n.fm.area).find((a) => a && !loadRules(root).policy.areas[a]);
  if (area) expect(() => previewNewAgent(root, { agent: area, slices: ["contacts-basic"] })).toThrow(/area/);
  expect(run(root, "add", "personal", "--like", "planner", "--yes").code).toBe(1);
  expect(policy(root).personal).toBeUndefined();
});

test("pocketbrain add --like previews first, then adds with an invite and the day-one instruction", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const p = run(root, "add", "nova", "--like", "planner");
  expect(p.code).toBe(0);
  expect(p.out).toContain("like planner");
  expect(p.out).toContain("Nothing granted yet");
  expect(policy(root).nova).toBeUndefined();
  const r = run(root, "add", "nova", "--like", "planner", "--slices", "contacts-basic", "--url", "https://brain.test", "--yes");
  expect(r.code).toBe(0);
  expect(policy(root).nova).toMatchObject({ tier: "trial", slices: ["area:work", "contacts-basic"] });
  expect(r.out).toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}/);
  expect(r.out).toContain("https://brain.test/v1/enroll");
  expect(r.out).toContain("from your brain");
  expect(r.out).toContain("pocketbrain token --revoke planner");
  expect(r.out).not.toMatch(/pb_nova_/);
  // Extra --slices add to the copy; they never replace it.
  expect(run(root, "add", "orbit", "--like", "helper", "--slices", "area:personal").out).toContain("orbit like helper: area:work, contacts-basic, area:personal");
  // Two areas: a terminal makes no invite for that (G241, claude/cli-token-pem), so --yes is
  // refused and nothing is granted (the owner adds it with the sign-in door, or on the dashboard).
  expect(run(root, "add", "orbit", "--like", "helper", "--slices", "area:personal", "--yes").code).toBe(1);
  expect(policy(root).orbit).toBeUndefined();
  expect(run(root, "add", "dup", "--like", "steward", "--yes").code).toBe(1);
});

// Slice audit of claude/add-like (pocketbrain-app-reviews/add-like-slice-audit.md).
test("audit M3: the copy's ceiling follows what the old agent actually sees, its tier's included", () => {
  const root = makeBrain();
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.setIn(["tiers", "core", "max_sensitivity"], "public");
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  expect(grantFor(loadRules(root), "planner").ceiling).toBe("public");
  expect(likeAgent(loadRules(root), "planner").max_sensitivity).toBe("public");
  addAgent(root, { agent: "nova", ...likeAgent(loadRules(root), "planner") });
  expect(sees(root, "nova").every((id) => sees(root, "planner").includes(id))).toBe(true);
});

test("audit L1: read-only, hours and the proposal cap carry over; a pause doesn't", () => {
  const root = makeBrain();
  setAgent(root, "old", { tier: "trial", slices: ["area:work"], status: "read-only", windows: ["daily 08:00-09:00"], max_proposals_per_day: 3 });
  setAgent(root, "gone", { tier: "trial", slices: ["area:work"], status: "paused" });
  addAgent(root, { agent: "nova", ...likeAgent(loadRules(root), "old") });
  expect(policy(root).nova).toMatchObject({ status: "read-only", windows: ["daily 08:00-09:00"], max_proposals_per_day: 3 });
  expect(likeAgent(loadRules(root), "gone").status).toBeUndefined();
});

test("audit L2 and M1: no areas key doesn't crash add, and carve --confirm can't create an area-named agent", () => {
  const root = makeBrain();
  expect(run(root, "carve", "work", "--slices", "contacts-basic", "--confirm").code).not.toBe(0);
  expect(policy(root).work).toBeUndefined();
  const file = join(root, "rules", "policy.yaml");
  const doc = YAML.parseDocument(readFileSync(file, "utf8"));
  doc.deleteIn(["areas"]);
  writeFileSync(file, doc.toString({ lineWidth: 0 }));
  expect(previewNewAgent(root, { agent: "zeta", slices: ["contacts-basic"] }).agent).toBe("zeta");
  // An area that is only on notes still counts.
  expect(() => previewNewAgent(root, { agent: "work", slices: ["contacts-basic"] })).toThrow(/area/);
});
