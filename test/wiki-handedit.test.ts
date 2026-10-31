// SPDX-License-Identifier: AGPL-3.0-only
// Wiki slice 7 (docs/wiki.md): an agent can tell a person went in. A note edited in a text editor
// and saved without a commit is adopted as the owner's (Kind: hand-edit); one carrying a secret is
// held, never committed and never reverted; a commit by a person outside the hub reads as the
// owner's in whats_new; the digest names a held edit.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { adoptHandEdits, isPersonAuthor } from "../src/wiki";
import { whatsNew } from "../src/core";
import { loadRules } from "../src/rules";
import { digest } from "../src/digest";
import { git } from "../src/git";

const edit = (root: string, rel: string, from: string, to: string) => { const f = join(root, rel); writeFileSync(f, readFileSync(f, "utf8").replace(from, to)); };
const status = (root: string) => git(root, ["status", "--porcelain"]).split("\n").filter(Boolean);

test("an uncommitted hand edit is committed as the owner's, Kind: hand-edit, naming the files", () => {
  const root = makeBrain();
  edit(root, "people/jane-roy.md", "Her number is in the phones fact.", "Her number is in the phones fact. Met her at the fair.");
  const r = adoptHandEdits(root);
  expect(r).toEqual({ adopted: ["people/jane-roy.md"], held: [] });
  expect(status(root)).toEqual([]);
  const msg = git(root, ["log", "-1", "--format=%an|%B"]);
  expect(msg).toStartWith("Robin|owner: hand edits");
  expect(msg).toContain("Kind: hand-edit");
  expect(msg).toContain("Files: people/jane-roy.md");
  expect(adoptHandEdits(root)).toEqual({ adopted: [], held: [] });
});

test("a hand edit carrying a secret, or one that doesn't parse, is held: kept on disk, never committed", () => {
  const root = makeBrain();
  edit(root, "people/jane-roy.md", "Her number is in the phones fact.", "Wifi password: hunter22-ok.");
  edit(root, "projects/course-a.md", "type: project", "type: [project");
  edit(root, "projects/course-b.md", "Course B", "Course Bee");
  const r = adoptHandEdits(root);
  expect(r.adopted).toEqual(["projects/course-b.md"]);
  expect(r.held.map((h) => h.path).sort()).toEqual(["people/jane-roy.md", "projects/course-a.md"]);
  expect(r.held.find((h) => h.path === "people/jane-roy.md")!.why).toContain("password");
  expect(readFileSync(join(root, "people/jane-roy.md"), "utf8")).toContain("hunter22-ok");
  expect(git(root, ["log", "-p", "--format=%s"])).not.toContain("hunter22-ok");
  // The digest tells the owner, without the secret. (A note that doesn't parse stops every load,
  // as before this slice, so it is fixed first.)
  edit(root, "projects/course-a.md", "type: [project", "type: project");
  const d = digest(root).text;
  expect(d).toContain("people/jane-roy.md");
  expect(d).not.toContain("hunter22");
});

test("a commit by a person outside the hub reads as the owner's to agents; an agent's or the hub's does not", () => {
  const root = makeBrain();
  const rules = loadRules(root);
  expect(isPersonAuthor("Robin Example", rules)).toBe(true);
  expect(isPersonAuthor("planner", rules)).toBe(false);
  expect(isPersonAuthor("reflect", rules)).toBe(false);
  edit(root, "projects/course-a.md", "next_step: { value: Grade the midterm,", "next_step: { value: Grade the final,");
  Bun.spawnSync(["git", "commit", "-qam", "tidy"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Robin Example", GIT_AUTHOR_EMAIL: "r@x", GIT_COMMITTER_NAME: "Robin Example", GIT_COMMITTER_EMAIL: "r@x" } });
  const w = whatsNew(root, "planner", "2026-01-01T00:00:00Z");
  expect(w.changes.find((c) => c.id === "projects/course-a")?.by).toBe("owner");
});

// Slice audit of the wiki branch (F1): who wrote a commit is read from its address, never from
// whether its author is still an agent, so removing an agent never makes its writes the owner's,
// and a hub job named nowhere (the aftercheck's "gardener") reads as an assistant.
test("an agent's commit stays an assistant's after the agent is removed; a hub job's too", () => {
  const root = makeBrain();
  edit(root, "projects/course-a.md", "next_step: { value: Grade the midterm,", "next_step: { value: Grade the final,");
  git(root, ["commit", "-qam", "planner: next step"], "planner");
  const by = () => whatsNew(root, "steward", "2026-01-01T00:00:00Z").changes.find((c) => c.id === "projects/course-a")?.by;
  expect(by()).toBe("an assistant");
  const f = join(root, "rules", "policy.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^  planner:.*\n/m, ""));
  git(root, ["commit", "-qm", "owner: remove planner", "--", "rules/policy.yaml"], "owner");
  expect(loadRules(root).policy.agents.planner).toBeUndefined();
  expect(by()).toBe("an assistant");
  edit(root, "projects/course-a.md", "Grade the final,", "Grade the finals,");
  git(root, ["commit", "-qam", "aftercheck fix"], "gardener-bot");
  expect(by()).toBe("an assistant");
});
