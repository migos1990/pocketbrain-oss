// SPDX-License-Identifier: AGPL-3.0-only
// The dependency gate before the public push: licenses, a frozen lockfile, advisories, an SBOM.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowed, installed, licenseProblems, lockProblems, runtime, sbom } from "../scripts/deps.ts";

const ROOT = join(import.meta.dir, "..");

function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "pb-deps-"));
  const pkg = (dir: string, j: object) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "package.json"), JSON.stringify(j)); };
  pkg(root, { name: "app", version: "1.0.0", license: "AGPL-3.0-only", dependencies: { a: "^1" }, devDependencies: { tool: "^1" } });
  pkg(join(root, "node_modules/a"), { name: "a", version: "1.2.0", license: "MIT", dependencies: { "@s/b": "^2" } });
  pkg(join(root, "node_modules/@s/b"), { name: "@s/b", version: "2.0.0", license: "(MIT OR GPL-2.0-only)", dependencies: { c: "^1" } });
  pkg(join(root, "node_modules/@s/b/node_modules/c"), { name: "c", version: "1.0.0", licenses: [{ type: "ISC" }] });
  pkg(join(root, "node_modules/c"), { name: "c", version: "9.9.9", license: "GPL-2.0-only" });
  pkg(join(root, "node_modules/tool"), { name: "tool", version: "1.0.0" });
  pkg(join(root, "node_modules/a/vendor/inner"), { name: "inner", version: "0.0.1", license: "SSPL-1.0" });
  return root;
}

test("an SPDX expression passes when every AND part does and one side of each OR does", () => {
  expect(allowed("MIT")).toBe(true);
  expect(allowed("(MIT OR GPL-2.0-only)")).toBe(true);
  expect(allowed("MIT AND GPL-2.0-only")).toBe(false);
  expect(allowed("(Apache-2.0 AND (MIT OR SSPL-1.0))")).toBe(true);
  expect(allowed("GPL-2.0-only")).toBe(false);
  expect(allowed("GPL-2.0+")).toBe(true);
  expect(allowed("Apache-2.0 WITH LLVM-exception")).toBe(true);
  for (const bad of ["", "UNLICENSED", "SEE LICENSE IN LICENSE.md", "SSPL-1.0", "BUSL-1.1", "(MIT", "MIT OR"]) expect(allowed(bad)).toBe(false);
});

test("every installed package is found, nested ones too, but not a package.json inside a package", () => {
  const got = installed(fakeRepo()).map((p) => `${p.name}@${p.version} ${p.license}`);
  expect(got).toEqual(["@s/b@2.0.0 (MIT OR GPL-2.0-only)", "a@1.2.0 MIT", "c@1.0.0 ISC", "c@9.9.9 GPL-2.0-only", "tool@1.0.0 "]);
});

test("a package off the list or with no license fails, and a hand review covers only the version read", () => {
  const pkgs = installed(fakeRepo());
  expect(licenseProblems(pkgs, {})).toEqual(["c@9.9.9: GPL-2.0-only", "tool@1.0.0: no license field"]);
  const reviewed = { tool: { version: "1.0.0", license: "", why: "LICENSE file is MIT" }, c: { version: "9.9.8", license: "GPL-2.0-only", why: "old" } };
  expect(licenseProblems(pkgs, reviewed)).toEqual(["c@9.9.9: GPL-2.0-only (reviewed for another version; read it again)"]);
});

test("the SBOM lists what the package pulls in at run time, resolved like Node, without dev tools", () => {
  const root = fakeRepo();
  expect(runtime(root).map((p) => `${p.name}@${p.version}`)).toEqual(["@s/b@2.0.0", "a@1.2.0", "c@1.0.0"]);
  const s = sbom(root) as { bomFormat: string; metadata: { component: { purl: string } }; components: { purl: string; licenses: unknown[] }[]; dependencies: { ref: string; dependsOn: string[] }[] };
  expect(s.bomFormat).toBe("CycloneDX");
  expect(s.metadata.component.purl).toBe("pkg:npm/app@1.0.0");
  expect(s.components.map((c) => c.purl)).toEqual(["pkg:npm/%40s/b@2.0.0", "pkg:npm/a@1.2.0", "pkg:npm/c@1.0.0"]);
  expect(s.components[0]!.licenses).toEqual([{ expression: "(MIT OR GPL-2.0-only)" }]);
  expect(s.components[1]!.licenses).toEqual([{ license: { id: "MIT" } }]);
  expect(s.dependencies.find((d) => d.ref === "pkg:npm/a@1.2.0")!.dependsOn).toEqual(["pkg:npm/%40s/b@2.0.0"]);
});

test("a CI install that isn't frozen to bun.lock is caught", () => {
  const root = fakeRepo();
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, "bun.lock"), "{}");
  writeFileSync(join(root, ".github/workflows/ci.yml"), "steps:\n  - run: bun install --frozen-lockfile\n  - run: bun install\n");
  expect(lockProblems(root)).toEqual([".github/workflows/ci.yml:3: bun install without --frozen-lockfile"]);
});

test("this repo passes: its licenses, its lockfile, and its runtime closure in the SBOM", () => {
  expect(licenseProblems(installed(ROOT))).toEqual([]);
  expect(lockProblems(ROOT)).toEqual([]);
  // yaml, and the optional local embedder for semantic search (docs/semantic-search.md) with what it pulls in
  const top = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  expect(Object.keys({ ...top.dependencies, ...top.optionalDependencies })).toEqual(["yaml", "@huggingface/transformers"]);
  expect(runtime(ROOT).map((p) => p.name)).toEqual(expect.arrayContaining(["yaml", "@huggingface/transformers", "onnxruntime-node"]));
});

test("CI runs the license, lock and advisory checks, and each release carries its SBOM", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  expect(ci).toContain("bun scripts/deps.ts licenses");
  expect(ci).toContain("bun scripts/deps.ts lock");
  expect(ci).toMatch(/bun audit --audit-level=high/);
  const rel = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  expect(rel).toContain("bun scripts/deps.ts sbom > sbom.cdx.json");
  expect(rel).toMatch(/gh release create[^\n]*sbom\.cdx\.json/);
});
