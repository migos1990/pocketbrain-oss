// SPDX-License-Identifier: AGPL-3.0-only
// A year of growth (backlog #228): hub logs rotate, the brain's git packs at night and never
// during an agent's write, and a .git past its budget becomes a failing job the probe reports.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { rotateHubLogs, gcAuto, housekeeping } from "../src/growth";
import { remember } from "../src/core";
import { jobChecks } from "../src/probe";
import { runJob } from "../src/start";

const sh = (root: string, args: string[], stdin?: string) => Bun.spawnSync(["git", "-C", root, "-c", "user.name=owner", "-c", "user.email=o@x", ...args], stdin ? { stdin: Buffer.from(stdin) } : {}).stdout.toString().trim();
const loose = (root: string) => Number(/^count: (\d+)/m.exec(sh(root, ["count-objects", "-v"]))![1]);
// Loose objects git's own gc --auto would pack: about 40 in each of the 256 fan-out folders,
// reachable from a side ref (gc keeps unreachable young objects loose), working tree untouched.
function manyLoose(root: string, n = 12_000) {
  const dir = mkdtempSync(join(tmpdir(), "pb-blobs-"));
  const files = Array.from({ length: n }, (_, i) => { const f = join(dir, `b${i}`); writeFileSync(f, `blob ${i}\n`); return f; });
  const shas: string[] = [];
  for (let i = 0; i < files.length; i += 2000) shas.push(...Bun.spawnSync(["git", "-C", root, "hash-object", "-w", ...files.slice(i, i + 2000)]).stdout.toString().trim().split("\n"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  Bun.spawnSync(["git", "-C", root, "update-index", "--add", "--index-info"], { env, stdin: Buffer.from(shas.map((h, i) => `100644 ${h}\tb/${i}`).join("\n") + "\n") });
  const tree = Bun.spawnSync(["git", "-C", root, "write-tree"], { env }).stdout.toString().trim();
  const commit = sh(root, ["commit-tree", tree, "-m", "test blobs"]);
  sh(root, ["update-ref", "refs/test/blobs", commit]);
}

test("hub logs over the limit rotate in place: the live file keeps its inode, three old copies stay", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-hublogs-"));
  const live = join(dir, "com.pocketbrain.start.log");
  writeFileSync(live, "");
  const ino = statSync(live).ino;
  for (let i = 1; i <= 4; i++) { writeFileSync(live, `run ${i}\n${"x".repeat(2000)}`); expect(rotateHubLogs(dir, { maxBytes: 1000, keep: 3 })).toEqual([live]); }
  expect(statSync(live).ino).toBe(ino); // launchd holds it open for appending
  expect(readFileSync(live, "utf8")).toBe("");
  expect(readdirSync(dir).sort()).toEqual(["com.pocketbrain.start.log", "com.pocketbrain.start.log.1", "com.pocketbrain.start.log.2", "com.pocketbrain.start.log.3"]);
  expect(readFileSync(`${live}.1`, "utf8")).toStartWith("run 4");
  expect(readFileSync(`${live}.3`, "utf8")).toStartWith("run 2");
  writeFileSync(join(dir, "com.pocketbrain.tunnel.log"), "small");
  writeFileSync(join(dir, "someone-else.log"), "y".repeat(5000));
  expect(rotateHubLogs(dir, { maxBytes: 1000, keep: 3 })).toEqual([]);
  expect(statSync(join(dir, "someone-else.log")).size).toBe(5000);
  expect(rotateHubLogs(join(dir, "missing"))).toEqual([]); // not a Mac, or no launchd logs yet
});

test("an agent's write never stops for git's gc; the night's gc packs, with no file or commit changed", () => {
  const root = makeBrain();
  sh(root, ["config", "gc.autoDetach", "false"]); // so git's own gc, if a commit ran it, would finish before the count
  manyLoose(root);
  const before = loose(root);
  const w = remember(root, "planner", { id: "projects/course-a", attribute: "room", value: "B-210", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" });
  expect(w.outcome).toBe("committed");
  expect(loose(root)).toBeGreaterThan(before); // the commit added objects and packed none
  const head = sh(root, ["rev-parse", "HEAD"]), status = sh(root, ["status", "--porcelain"]);
  const r = gcAuto(root);
  expect(r.ok).toBe(true);
  expect(loose(root)).toBeLessThan(1000);
  expect(sh(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(sh(root, ["status", "--porcelain"])).toBe(status);
}, 60_000);

test("housekeeping reports the brain's disk use, and a .git over its budget fails the job the probe watches", async () => {
  const root = makeBrain();
  const logs = mkdtempSync(join(tmpdir(), "pb-hublogs-"));
  const line = housekeeping(root, { logDir: logs });
  expect(line).toMatch(/^housekeeping: \.git \d+(\.\d)? MB, log\/ \d+(\.\d)? MB, hub logs 0 MB/);
  expect(await runJob(root, "housekeeping", () => housekeeping(root, { logDir: logs }))).toStartWith("housekeeping:");
  expect(jobChecks(root).find((c) => c.name === "housekeeping")?.ok).toBe(true);
  const r = await runJob(root, "housekeeping", () => housekeeping(root, { logDir: logs, maxGitMb: 0.001 }));
  expect(r).toMatch(/housekeeping failed: the brain's \.git is .* MB, over its budget of 0.001 MB/);
  expect(jobChecks(root).find((c) => c.name === "housekeeping")).toMatchObject({ ok: false });
});
