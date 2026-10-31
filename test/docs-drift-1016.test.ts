// SPDX-License-Identifier: AGPL-3.0-only
// Docs-drift sweep, 2026-10-16: the claims the guides make about the daily self-check, CI-made
// release tags and the belief radar's quiz budget, pinned to what the code does.
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { selfChecks, selfCheckLine } from "../src/probe";
import * as ms from "../src/memsync";
import { quizPlan } from "../src/quizplan";

const ROOT = join(import.meta.dir, "..");
const doc = (f: string) => readFileSync(join(ROOT, f), "utf8");
const NOW = new Date("2026-10-08T12:00:00Z");
afterEach(() => { delete process.env.PB_LOG_MAX_MB; delete process.env.PB_CONFIG_DIR; delete process.env.PB_NOW; });

test("the logs self-check counts only the files directly in log/, as real-use-bar.md says", () => {
  const root = makeBrain();
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  writeFileSync(join(root, "log", "starts.jsonl"), JSON.stringify({ at: NOW.toISOString() }) + "\n");
  writeFileSync(join(root, "log", "sources", "big.jsonl"), "x".repeat(4096));
  rmSync(join(root, "log", "refs-checked.jsonl")); // the fixture's mailbox; this test sizes log/ itself
  process.env.PB_LOG_MAX_MB = String(1024 / 1_048_576); // 1 KB
  expect(selfChecks(root, NOW).find((c) => c.name === "logs")!.ok).toBe(true);
  writeFileSync(join(root, "log", "big.jsonl"), "x".repeat(4096));
  expect(selfChecks(root, NOW).find((c) => c.name === "logs")!.ok).toBe(false);
  expect(doc("docs/real-use-bar.md")).toContain("Subfolders such as `log/sources/` aren't counted");
});

test("the digest's Self-check line counts every check in probe.json, door and job checks too", () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "probe.json"), JSON.stringify({ door: { ok: false }, night: { ok: true }, disk: { ok: true } }));
  expect(selfCheckLine(root)).toBe("- Self-check: 1 of 3 failing (door); see Needs you");
  const bar = doc("docs/real-use-bar.md");
  expect(bar).toContain("one line for every check the probe last recorded in `log/probe.json`");
  expect(bar).not.toContain("all 9 ok");
});

test("release docs name no file the repo doesn't have, and say CI makes the tag", () => {
  for (const m of doc("docs/release.md").matchAll(/`([\w./-]+\.md)`/g)) expect(existsSync(join(ROOT, "docs", m[1])) || existsSync(join(ROOT, m[1]))).toBe(true);
  const rel = doc("CHANGELOG.md").split("\n").find((l) => l.startsWith("- Releases: `bun scripts/release.ts cut`"))!;
  expect(rel).toContain("makes the tag");
  expect(rel).not.toContain("a pushed tag runs CI");
});

test("the quiz budget counts every question an assistant got, and the nightly pass is held to it only once turned on", () => {
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-"));
  process.env.PB_NOW = NOW.toISOString();
  const root = makeBrain();
  ms.quiz(root, "steward", 3); // what the nightly pass asks with the budget off
  expect(quizPlan(root, { perWeek: 3, now: NOW }).find((p) => p.agent === "steward")!.left).toBe(0);
  const sync = doc("docs/memory-sync.md");
  expect(sync).toContain("until the\nowner turns the budget on");
  expect(sync).toContain("but only `plan --ask` and, once the owner turns it\non (below), the nightly pass are held to it");
  expect(sync).toContain("pocketbrain beliefs plan --json");
  expect(doc("src/quizplan.ts")).not.toContain("memsync run --budget");
});
