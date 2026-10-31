// SPDX-License-Identifier: AGPL-3.0-only
// Who knows says whether each assistant read the brain today (Louis, 2026-10-29, G475): the count of
// its context_pack calls since the owner's midnight, so a quiet assistant shows as "not yet". The
// Gardener's night run and a paused assistant are not listed.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { contextPack } from "../src/core";
import { appendChained } from "../src/readlog";
import { homeView } from "../src/dashboard/home";
import { whoPage } from "../src/dashboard/html-app";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";

test("each assistant's reads today, and not yet for one that hasn't", () => {
  const root = makeBrain();
  contextPack(root, "planner", "Course A");
  contextPack(root, "planner");
  // A read from two days ago doesn't count for today.
  appendChained(join(root, "log", "reads.jsonl"), { at: new Date(Date.now() - 2 * 86_400_000).toISOString(), agent: "steward", op: "context_pack", ids: ["*"] });
  const v = homeView(root, loadRules(root), loadBrain(root), new Date());
  expect(v.reads.map(({ agent, name, today }) => ({ agent, name, today }))).toEqual([
    { agent: "helper", name: "helper", today: 0 },
    { agent: "planner", name: "planner", today: 2 },
    { agent: "steward", name: "steward", today: 0 },
  ]);
  const html = whoPage(v, "x");
  expect(html).toContain("<b>planner</b><small>Read your brain 2 times today</small>");
  expect(html).toContain("<b>steward</b><small>Hasn&#39;t read your brain today</small>");
  expect(html).not.toContain("gardener");
});
