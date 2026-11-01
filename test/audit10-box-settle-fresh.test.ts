// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10, 2026-11-01 (finding 4d, G610): the text box settled a conflict with a private side on
// the 30-day sign-in, which the settle screen's buttons refuse (STALE_OK settle-pick, G553). A typed
// answer on such a conflict needs the same fresh sign-in; a conflict nothing private is on settles
// as before (test/say-settles.test.ts).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { write } from "../src/write";
import { ownerConflicts } from "../src/core";
import { ownerSay } from "../src/owner-say";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function brain(sensitivity: "personal" | "private") {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  room: { value: "B-201", as_of: 2026-10-07, sources: ["gmail:f000000000000041"], verification: verified-by-source, by: planner, recorded: 2026-10-07 }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: course c");
  const r = write(root, { agent: "planner", id: "projects/course-c", attribute: "room", value: "C-305", as_of: "2026-10-07", sources: ["gcal:e1@e1"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", contest: true });
  expect(r.outcome).toBe("disputed");
  // The owner made the live value private after the conflict opened (G583's case): the settle
  // screen hides its sides on the 30-day sign-in.
  if (sensitivity === "private") {
    const f = join(root, "projects", "course-c.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("    contested: c-", "    sensitivity: private\n    contested: c-"));
    sh(root, "git", "commit", "-qam", "owner: room private");
  }
  return root;
}
const room = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.room as FactRecord & { contested?: string };

test("a typed answer on a private conflict on the 30-day sign-in asks for a fresh sign-in and settles nothing", () => {
  const root = brain("private");
  const open = ownerConflicts(root, undefined, { held: true });
  expect(open).toHaveLength(1);
  expect(open[0]!.private).toBe(true);
  const reply = ownerSay(root, "Course C's room is D-110", { fresh: false });
  expect(reply.signin).toBe(true);
  expect(reply.kind).not.toBe("say.settled");
  expect(reply.text).not.toContain("D-110");
  expect(reply.text).not.toContain("C-305");
  expect(ownerConflicts(root, undefined, { held: true })).toHaveLength(1);
  expect(room(root).value).toBe("B-201");
});

test("the same answer right after a sign-in settles it", () => {
  const root = brain("private");
  const reply = ownerSay(root, "Course C's room is D-110", { fresh: true });
  expect(reply.kind).toBe("say.settled");
  expect(ownerConflicts(root, undefined, { held: true })).toHaveLength(0);
  expect(room(root).value).toBe("D-110");
});

test("a conflict nothing private is on still settles from the box on the 30-day sign-in", () => {
  const root = brain("personal");
  const reply = ownerSay(root, "Course C's room is D-110", { fresh: false });
  expect(reply.kind).toBe("say.settled");
  expect(room(root).value).toBe("D-110");
});

test("a sentence that also notes something else says the settle waits for a sign-in, never drops it", () => {
  const root = brain("private");
  const reply = ownerSay(root, "Course C's room is D-110 and Course C's status is active", { fresh: false });
  expect(reply.signin).toBe(true);
  expect(reply.text).toContain("sign in again");
  expect(room(root).value).toBe("B-201");
});
