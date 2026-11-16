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

// G936 (2026-11-15): the owner's surname could not go on the denylist, because CLA.md must name the
// maintainer, so a quote of his own page carrying his full name reached the public repo. A line
// "<term> @<file>,<file>" now excuses the term in those tracked files only; every other file still fails.
test("a term can be excused in named files, and still fails in every other file", () => {
  // Built here, so this file never holds it; today only CLA.md does.
  const term = ["Contributor", "License"].join(" ");
  expect(run(`${term}\n`).code).toBe(1);
  expect(run(`${term} @CLA.md\n`)).toMatchObject({ code: 0 });
  const elsewhere = run(`${term} @README.md,LICENSE\n`);
  expect(elsewhere.code).toBe(1);
  expect(elsewhere.out).toContain("CLA.md");
  // An excused term never hides a plain term on the next line.
  expect(run(`${term} @CLA.md\nSPDX-License-Identifier\n`).code).toBe(1);
});

test("an excuse names whole paths, never a part of one", () => {
  const term = ["Contributor", "License"].join(" ");
  expect(run(`${term} @CLA\n`).code).toBe(1);
  expect(run(`${term} @LA.md\n`).code).toBe(1);
});

// Slice audit on G936 (2026-11-15): an excuse line with a space in its paths, or a trailing space,
// was read as one plain term that matched nothing, so the term was checked nowhere. Such a line now
// refuses the list.
test("an excuse line with a space in its paths is refused, never read as a term that matches nothing", () => {
  const term = ["Contributor", "License"].join(" ");
  expect(run(`${term} @CLA.md,my file.md\n`).code).toBe(2);
  expect(run(`${term} @CLA.md \n`).code).toBe(2);
});

// Slice audit (2026-11-15): with enough files, xargs splits the grep into batches and answers 123
// when one batch finds nothing, which `if` read as clean. The check now goes by what grep printed.
test("a term in one file of a tree big enough to split xargs is still found", () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-deny-big-"));
  const long = "d".repeat(60);
  for (let i = 0; i < 3000; i++) writeFileSync(join(dir, `${long}-${i}.txt`), "plain\n");
  const word = `zq${crypto.randomUUID().replace(/-/g, "")}`;
  writeFileSync(join(dir, `${long}-1500.txt`), `${word}\n`);
  const f = join(dir, "..", `deny-${crypto.randomUUID()}.txt`);
  writeFileSync(f, `${word}\n`);
  const plain = Bun.spawnSync(["sh", join(ROOT, "scripts", "check-public.sh"), f, dir], { stdout: "pipe", stderr: "pipe" });
  expect(plain.exitCode).toBe(1);
  writeFileSync(f, `${word} @CLA.md\n`);
  const excused = Bun.spawnSync(["sh", join(ROOT, "scripts", "check-public.sh"), f, dir], { stdout: "pipe", stderr: "pipe" });
  expect(excused.exitCode).toBe(1);
});
