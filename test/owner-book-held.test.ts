// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13 slice audit, medium (G766): the owner's own page, eleven minutes after sign-in, showed a
// held value in its week that the home, Memory and Who knows hide. The book filtered facts by their
// sensitivity only; a value still `unseen` (an assistant's health-, money- or legal-shaped value the
// owner hasn't opened yet, src/seen.ts) is the owner's after a fresh sign-in only, like a private one.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { ownerBook } from "../src/dashboard/owner-book";

test("G766 a held value is in the owner's week only on a fresh sign-in", () => {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: "physio appointment for the knee on 10 October", unseen: true, as_of: 2026-10-07, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=planner", "-c", "user.email=p@x", "commit", "-qm", "planner: course c"], { cwd: root });
  const was = process.env.PB_NOW;
  process.env.PB_NOW = "2026-10-08T14:00:00Z";
  try {
  const lines = (fresh: boolean) => { const w = ownerBook(loadState(root), fresh).week; return [...w.past, ...w.days.flatMap((d) => d.lines), ...w.later, ...w.next].map((l) => `${l.page}: ${l.what}`).join("\n"); };
  expect(lines(false)).not.toContain("physio");
  expect(lines(true)).toContain("projects/course-c: physio appointment for the knee on 10 October");
  } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
});
