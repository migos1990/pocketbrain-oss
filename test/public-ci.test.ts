// SPDX-License-Identifier: AGPL-3.0-only
// The public repo runs this same ci.yml on its own history (one commit per export, other shas), so
// CI must not lean on anything only the private repo has. This test ships in the public copy too.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const excluded = readFileSync(join(ROOT, "scripts", "public-exclude.txt"), "utf8")
  .split("\n").filter((l) => l && !l.startsWith("#"));

test("the typecheck of the public copy doesn't need a file the export leaves out", () => {
  // A triple-slash lib reference applies to the whole program: scripts/film/take.ts once gave every
  // test the DOM types, so the public copy (without it) failed `bun run typecheck` 94 times.
  const lib = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")).compilerOptions.lib as string[];
  expect(lib.map((l) => l.toLowerCase())).toContain("dom");
  const out = Bun.spawnSync(["git", "grep", "-lE", "^/// <reference (lib|types|path)=|^declare global", "--", ...excluded], { cwd: ROOT });
  const carriers = out.stdout.toString().trim().split("\n").filter(Boolean);
  const harmless = carriers.filter((f) => /reference lib="dom"/.test(readFileSync(join(ROOT, f), "utf8")));
  expect(carriers.filter((f) => !harmless.includes(f))).toEqual([]);
});

test("in the public repo the secret scan checks the tree, since .gitleaksignore fingerprints carry private shas", () => {
  const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
  const step = ci.slice(ci.indexOf("- name: gitleaks"), ci.indexOf("- name: personal-term denylist"));
  expect(step).toContain("github.event.repository.name");
  expect(step).toContain("pocketbrain-oss");
  expect(step).toMatch(/gitleaks dir [^\n]*-r [^\n]*\n\s*bun scripts\/public-sync\.ts leaks/);
  expect(step).toMatch(/else\n\s*\/tmp\/gitleaks git --no-banner --redact \./);
  // the leaks check needs bun before it
  expect(ci.indexOf("oven-sh/setup-bun")).toBeLessThan(ci.indexOf("- name: gitleaks"));
});
