// SPDX-License-Identifier: AGPL-3.0-only
// Mac use-it, 2026-10-27: typing a new value in the box for a fact with a conflict waiting beside it
// (contested, G425) replaced the live value and said Noted, while the conflict kept asking about
// the old sides. The owner's typed word outranks every source, so it settles that conflict.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { write } from "../src/write";
import { ownerConflicts } from "../src/core";
import { ownerSay } from "../src/owner-say";
import { readDiary } from "../src/diary";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-07, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  return root;
}
const room = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.room as FactRecord & { contested?: string };

test("the owner's typed value on a contested fact settles its conflict and says so", () => {
  const root = brain();
  const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "room", value: "C-305", as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.outcome).toBe("disputed");
  expect(ownerConflicts(root, undefined, { held: true })).toHaveLength(1);
  const reply = ownerSay(root, "Course C's room is D-110");
  expect(reply.kind).toBe("say.settled");
  expect(reply.text).toContain("D-110");
  expect(reply.text).not.toContain("Noted");
  expect(room(root).value).toBe("D-110");
  expect(room(root).contested).toBeUndefined();
  expect(ownerConflicts(root, undefined, { held: true })).toHaveLength(0);
  // The diary has the line, with an Undo.
  expect(readDiary(root).at(-1)?.fact_key).toBe("projects/course-c#room");
  expect(reply.undo_token).toBeTruthy();
});
