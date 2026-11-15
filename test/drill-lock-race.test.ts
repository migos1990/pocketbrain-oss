// SPDX-License-Identifier: AGPL-3.0-only
// G931: the restore drill copied a live .git while a background `git maintenance run --auto`,
// started by the demo brain's own commit, held .git/objects/maintenance.lock. The lock was listed,
// then gone before the copy reached it, and the copy threw ENOENT (CI, PR 202, 2026-11-15).
// At the source: building the demo brain starts no background git. And the copy never takes a
// git lock file, which only marks a git command that is running (or one that died).
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { demoDrillBrain, drillCopyFilter } from "../src/backup";

test("building the demo drill's brain starts no background git maintenance (G931)", () => {
  const work = mkdtempSync(join(tmpdir(), "pb-drill-race-"));
  const trace = join(work, "trace.json");
  const was = process.env.GIT_TRACE2_EVENT;
  process.env.GIT_TRACE2_EVENT = trace;
  try { demoDrillBrain(join(work, "brain")); } finally { if (was === undefined) delete process.env.GIT_TRACE2_EVENT; else process.env.GIT_TRACE2_EVENT = was; }
  expect(existsSync(trace)).toBe(true);
  const children = readFileSync(trace, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; argv?: string[] })
    .filter((e) => e.event === "child_start").map((e) => (e.argv ?? []).join(" "));
  expect(children.filter((a) => /\b(maintenance|gc)\b/.test(a))).toEqual([]);
});

test("the drill's copy of a live brain leaves out git lock files, keeps the rest (G931)", () => {
  const root = "/brain";
  const keep = drillCopyFilter(root);
  for (const p of [".git/objects/maintenance.lock", ".git/index.lock", ".git/HEAD.lock", ".git/refs/heads/main.lock", ".git/packed-refs.lock"])
    expect(keep(join(root, p))).toBe(false);
  for (const p of ["", ".git", ".git/objects", ".git/HEAD", ".git/index", "people/a.lock", "notes/x.md", "log/reads.jsonl"])
    expect(keep(join(root, p))).toBe(true);
  for (const p of ["views", ".cells", "node_modules"]) expect(keep(join(root, p))).toBe(false);
});
