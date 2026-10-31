// SPDX-License-Identifier: AGPL-3.0-only
// Audit v4 (2026-10-26 night): 4 of the real brain's asks were the Gardener's proposals from its
// trial tier, stranded once the owner made it a core writer (its new writes file themselves, the
// old ones waited forever as "your own material"). A proposal from the Gardener, once its tier
// writes directly, files the way a capture does: on its page with Undo, or as a conflict.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { runAuto } from "../src/filing";
import { asked } from "./asked";

const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const NOW = new Date();
function brain(tier: "trial" | "core") {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("gardener: { tier: trial,", `gardener: { tier: ${tier},`));
  mkdirSync(join(root, "inbox"), { recursive: true });
  // What the Gardener's remember left in the inbox while it was on trial.
  writeFileSync(join(root, "inbox", "2026-10-06-gardener-1a2b3c4d.yaml"), YAML.stringify({ proposed: "2026-10-06", by: "gardener", reason: "trial tier: proposes", request: { agent: "gardener", kind: "fact", id: "projects/course-b", attribute: "next_step", value: "Book the exam room", as_of: "2026-10-05", sources: ["gmail:f000000000000004"], verification: "verified-by-source" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "owner: setup");
  return root;
}
const proposals = (root: string) => asked(root, NOW).filter((c) => c.kind === "proposal");

test("a stranded Gardener proposal files itself once the Gardener writes directly", () => {
  const root = brain("core");
  const got = runAuto(root, NOW);
  expect(got.map((d) => d.picked)).toEqual(["saved it"]);
  expect(proposals(root)).toEqual([]);
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-b")!.fm.facts!.next_step as FactRecord;
  expect(f.value).toBe("Book the exam room");
});

test("while the Gardener is on trial its proposal still waits for the owner", () => {
  const root = brain("trial");
  expect(runAuto(root, NOW)).toEqual([]);
  expect(proposals(root)).toHaveLength(1);
});
