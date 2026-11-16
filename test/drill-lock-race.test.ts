// SPDX-License-Identifier: AGPL-3.0-only
// G931: the restore drill copied a live .git while a background `git maintenance run --auto`,
// started by the demo brain's own commit, held .git/objects/maintenance.lock. The lock was listed,
// then gone before the copy reached it, and the copy threw ENOENT (CI, PR 202, 2026-11-15).
// At the source: building the demo brain starts no background git. And the copy never takes a
// git lock file, which only marks a git command that is running (or one that died).
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { demoDrillBrain, DRILL_SKIP } from "../src/backup";
import { copyBrain } from "../src/brain-copy";

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

test("the drill's copy of a live brain leaves out git lock files and the hub's caches, keeps the rest (G931, G968)", () => {
  const root = mkdtempSync(join(tmpdir(), "pb-drill-copy-"));
  const all = [".git/objects/maintenance.lock", ".git/index.lock", ".git/HEAD.lock", ".git/refs/heads/main.lock", ".git/packed-refs.lock",
    ".git/HEAD", ".git/index", ".git/objects/ab/cd", "people/a.lock", "notes/x.md", "log/reads.jsonl", "views/a/x.md", ".cells/a/x.md", "node_modules/m/i.js"];
  for (const p of all) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), "x"); }
  const to = join(mkdtempSync(join(tmpdir(), "pb-drill-copy-")), "brain");
  copyBrain(root, to, { skip: DRILL_SKIP });
  for (const p of all) expect(`${p} ${existsSync(join(to, p))}`).toBe(`${p} ${!p.startsWith(".git/") || !p.endsWith(".lock") ? !/^(views|\.cells|node_modules)\//.test(p) : false}`);
});
