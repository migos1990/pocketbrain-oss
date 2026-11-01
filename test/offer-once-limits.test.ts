// SPDX-License-Identifier: AGPL-3.0-only
// Audit v7, medium (G555): Just this one rendered the offered page through a one-off carve with no
// leave-outs, so a fact the owner kept from that assistant by name reached it; and its ceiling came
// from the page alone, so a private page went to a trial assistant whose own ceiling is personal.
// The owner's offer keeps every fact the assistant's own grant leaves out by name, and never goes
// past that assistant's own ceiling.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";
import { contextPack } from "../src/core";
import { offerOnce, mayOffer } from "../src/asks";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ID = "projects/product-discovery-course";
const SHARED = /^## .+ let you read one page, once/m;
const edit = (root: string, rel: string, f: (s: string) => string) => writeFileSync(join(root, rel), f(readFileSync(join(root, rel), "utf8")));

test("a fact kept from the assistant by name stays out of the page it is offered once (G555)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    edit(root, "rules/policy.yaml", (s) => s.replace(/(  gemini: \{[^}]*exclude_types: \[money\])/, `$1, exclude: ["${ID}#status"]`));
    expect(loadRules(root).policy.agents.gemini!.exclude).toEqual([`${ID}#status`]);
    offerOnce(root, "gemini", ID);
    const pack = contextPack(root, "gemini", "anything");
    expect(pack).toMatch(SHARED);
    expect(pack).toContain("return the midterm reflections");
    expect(pack).not.toContain("week 6 of 13");
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("a private page is never offered to an assistant whose own ceiling is below private (G555)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    edit(root, `${ID}.md`, (s) => s.replace(/^sensitivity: \w+$/m, "sensitivity: private"));
    const rules = loadRules(root), note = loadBrain(root).find((n) => n.fm.id === ID)!;
    expect(mayOffer(rules, "gemini", note)).toBe(false);
    expect(() => offerOnce(root, "gemini", ID)).toThrow();
    expect(contextPack(root, "gemini", "anything")).not.toMatch(SHARED);
  } finally { delete process.env.PB_NOW; }
}, 60_000);

test("an offer made before the page went private delivers nothing to that assistant (G555)", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root } = await makeDemoBrain();
    offerOnce(root, "gemini", ID);
    edit(root, `${ID}.md`, (s) => s.replace(/^sensitivity: \w+$/m, "sensitivity: private"));
    expect(contextPack(root, "gemini", "anything")).not.toMatch(SHARED);
  } finally { delete process.env.PB_NOW; }
}, 60_000);
