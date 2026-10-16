// SPDX-License-Identifier: AGPL-3.0-only
// What a kill -9 of the hub can leave behind, and how the next start copes (docs/perf.md,
// "Crash safety"). Each case is the state a crash left in scripts/crash.ts runs.
import { test, expect } from "bun:test";
import { appendFileSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { verifyChain, appendChained } from "../src/readlog";
import { search } from "../src/core";

const base = { agent: "planner", id: "projects/course-a", attribute: "next_step", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const };
const headHas = (root: string, text: string) => Bun.spawnSync(["git", "show", "HEAD:projects/course-a.md"], { cwd: root }).stdout.toString().includes(text);

test("a write log line torn by a crash doesn't stop the next write, and the chain still verifies", () => {
  const root = makeBrain();
  expect(write(root, { ...base, value: "Publish grades" }).outcome).toBe("committed");
  appendFileSync(join(root, "log", "writes.jsonl"), '{"at":"2026-10-08T03:00:00Z","agent":"planner","outc'); // killed mid-append
  const r = write(root, { ...base, value: "Book the exam room", as_of: "2026-10-08" });
  expect(r.outcome).toBe("committed");
  expect(headHas(root, "Book the exam room")).toBe(true);
  expect(verifyChain(join(root, "log", "writes.jsonl")).broken).toBeUndefined();
});

test("a read log line torn by a crash is dropped at the next read, so the chain doesn't read as tampered", () => {
  const root = makeBrain();
  search(root, "planner", "course");
  appendFileSync(join(root, "log", "reads.jsonl"), '{"at":"2026-10-08T03:00:00Z","agent":"pla');
  search(root, "planner", "grades");
  const v = verifyChain(join(root, "log", "reads.jsonl"));
  expect(v.broken).toBeUndefined();
  expect(v.entries).toBe(2);
  appendChained(join(root, "log", "reads.jsonl"), { at: "x", agent: "planner", op: "read", ids: [] });
  expect(verifyChain(join(root, "log", "reads.jsonl")).entries).toBe(3);
});

test("a git lock left by a killed commit is cleared, and the write is committed, not just reported", () => {
  const root = makeBrain();
  writeFileSync(join(root, ".git", "index.lock"), "");
  const old = new Date(Date.now() - 120_000);
  utimesSync(join(root, ".git", "index.lock"), old, old);
  const r = write(root, { ...base, value: "Publish grades" });
  expect(r.outcome).toBe("committed");
  expect(headHas(root, "Publish grades")).toBe(true);
});

test("a ref lock left by a killed commit is cleared too, so the next write still commits", () => {
  const root = makeBrain();
  const branch = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }).stdout.toString().trim();
  const old = new Date(Date.now() - 120_000);
  for (const f of [join(".git", "refs", "heads", `${branch}.lock`), join(".git", "HEAD.lock")]) {
    writeFileSync(join(root, f), "");
    utimesSync(join(root, f), old, old);
  }
  const r = write(root, { ...base, value: "Publish grades" });
  expect(r.outcome).toBe("committed");
  expect(headHas(root, "Publish grades")).toBe(true);
});

test("a commit that can't be made is refused, never reported as committed", () => {
  const root = makeBrain();
  writeFileSync(join(root, ".git", "index.lock"), ""); // fresh: another git command may hold it
  const r = write(root, { ...base, value: "Publish grades" });
  expect(r.outcome).toBe("refused");
  expect(r.message).toMatch(/not saved|git/i);
  expect(headHas(root, "Publish grades")).toBe(false);
  // Nothing half-done is left in the working tree for the next commit to sweep up.
  expect(readFileSync(join(root, "projects", "course-a.md"), "utf8")).not.toContain("Publish grades");
});
