// SPDX-License-Identifier: AGPL-3.0-only
// `carve --confirm` from a shell (G107): any program with a shell can run the CLI, an agent included,
// so it may only shrink an existing agent's slice; a new agent gets add's rules (trial, never all).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { git } from "../src/git";

const REPO = join(import.meta.dir, "..");
const carve = (root: string, ...args: string[]) => {
  const r = Bun.spawnSync(["bun", join(REPO, "src", "cli.ts"), "carve", ...args, "--brain", root], { cwd: REPO, env: { ...process.env } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const agents = (root: string) => YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents;

test("an agent with a shell can't widen its own slice with carve --confirm", () => {
  const root = makeBrain();
  const head = git(root, ["rev-parse", "HEAD"]);
  for (const slices of ["all", "area:work,contacts-basic,area:personal"]) {
    const r = carve(root, "helper", "--slices", slices, "--confirm");
    expect(r.code).toBe(1);
    expect(r.err).toContain("can only shrink");
  }
  expect(agents(root).helper).toMatchObject({ slices: ["area:work", "contacts-basic"], exclude_types: ["money"] });
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(git(root, ["status", "--porcelain", "rules"])).toBe("");
});

test("shrinking from the shell still works, as one owner commit", () => {
  const root = makeBrain();
  const r = carve(root, "steward", "--slices", "area:work", "--confirm");
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(agents(root).steward.slices).toEqual(["area:work"]);
  expect(git(root, ["log", "-1", "--format=%ae|%s"])).toBe("owner@pocketbrain.local|owner: steward sees area:work");
  expect(carve(root, "helper", "--slices", "contacts-basic", "--confirm").code).toBe(0);
  expect(agents(root).helper.slices).toEqual(["contacts-basic"]);
});

test("a new agent from carve --confirm follows add's rules: never all, known slices only", () => {
  const root = makeBrain();
  const all = carve(root, "newbot", "--slices", "all", "--confirm");
  expect(all.code).toBe(2);
  expect(all.err).toContain("all slice");
  expect(carve(root, "newbot", "--slices", "area:nowhere", "--confirm").code).not.toBe(0);
  expect(agents(root).newbot).toBeUndefined();
  const ok = carve(root, "newbot", "--slices", "area:work,contacts-basic", "--exclude-types", "money", "--confirm");
  expect(ok.code).toBe(0);
  expect(agents(root).newbot).toMatchObject({ tier: "trial", slices: ["area:work", "contacts-basic"], exclude_types: ["money"] });
});

// G179: a slice-level exclude_attributes is part of what the agent sees today; dropping it widens.
test("carve --confirm can't unhide a fact a slice's exclude_attributes holds back (G179)", () => {
  const root = makeBrain();
  appendFileSync(join(root, "rules/slices.yaml"), "  work-no-phones:\n    areas: [work]\n    exclude_attributes: [phones]\n");
  const pol = join(root, "rules/policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [work-no-phones]"));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=owner", "-c", "user.email=o@x", "commit", "-qm", "owner edit"], { cwd: root });
  const head = git(root, ["rev-parse", "HEAD"]);
  const r = carve(root, "helper", "--slices", "area:work", "--exclude-types", "money", "--confirm");
  expect(r.code).toBe(1);
  expect(r.err).toContain("can only shrink");
  expect(agents(root).helper.slices).toEqual(["work-no-phones"]);
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
});

// G193: a new agent made by carve --confirm leaves money out by default, like add.
test("a new agent from carve --confirm leaves money out unless told otherwise, like add (G193)", () => {
  const root = makeBrain();
  const r = carve(root, "newbot", "--slices", "area:personal", "--confirm");
  expect(r.code).toBe(0);
  expect(agents(root).newbot).toMatchObject({ tier: "trial", slices: ["area:personal"], exclude_types: ["money"] });
  expect(r.out).not.toContain("Maple Trust Bank");
  const none = carve(root, "otherbot", "--slices", "area:personal", "--exclude-types", "none", "--confirm");
  expect(none.code).toBe(0);
  expect(agents(root).otherbot.exclude_types).toBeUndefined();
});

// G228, G229: --exclude-types none on an existing agent is a widening (refused), and what the check
// saw is what would be written: never checked as one list and written as another.
test("carve --confirm --exclude-types none can't drop an existing agent's left-out kinds (G228, G229)", () => {
  const root = makeBrain();
  appendFileSync(join(root, "rules/slices.yaml"), "  work-nob:\n    areas: [work]\n    exclude: [projects/course-b]\n");
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=owner", "-c", "user.email=o@x", "commit", "-qm", "owner edit"], { cwd: root });
  const head = git(root, ["rev-parse", "HEAD"]);
  const r = carve(root, "planner", "--slices", "work-nob", "--exclude-types", "none", "--confirm");
  expect({ code: r.code, head: git(root, ["rev-parse", "HEAD"]) === head }).toEqual({ code: 1, head: true });
  expect(agents(root).planner).toMatchObject({ slices: ["area:work", "contacts-basic"], exclude_types: ["money"] });
  // An agent with nothing left out today: none is written as none (no stale list from the old line).
  const ok = carve(root, "steward", "--slices", "area:work", "--exclude-types", "none", "--confirm");
  expect(ok.code).toBe(0);
  expect(agents(root).steward.exclude_types).toBeUndefined();
});
