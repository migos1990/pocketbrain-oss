// SPDX-License-Identifier: AGPL-3.0-only
// Replaced and stalled decisions stay findable, labelled, and linked both ways (the owner's call,
// 2026-10-08), and sensitivity still applies to each one.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import * as core from "../src/core";
import { upkeep } from "../src/upkeep";
import { loadBrain } from "../src/brain";
import { useCells, buildCells, cellDir } from "../src/cell";

afterEach(() => useCells(false));

const decision = (root: string, id: string, extra: string, title: string, sensitivity = "personal") =>
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: decision\ntitle: ${title}\narea: work\nsensitivity: ${sensitivity}\nstatus: ${extra.includes("status:") ? extra.match(/status: (\w+)/)![1] : "active"}\ncreated: 2026-09-01\nupdated: 2026-09-01\n${extra.replace(/status: \w+\n?/, "")}\n---\n${title}.\n`);

function brain() {
  const root = makeBrain();
  decision(root, "decisions/2026-09-02-room", "status: superseded\nsuperseded_by: decisions/2026-10-01-room", "Course A meets in room 101");
  decision(root, "decisions/2026-10-01-room", "", "Course A moves to room 305");
  decision(root, "decisions/2026-09-20-tutor", "status: stalled\nstalled_on: 2026-09-25", "Hire a tutor for Course A");
  Bun.spawnSync(["git", "-C", root, "add", "-A"]); Bun.spawnSync(["git", "-C", root, "-c", "user.name=owner", "-c", "user.email=o@x", "commit", "-qm", "decisions"]);
  return root;
}

test("an agent finds the old decision, sees it was replaced and by what; upkeep links them both ways", () => {
  const root = brain();
  upkeep(root);
  const fresh = loadBrain(root).find((n) => n.fm.id === "decisions/2026-10-01-room")!;
  expect((fresh.fm as any).supersedes).toBe("decisions/2026-09-02-room");
  const ids = core.search(root, "planner", "room course").map((h) => h.id);
  expect(ids).toContain("decisions/2026-09-02-room");
  expect(ids.indexOf("decisions/2026-10-01-room")).toBeLessThan(ids.indexOf("decisions/2026-09-02-room"));
  const old = core.readNote(root, "planner", "decisions/2026-09-02-room").markdown;
  expect(old).toContain("**Replaced by [[decisions/2026-10-01-room]]. History only: don't act on this decision.**");
  expect(core.readNote(root, "planner", "decisions/2026-10-01-room").markdown).toContain("Replaces [[decisions/2026-09-02-room]].");
  expect(core.readNote(root, "planner", "decisions/2026-09-20-tutor").markdown).toContain("**Stalled since 2026-09-25: not in effect.");
});

test("a replacement the agent can't see is a redacted link, in the view and in its cell", () => {
  const root = brain();
  decision(root, "decisions/2026-10-01-room", "", "Course A moves to room 305", "private"); // above helper's ceiling
  for (const on of [false, true]) {
    useCells(on);
    const md = core.readNote(root, "helper", "decisions/2026-09-02-room").markdown;
    expect(md).toContain("Replaced by [[redacted]]");
    expect(md).not.toContain("2026-10-01-room");
  }
  buildCells(root);
  const cell = readFileSync(join(cellDir(root, "helper"), "decisions/2026-09-02-room.md"), "utf8");
  expect(cell).not.toContain("2026-10-01-room");
});
