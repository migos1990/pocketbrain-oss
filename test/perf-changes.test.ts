// SPDX-License-Identifier: AGPL-3.0-only
// whats_new over a busy stretch of trailer-less commits (hand edits, the text editor) against the
// budget in docs/perf.md: each commit's verdict reads its note's versions, so the reads are batched
// and the verdicts remembered (G231).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import * as core from "../src/core";
import { changeStats } from "../src/core";

test("whats_new over 300 trailer-less commits stays under its budget, and the second ask is cheap", () => {
  const root = makeBrain();
  const files = ["projects/course-a.md", "projects/course-b.md"].map((f) => join(root, f));
  const N = 300, t0 = Date.now() - N * 60_000;
  for (let i = 0; i < N; i++) {
    const f = files[i % 2];
    writeFileSync(f, readFileSync(f, "utf8").replace(/\n---\n[^\n]*/, (m) => m.replace(/ ?\d*$/, "") + " " + i));
    const d = new Date(t0 + i * 60_000).toISOString();
    Bun.spawnSync(["git", "commit", "-qam", `hand ${i}`], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "robin", GIT_AUTHOR_EMAIL: "r@x", GIT_COMMITTER_NAME: "robin", GIT_COMMITTER_EMAIL: "r@x", GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d } });
  }
  const since = new Date(t0 - 60_000).toISOString();
  // Work, not wall-clock, is what's asserted: the machine may be loaded. The reads are one
  // cat-file process for the whole range, and a second ask reads nothing (the verdicts are kept).
  const time = () => { const s = performance.now(), b = changeStats.batches; const r = core.whatsNew(root, "helper", since); return { ms: performance.now() - s, batches: changeStats.batches - b, r }; };
  const first = time(), second = time();
  console.log(`whats_new, ${N} trailer-less commits: first ${Math.round(first.ms)} ms, second ${Math.round(second.ms)} ms`);
  expect(first.batches).toBe(1);
  expect(second.batches).toBe(0);
  expect(JSON.stringify(second.r.changes)).toBe(JSON.stringify(first.r.changes));
  expect(first.ms).toBeLessThan(5000); // loose: only a runaway fails here
});
