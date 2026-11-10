// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13 slice audit, medium (G765): a next_* fact served from the calendar is put on the note
// after the agent's cell was built, so with cells on its event title skipped the scrub the cell had
// already done: a title holding a carved value ("… with <bank>") was served whole on read and in a
// pack. The served value is now scrubbed against the agent's own carve of the brain on both paths.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { readNote, contextPack } from "../src/core";
import { pullSource } from "../src/pull";
import { useCells, buildCells, cellsOn } from "../src/cell";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();

async function brain() {
  const root = makeBrain();
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("value: Grade the midterm, as_of: 2026-10-01", "value: Grade the midterm by 2026-10-05, as_of: 2026-10-01"));
  // money/main-bank holds "Maple Trust Bank": out of helper's view, in steward's.
  writeFileSync(join(root, "cal.json"), JSON.stringify([{ id: "next1", etag: '"2"', status: "confirmed", summary: "Course A fees with Maple Trust Bank", start: { dateTime: "2026-10-14T18:30:00-04:00" }, location: "Room 12" }]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "cal.json", upcoming: true } } }));
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "louis: calendar");
  return root;
}
const got = (root: string, agent: string) => `${JSON.stringify(readNote(root, agent, "projects/course-a"))}\n${contextPack(root, agent, "Course A")}\n${contextPack(root, agent, "what is next this week?")}`;

for (const cells of [false, true]) {
  test(`G765 an event title holding a carved value is withheld in the served next step (cells ${cells ? "on" : "off"})`, async () => {
    const was = cellsOn();
    const root = await brain();
    try {
      useCells(cells);
      if (cells) buildCells(root);
      await pullSource(root, "cal", { model: null });
      const helper = got(root, "helper");
      expect(helper).toContain("2026-10-14 18:30");
      expect(helper).toContain("(from the calendar)");
      expect(helper).not.toContain("Maple Trust");
      expect(got(root, "steward")).toContain("Course A fees with Maple Trust Bank, 2026-10-14 18:30, Room 12 (from the calendar)");
    } finally { useCells(was); }
  });
}
