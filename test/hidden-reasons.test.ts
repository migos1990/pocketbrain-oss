// SPDX-License-Identifier: AGPL-3.0-only
// An assistant's reason that reads like health, money or legal is behind Show it on the deck
// (G402); the digest file and the text channel kept it, or the value it explains, in plain sight.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { digest } from "../src/digest";
import { openItems } from "../src/textline/items";

function brain(reason: string) {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-07-gardener-s1.yaml"), YAML.stringify({ proposed: "2026-10-07", by: "gardener", reason,
    request: { agent: "gardener", kind: "fact", id: "projects/course-a", attribute: "notes", value: "Sensitivity looks wrong; review it", as_of: "2026-10-07", sources: ["agent:gardener"], source_type: "agent_observation", confidence: "stated" } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "gardener"]);
  return root;
}
const SENSITIVE = "A student's insurance claim for a diagnosis sits in this course note; it should be private";

test("the digest withholds an assistant's sensitive reason and the value it explains", () => {
  const { text } = digest(brain(SENSITIVE));
  const line = text.split("\n").find((l) => l.includes("gardener-s1"))!;
  expect(line).toBeTruthy();
  expect(line).not.toMatch(/insurance|diagnosis|Sensitivity looks wrong/);
  expect(line).toContain("reads like health, money or legal");
});

test("the text channel sends an assistant's sensitive proposal as private, without its value", () => {
  const it = openItems(brain(SENSITIVE)).find((i) => i.ref === "2026-10-07-gardener-s1.yaml")!;
  expect(it.private).toBe(true);
  expect(it.title).not.toMatch(/Sensitivity looks wrong|insurance|diagnosis/);
});

test("an ordinary reason still shows in both", () => {
  const root = brain("The course note has two next steps that disagree");
  expect(digest(root).text).toContain("two next steps that disagree");
  const it = openItems(root).find((i) => i.ref === "2026-10-07-gardener-s1.yaml")!;
  expect([it.private, it.title]).toEqual([false, expect.stringContaining("Sensitivity looks wrong")]);
});
