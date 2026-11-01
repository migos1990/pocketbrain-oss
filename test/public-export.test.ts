// SPDX-License-Identifier: AGPL-3.0-only
// The public repo is HEAD minus scripts/public-exclude.txt (scripts/public-export.sh). Nothing
// left in it may link to or import a file that was left out, and every listed path must exist.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const excluded = () => readFileSync(join(ROOT, "scripts", "public-exclude.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT }).stdout.toString().trim().split("\n");
const isOut = (f: string) => excluded().some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));

test("the hackathon film kit is left out of the public repo", () => {
  for (const p of ["docs/video-kit.md", "scripts/film/"]) expect(excluded()).toContain(p);
});

test("every excluded path is a tracked file or folder here, and none is in the public copy", () => {
  // This test ships in the public repo too, which is HEAD minus these paths: there all are missing.
  const missing = excluded().filter((p) => !tracked.some((f) => (p.endsWith("/") ? f.startsWith(p) : f === p)));
  const publicCopy = missing.length === excluded().length;
  expect(publicCopy ? [] : missing).toEqual([]);
  if (publicCopy) expect(existsSync(join(ROOT, ".github", "workflows", "public-sync.yml"))).toBe(false);
});

test("nothing kept links to or imports an excluded file", () => {
  const out = excluded();
  const bad: string[] = [];
  for (const f of tracked.filter((f) => !isOut(f) && /\.(md|ts)$/.test(f) && f !== "test/public-export.test.ts")) {
    const text = readFileSync(join(ROOT, f), "utf8");
    const refs = f.endsWith(".md") ? [...text.matchAll(/\]\(([^)\s#]+)/g)].map((m) => m[1]) : [...text.matchAll(/(?:from |import\()\s*"([^"]+)"/g)].map((m) => m[1]);
    for (const r of refs) {
      const p = join(f, "..", r).replace(/^\.\//, "");
      if (out.some((o) => (o.endsWith("/") ? (p + "/").startsWith(o) : p === o || p + ".ts" === o))) bad.push(`${f} -> ${r}`);
    }
  }
  expect(bad).toEqual([]);
});

test("public-export.sh writes HEAD minus the excluded paths and refuses a denylisted term", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-export-"));
  const list = join(dir, "deny.txt");
  writeFileSync(list, `no-file-holds-${crypto.randomUUID()}\n`); // built at run time, so this file never holds it
  const r = Bun.spawnSync(["sh", join(ROOT, "scripts", "public-export.sh"), join(dir, "out"), list]);
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
  expect(existsSync(join(dir, "out", "README.md"))).toBe(true);
  for (const p of excluded()) expect(existsSync(join(dir, "out", p))).toBe(false);
  writeFileSync(list, "AGPL-3.0-only\n");
  const bad = Bun.spawnSync(["sh", join(ROOT, "scripts", "public-export.sh"), join(dir, "out2"), list]);
  expect(bad.exitCode).toBe(1);
});
