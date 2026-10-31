// SPDX-License-Identifier: AGPL-3.0-only
// Re-audit 2026-10-30 (first audit's high finding, still reproduced on 6e15f79): Undo of a hub save
// put the fact back, but the page's text, written by the page writer after the save, still said
// the undone value. Every reader of the page (the owner on /p, an assistant's read of the body)
// was told what the owner had just said was wrong. Undo now leaves no page text stating it (G527).
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { renderTouchedPages } from "../src/wiki";
import { writeFileSync } from "node:fs";
import YAML from "yaml";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto, undoAuto } from "../src/filing";
import { loadBrain } from "../src/brain";

const page = (root: string) => readFileSync(join(root, "people", "jane-roy.md"), "utf8").split(/^---$/m).slice(2).join("---");

for (const [what, attr, value] of [["a changed value", "role", "Program director"], ["a new fact", "city", "Rimouski"]] as const) {
  test(`Undo of ${what} the hub saved leaves no page text stating it`, () => {
    const root = makeBrain();
    expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: attr, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never, { acceptedBy: "auto-decide" }).outcome).toBe("committed");
    renderTouchedPages(root, "2000-01-01T00:00:00Z");
    expect(page(root)).toContain(value);
    const row = readDiary(root).filter((r) => r.fact_key === `people/jane-roy#${attr}`).at(-1)!;
    expect(undoFact(root, row.undo_token).outcome).toBe("undone");
    expect(page(root)).not.toContain(value);
    // The night's run doesn't bring it back either.
    renderTouchedPages(root, "2000-01-01T00:00:00Z");
    expect(page(root)).not.toContain(value);
  });
}

// The hub's own save from a calendar pull, undone from "Filed for you" (src/filing.ts undoAuto).
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textIn = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textIn(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });

test("Undo of a save the hub filed from a source leaves no page text stating it", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  writeFileSync(join(root, "c.json"), JSON.stringify([{ id: "e1", etag: '"e1"', summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: "Course A (project) schedule_changes: Session 4 moves to Room B-201", updated: "2026-10-07T00:00:00Z", calendar: "primary" }]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: sources");
  await pullSource(root, "cal", { model });
  const [row] = runAuto(root, new Date());
  const course = () => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!;
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  const body = () => readFileSync(join(root, course().path), "utf8").split(/^---$/m).slice(2).join("---");
  expect(body()).toContain("B-201");
  expect(undoAuto(root, row!.key)).toMatch(/Undone/);
  expect(course().fm.facts?.schedule_changes).toBeUndefined();
  expect(body()).not.toContain("B-201");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body()).not.toContain("B-201");
});
