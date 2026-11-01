// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10 second report (Medium, G613): scripts/check-public.sh said "clean" for an empty
// denylist (grep -f with no patterns matches nothing) and for one saved with Windows line endings
// (each term ended in \r and never matched). It now reads the list without \r and blank lines, and
// refuses a list with no term in it.
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const run = (list: string) => {
  const f = join(mkdtempSync(join(tmpdir(), "pb-deny-")), "deny.txt");
  writeFileSync(f, list);
  const r = Bun.spawnSync(["sh", join(ROOT, "scripts", "check-public.sh"), f], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: `${r.stdout}${r.stderr}` };
};

test("an empty denylist, or one of blank lines, is refused, never called clean", () => {
  expect(run("").code).not.toBe(0);
  expect(run("\n\r\n  \n").code).not.toBe(0);
});

test("a denylist with Windows line endings still finds its terms", () => {
  // A term every tracked code file holds.
  const r = run("SPDX-License-Identifier\r\n");
  expect(r.code).toBe(1);
  expect(r.out).toContain("personal terms found");
});

test("a term no tracked file holds is clean", () => {
  // Made up here, so not even this file holds it.
  expect(run(`zq${crypto.randomUUID().replace(/-/g, "")}\n`).code).toBe(0);
});

test("a term keeps the spaces around it, so a word padded with spaces never matches inside other words", () => {
  // Every SPDX line holds this word, but always after a hyphen, never between spaces. Built here so
  // this file doesn't hold the padded term either.
  const word = ["License", "Identifier"].join("-");
  expect(run(`${word}\r\n`).code).toBe(1);
  expect(run(` ${word} \r\n`).code).toBe(0);
});
