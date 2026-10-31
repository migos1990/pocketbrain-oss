// SPDX-License-Identifier: AGPL-3.0-only
// Audit v4 (2026-10-26 night): "older sources never re-ask" (b0ad0924) worked only for an
// assistant's own write; a capture asked first in fileVerdict ("It changes a value you confirmed"),
// so the spec's own case still landed as a card. The owner-word check is the write path's now: an
// older source goes to history and asks nothing; a newer one is a conflict.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { asked } from "./asked";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const event = (id: string, line: string, updated: string) => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated, calendar: "primary" });
const NOW = new Date();

function brain(ownerAsOf: string) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  const b = join(root, "projects", "course-b.md");
  writeFileSync(b, readFileSync(b, "utf8").replace("by: planner\n---", `by: planner\nfacts:\n  next_step: { value: Write the exam, as_of: ${ownerAsOf}, sources: ["owner:${ownerAsOf}/msg-1"], verification: confirmed-by-owner, by: owner, recorded: ${ownerAsOf} }\n---`));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course b");
  return root;
}
async function pull(root: string, items: unknown[]) {
  writeFileSync(join(root, "c.json"), JSON.stringify(items));
  return pullSource(root, "cal", { model });
}
const nextStep = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-b")!;

test("a capture older than the owner's word files to history and asks nothing", async () => {
  const root = brain("2026-10-10");
  await pull(root, [event("e1", "Course B (project) next_step: Grade the essays", "2026-10-01T09:00:00Z")]);
  const done = runAuto(root, NOW);
  expect(done).toHaveLength(1);
  expect(done[0].picked).toBe("kept your word");
  expect(asked(root, NOW).filter((c) => ["proposal", "dispute"].includes(c.kind))).toEqual([]);
  const n = nextStep(root);
  expect((n.fm.facts!.next_step as FactRecord).value).toBe("Write the exam");
  const hist = (n.fm.history?.next_step ?? []) as FactRecord[];
  expect(hist.map((h) => [h.value, h.ended_by?.step])).toEqual([["Grade the essays", 6]]);
});

test("a capture newer than the owner's word is a conflict for the owner, never a silent change", async () => {
  const root = brain("2026-10-01");
  await pull(root, [event("e1", "Course B (project) next_step: Grade the essays", "2026-10-07T00:00:00Z")]);
  runAuto(root, NOW);
  const cards = asked(root, NOW).filter((c) => ["proposal", "dispute"].includes(c.kind));
  expect(cards.map((c) => c.kind)).toEqual(["dispute"]);
  expect((nextStep(root).fm.facts!.next_step as FactRecord).value).toBe("Write the exam");
});
