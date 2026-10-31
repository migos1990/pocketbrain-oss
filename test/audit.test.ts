// SPDX-License-Identifier: AGPL-3.0-only
// The weekly carve audit: every widening of an agent's reach since the last audit is traced to
// the commits that caused it, and anything the owner didn't do becomes a Needs-you alert.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { auditCarve } from "../src/audit";
import { git } from "../src/git";
import { OWNER } from "../src/owner";
import { dueJobs } from "../src/start";
import { digest } from "../src/digest";

const alerts = (root: string) => { const f = join(root, "log", "alerts.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };
const edit = (root: string, rel: string, from: string | RegExp, to: string) => writeFileSync(join(root, rel), readFileSync(join(root, rel), "utf8").replace(from, to));
const commit = (root: string, author: string, msg = "change") => { git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", msg], author); };
const HELPER = /helper: \{ tier: trial, slices: \[area:work, contacts-basic\]/;

// Owner wall-clock in October (EDT, UTC-4): dueJobs counts the owner's day (src/clock.ts).
const toronto = (d: number, h: number, m: number) => new Date(Date.UTC(2026, 9, d, h + 4, m));

test("audit: the first run records a baseline and finds nothing on an untouched brain", () => {
  const root = makeBrain();
  const r = auditCarve(root);
  expect(r.widenings).toEqual([]);
  expect(r.alerts).toBe(0);
  expect(readFileSync(join(root, "log", "carve-audit.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  expect(alerts(root)).toEqual([]);
});

test("audit: a slice the owner granted is a widening, attributed to the owner's commit, no alert", () => {
  const root = makeBrain();
  auditCarve(root);
  edit(root, "rules/policy.yaml", HELPER, "helper: { tier: trial, slices: [area:work, area:personal, contacts-basic]");
  commit(root, OWNER, "owner: helper gets personal");
  const r = auditCarve(root);
  const w = r.widenings.filter((x) => x.agent === "helper");
  expect(w.map((x) => x.what)).toContain("slices +area:personal");
  expect(w.every((x) => x.ok)).toBe(true);
  expect(w[0].causes.map((c) => c.author)).toEqual(["Robin"]);
  expect(r.alerts).toBe(0);
  expect(alerts(root)).toEqual([]);
});

test("audit: a rules commit authored by an agent that widens a carve is an alert", () => {
  const root = makeBrain();
  auditCarve(root);
  edit(root, "rules/policy.yaml", HELPER, "helper: { tier: core, slices: [area:work, contacts-basic]");
  commit(root, "planner", "planner: tidy policy");
  const r = auditCarve(root);
  const w = r.widenings.find((x) => x.agent === "helper" && x.what === "tier trial -> core")!;
  expect(w.ok).toBe(false);
  expect(w.causes[0].author).toBe("planner");
  // core raises the ceiling too, and more notes and facts come into view.
  expect(r.widenings.some((x) => x.agent === "helper" && x.what.startsWith("max_sensitivity personal -> private"))).toBe(true);
  expect(alerts(root).map((a) => [a.agent, a.check])).toEqual([["helper", "carve_widened"]]);
  expect(alerts(root)[0].from).toContain("planner");
});

test("audit: an uncommitted rules edit that widens a carve is an alert even if nothing was committed", () => {
  const root = makeBrain();
  auditCarve(root);
  edit(root, "rules/policy.yaml", HELPER, "helper: { tier: trial, slices: [all]");
  const r = auditCarve(root);
  const w = r.widenings.find((x) => x.agent === "helper" && x.what === "slices +all")!;
  expect(w.ok).toBe(false);
  expect(w.uncommitted).toEqual(["rules/policy.yaml"]);
  expect(r.alerts).toBe(1);
});

test("audit: an agent commit on a note that brings it into another agent's view is an alert", () => {
  const root = makeBrain();
  auditCarve(root);
  // The finance tag keeps paul-advisor out of contacts-basic; dropping it by hand widens helper.
  edit(root, "people/paul-advisor.md", "tags: [finance]\n", "");
  commit(root, "planner", "planner: tags");
  const r = auditCarve(root);
  const w = r.widenings.find((x) => x.agent === "helper" && x.what === "note people/paul-advisor now visible")!;
  expect(w.ok).toBe(false);
  expect(w.causes.map((c) => c.author)).toEqual(["planner"]);
  // Steward already saw it: nothing new for it.
  expect(r.widenings.some((x) => x.agent === "steward")).toBe(false);
});

test("audit: narrowing, new notes and the owner's own note edits never alert", () => {
  const root = makeBrain();
  auditCarve(root);
  edit(root, "rules/policy.yaml", HELPER, "helper: { tier: trial, slices: [area:work]");
  commit(root, OWNER);
  writeFileSync(join(root, "projects", "course-c.md"), readFileSync(join(root, "projects", "course-b.md"), "utf8").replace("projects/course-b", "projects/course-c"));
  commit(root, "planner", "planner: new note");
  edit(root, "people/paul-advisor.md", "tags: [finance]\n", "");
  commit(root, OWNER);
  const r = auditCarve(root);
  expect(r.widenings.filter((x) => !x.ok)).toEqual([]);
  expect(alerts(root)).toEqual([]);
});

test("audit: without a saved snapshot, the baseline is the brain as committed a week ago (or its first commit)", () => {
  const root = makeBrain();
  edit(root, "rules/policy.yaml", HELPER, "helper: { tier: trial, slices: [area:work, area:personal, contacts-basic]");
  commit(root, "helper", "helper: more");
  const r = auditCarve(root);
  expect(r.baseline).toBe("git");
  expect(r.widenings.find((x) => x.what === "slices +area:personal")?.ok).toBe(false);
  expect(r.alerts).toBe(1);
});

test("audit: a new agent the owner added is reported, one an agent added is an alert", () => {
  const root = makeBrain();
  auditCarve(root);
  edit(root, "rules/policy.yaml", "tiers:", "  intruder: { tier: trial, slices: [area:work] }\ntiers:");
  commit(root, "steward");
  const r = auditCarve(root);
  expect(r.widenings.find((x) => x.agent === "intruder")?.what).toBe("new agent");
  expect(r.widenings.find((x) => x.agent === "intruder")?.ok).toBe(false);
});

test("audit: runs weekly from start (Sundays after the night hour) and shows in the digest", () => {
  const root = makeBrain();
  expect(dueJobs(root, toronto(10, 9, 0))).toEqual(["night", "digest"]); // Saturday
  expect(dueJobs(root, toronto(11, 3, 5))).toEqual(["night", "audit"]); // Sunday
  expect(dueJobs(root, toronto(11, 9, 0))).toEqual(["digest"]);
  auditCarve(root);
  edit(root, "rules/policy.yaml", HELPER, "helper: { tier: trial, slices: [all]");
  commit(root, "helper");
  auditCarve(root);
  const d = digest(root).text;
  expect(d).toContain("**Alert** (carve_widened): helper");
  expect(d).toMatch(/Carve audit .*: \d+ widening\(s\), [1-9]\d* not by you/);
});

// The owner's own hand commits carry the brain repo's git identity (their user.name, such as a
// GitHub handle), not "owner": a widening they make by hand isn't someone else's (G376).
test("audit: a widening the owner commits by hand, under the brain repo's git user.name, is no alert", () => {
  const root = makeBrain();
  git(root, ["config", "user.name", "handle1990"]);
  auditCarve(root);
  edit(root, "rules/policy.yaml", HELPER, "helper: { tier: trial, slices: [area:work, area:personal, contacts-basic]");
  commit(root, "handle1990", "owner: helper gets personal");
  const r = auditCarve(root);
  expect(r.widenings.filter((x) => x.agent === "helper").every((x) => x.ok)).toBe(true);
  expect(alerts(root)).toEqual([]);
  // Any other name is still not the owner, and an agent's name never is, whatever user.name says.
  edit(root, "rules/policy.yaml", "helper: { tier: trial, slices: [area:work, area:personal", "helper: { tier: core, slices: [area:work, area:personal");
  commit(root, "someone-else", "tier");
  expect(auditCarve(root).alerts).toBe(1);
  git(root, ["config", "user.name", "planner"]);
  edit(root, "people/paul-advisor.md", "tags: [finance]\n", "");
  commit(root, "planner", "planner: tags");
  expect(auditCarve(root).widenings.some((x) => !x.ok && x.causes.some((c) => c.author === "planner"))).toBe(true);
});
