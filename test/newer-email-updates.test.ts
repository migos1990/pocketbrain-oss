// SPDX-License-Identifier: AGPL-3.0-only
// The 500-fact demo brain, 2026-10-30: once the hub found an older email's value in that email
// (verified-by-source), every newer email about the same fact opened a conflict, since verified
// outranks an exact source, though the filing tick had called it an update (the same kind of
// source, newer). A newer email the tick files is the fact changing over time: it updates, the old
// value goes to history. An older email, or an assistant's own newer claim, weighs as before (G513).
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { runAuto } from "../src/filing";
import { loadBrain, type FactRecord } from "../src/brain";

const NOW = new Date("2026-10-28T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const jane = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;

// A mail the hub pulled, waiting for the filing tick as a capture's proposal.
function pulled(as_of: string): string {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", "m.md"), "Jane is now program director.\n");
  writeFileSync(join(root, "inbox", `${as_of}-capture-m1.yaml`), YAML.stringify({ proposed: as_of, by: "steward", reason: "capture inbox/captures/m.md: a new value", checks: ["capture"], capture: "inbox/captures/m.md", request: { agent: "steward", kind: "fact", id: "people/jane-roy", attribute: "role", value: "Program director", as_of, sources: ["gmail:f000000000000012"], verification: "self-reported" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "capture: stored");
  return root;
}

test("a newer email the filing tick files updates a fact an older, verified email gave", () => {
  const root = pulled("2026-09-12");
  expect((jane(root).fm.facts!.role as FactRecord).verification).toBe("verified-by-source");
  expect(runAuto(root, NOW).map((d) => d.picked)).toEqual(["saved it"]);
  expect((jane(root).fm.facts!.role as FactRecord).value).toBe("Program director");
  expect((jane(root).fm.history!.role as FactRecord[]).some((h) => h.value === "Course coordinator")).toBe(true);
  expect(loadBrain(root).filter((n) => n.fm.type === "dispute")).toHaveLength(0);
});

test("an older email than the verified one still doesn't replace it", () => {
  const root = pulled("2026-08-20");
  runAuto(root, NOW);
  expect((jane(root).fm.facts!.role as { value?: unknown }).value).toBe("Course coordinator");
});

test("an assistant's own newer claim against a verified value is still a conflict", () => {
  const root = makeBrain();
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "Program director", as_of: "2026-09-12", sources: ["gmail:f000000000000012"], verification: "self-reported" } as never);
  expect(r.outcome).toBe("disputed");
});
