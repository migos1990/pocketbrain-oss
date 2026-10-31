// SPDX-License-Identifier: AGPL-3.0-only
// Context size budget (backlog 290): what an agent is handed per call stays under a per-agent
// token budget. Whole notes are dropped by rank, so a kept note keeps its sources, and the lines
// that say what isn't shared stay. Orientation carries the rules: measured, never cut.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { contextPack, whatsNew, orientation } from "../src/core";
import { tokensOf, contextBudget } from "../src/context";
import { loadRules } from "../src/rules";
import { week } from "../src/measure";

function brain(policy: (y: string) => string = (y) => y) {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  writeFileSync(f, policy(readFileSync(f, "utf8")));
  Bun.spawnSync(["git", "commit", "-qam", "budget"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  return root;
}
const reads = (root: string) => readFileSync(join(root, "log", "reads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const withBudget = (b: string) => (y: string) => `context_budget: ${b}\n${y}`;

test("defaults hold for every agent; policy sets them for all, an agent's own entry wins", () => {
  const def = contextBudget(loadRules(makeBrain()), "planner");
  expect(def.context_pack).toBeGreaterThan(0);
  expect(def.whats_new).toBeGreaterThan(0);
  const root = brain((y) => withBudget("{ context_pack: 900, whats_new: 700 }")(y).replace("helper: { tier: trial,", "helper: { tier: trial, context_budget: { context_pack: 400 },"));
  const r = loadRules(root);
  expect(contextBudget(r, "planner").context_pack).toBe(900);
  expect(contextBudget(r, "helper").context_pack).toBe(400);
  expect(contextBudget(r, "helper").whats_new).toBe(700);
  expect(contextBudget(r, "helper").orientation).toBe(def.orientation);
});

test("the whole view is cut to the budget by whole notes; what isn't shared, and every kept note's sources, stay", () => {
  const full = contextPack(makeBrain(), "helper");
  expect(full).not.toMatch(/over your context budget/);
  const root = brain(withBudget("{ context_pack: 340 }"));
  const cut = contextPack(root, "helper");
  expect(tokensOf(cut)).toBeLessThanOrEqual(340);
  expect(tokensOf(cut)).toBeLessThan(tokensOf(full));
  expect(cut).toMatch(/Not shared with you/);
  expect(cut).toMatch(/\d+ notes? over your context budget/);
  // A kept note is whole (its facts with their sources): each block is in the full view as is.
  const kept = cut.split("## Brain")[1].replace(/\n\n\([^\n]*over your context budget[^\n]*\)\n?$/, "").split("\n\n### ").slice(1);
  expect(kept.length).toBeGreaterThan(0);
  for (const b of kept) expect(full).toContain(`### ${b.trim()}`);
  const r = reads(root).filter((x) => x.op === "context_pack").at(-1);
  expect(r.tokens).toBe(tokensOf(cut));
  expect(r.cut).toBeGreaterThan(0);
});

test("a topic pack is cut to the budget and names what it left out, by id, for a read", () => {
  const full = contextPack(makeBrain(), "planner", "course");
  const root = brain(withBudget("{ context_pack: 220 }"));
  const p = contextPack(root, "planner", "course");
  expect(tokensOf(full)).toBeGreaterThan(220);
  expect(tokensOf(p)).toBeLessThanOrEqual(220);
  expect(p).toMatch(/over your context budget/);
  const r = reads(root).filter((x) => x.op === "context_pack").at(-1);
  expect(r.tokens).toBe(tokensOf(p));
});

test("whats_new stops at the budget and counts the rest in more", () => {
  const { setFact } = require("../src/dashboard/edit");
  const changed = (r: string) => { setFact(r, "people/jane-roy", "role", "Department chair"); setFact(r, "projects/course-a", "next_step", "Grade the final"); return r; };
  const root = changed(brain(withBudget("{ whats_new: 100 }")));
  const all = whatsNew(changed(makeBrain()), "planner", "2000-01-01T00:00:00Z");
  expect(all.changes.length).toBeGreaterThan(1);
  const w = whatsNew(root, "planner", "2000-01-01T00:00:00Z");
  expect(w.changes.length).toBeGreaterThanOrEqual(1); // never empty when something changed
  expect(w.changes.length).toBeLessThan(all.changes.length);
  expect(w.more).toBe(all.more + (all.changes.length - w.changes.length));
  const r = reads(root).filter((x) => x.op === "whats_new").at(-1);
  expect(r.ids.length).toBe(w.changes.length);
  expect(r.tokens).toBeGreaterThan(0);
});

test("orientation is measured, never cut: over its budget it is logged as over", () => {
  const root = brain(withBudget("{ orientation: 50 }"));
  const full = orientation(makeBrain(), "planner", "mcp");
  const o = orientation(root, "planner", "mcp");
  expect(JSON.stringify(o)).toBe(JSON.stringify(full));
  const r = reads(root).filter((x) => x.op === "orientation").at(-1);
  expect(r.tokens).toBeGreaterThan(50);
  expect(r.over).toBe(true);
});

test("the week report has each agent's context sizes and how often they were cut", () => {
  const root = brain(withBudget("{ context_pack: 340 }"));
  contextPack(root, "helper");
  contextPack(root, "planner", "course");
  const { text } = week(root, new Date().toISOString().slice(0, 10));
  const sec = text.split("## Context sizes")[1] ?? "";
  expect(sec).toMatch(/helper/);
  expect(sec).toMatch(/planner/);
  expect(sec).toMatch(/cut 1/);
});

test("the whole view ranks by the updated date the agent is shown, so a hidden fact's change can't move a note up (G222)", () => {
  const { renderViewParts } = require("../src/view");
  const { loadBrain, saveNote } = require("../src/brain");
  const { carve, grantFor } = require("../src/carve");
  const root = makeBrain();
  const jane = loadBrain(root).find((n: any) => n.fm.id === "people/jane-roy");
  jane.fm.facts.home_address = { value: "Birch Street 12", as_of: "2026-10-07", sources: ["gmail:f000000000000001"], verification: "verified-by-source", by: "steward", recorded: "2026-10-07", share_with: ["steward"] };
  jane.fm.updated = "2026-10-07";
  saveNote(root, jane);
  const notes = loadBrain(root), rules = loadRules(root);
  const parts = renderViewParts(notes, rules, carve(notes, rules, grantFor(rules, "helper")), root);
  const j = parts.notes.find((n: any) => n.id === "people/jane-roy");
  expect(j.updated).not.toBe("2026-10-07");
  expect(j.text).toContain(`updated ${j.updated}`);
});

test("the pasted view file is held to the same budget; its manifest lists only the notes in it (backlog 311)", () => {
  const { buildView } = require("../src/view");
  const { loadBrain } = require("../src/brain");
  const { carve, grantFor } = require("../src/carve");
  const build = (root: string) => { const notes = loadBrain(root), rules = loadRules(root); const b = buildView(notes, rules, carve(notes, rules, grantFor(rules, "helper")), root); return { md: readFileSync(b.file, "utf8"), m: JSON.parse(readFileSync(join(root, "views", "helper.manifest.json"), "utf8")) }; };
  const full = build(makeBrain());
  expect(full.md).not.toMatch(/over your context budget/);
  expect(full.m.left_out).toBeUndefined();
  const cut = build(brain(withBudget("{ context_pack: 340 }")));
  expect(tokensOf(cut.md)).toBeLessThanOrEqual(340);
  expect(cut.md).toMatch(/Not shared with you/);
  expect(cut.md).toMatch(/over your context budget of 340 tokens/);
  expect(cut.m.left_out).toBeGreaterThan(0);
  expect(cut.m.notes.length + cut.m.left_out).toBe(full.m.notes.length);
  for (const id of cut.m.notes) expect(cut.md).toContain(id);
  for (const f of cut.m.facts) expect(cut.m.notes).toContain(f.split("#")[0]);
});
