// SPDX-License-Identifier: AGPL-3.0-only
// What the public repo (HEAD minus scripts/public-exclude.txt) must hold before any push: a license
// header on every code file, only reserved example domains in addresses, the license files, and
// guides that say "the owner" rather than naming the author's own life. The denylist check
// (scripts/check-public.sh) covers the private terms; this covers what a list can't.
import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const excluded = readFileSync(join(ROOT, "scripts", "public-exclude.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const out = (f: string) => excluded.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
// The tracked files, or (outside a git checkout, as in an exported copy) every file but the
// installed and built ones, so a missing git never makes these checks pass over nothing.
const ls = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT });
const listed = ls.exitCode === 0 ? ls.stdout.toString().trim().split("\n") : walk("");
const files = listed.filter((f) => f && !out(f) && existsSync(join(ROOT, f)));
function walk(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const f = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) return ["node_modules", ".git", "dist"].includes(e.name) ? [] : walk(f);
    return [f];
  });
}

test("the checks below see the repo", () => {
  expect(files.length).toBeGreaterThan(100);
});
const text = (f: string) => readFileSync(join(ROOT, f), "utf8");

// Every code file carries it, the harness hooks included (the owner's word, 2026-10-16).
const NO_HEADER_YET: Record<string, string> = {};

test("every code file carries the license header", () => {
  const missing = files.filter((f) => /\.(ts|tsx|js|mjs|sh)$/.test(f) && !(f in NO_HEADER_YET) && !text(f).split("\n").slice(0, 3).some((l) => l.includes("SPDX-License-Identifier:")));
  expect(missing).toEqual([]);
});

test("addresses use reserved example domains", () => {
  const ok = /@([\w-]+\.)*(example|test|local|invalid|localhost)$|@example\.(com|org|net)$|^noreply@anthropic\.com$|@resource\.calendar\.google\.com$|@users\.noreply\.github\.com$|@x$/i;
  const bad: string[] = [];
  for (const f of files.filter((f) => !f.startsWith("docs/history/") && f !== "CLA.md" && !/\.(lock|png|jpg|mp4|mov|wav)$/.test(f)))
    for (const m of text(f).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g))
      if (!ok.test(m[0]) && !/[{}<>$]/.test(m[0])) bad.push(`${f}: ${m[0]}`);
  expect(bad).toEqual([]);
});

test("the license, contributor agreement and security policy are there", () => {
  expect(text("LICENSE")).toContain("GNU AFFERO GENERAL PUBLIC LICENSE");
  for (const f of ["CLA.md", "SECURITY.md", "CONTRIBUTING.md"]) expect(existsSync(join(ROOT, f))).toBe(true);
  expect(JSON.parse(text("package.json")).license).toBe("AGPL-3.0-only");
});

test("the guides say the owner, not the author's name", () => {
  const guides = files.filter((f) => f === "README.md" || (f.startsWith("docs/") && !f.startsWith("docs/history/") && f.endsWith(".md")));
  const named = guides.filter((f) => /\bLouis\b/.test(text(f).replace(/`[^`\n]*`/g, "")));
  expect(named).toEqual([]);
});
