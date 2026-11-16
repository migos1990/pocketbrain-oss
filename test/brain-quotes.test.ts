// SPDX-License-Identifier: AGPL-3.0-only
// G938 (2026-11-15): a quote of the owner's own page reached the public repo in a test comment and a
// gap's text, and no check reads a brain against the code. scripts/brain-quotes.ts runs on the Mac:
// every 8-word run of a brain page's text, hashed, against the same runs in this repo's tracked
// files. It reports file and line only, never the words, and runs that the fictional brains in
// examples/ share (the hub's own sentence templates) are not counted.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainQuotes, shingles } from "../scripts/brain-quotes";

const ROOT = join(import.meta.dir, "..");

function brainWith(body: string): string {
  const b = mkdtempSync(join(tmpdir(), "pb-bq-brain-"));
  mkdirSync(join(b, "people"), { recursive: true });
  writeFileSync(join(b, "people", "zed.md"), `---\nid: people/zed\ntype: person\ntitle: Zed\n---\n${body}\n`);
  return b;
}

function repoWith(files: Record<string, string>): string {
  const r = mkdtempSync(join(tmpdir(), "pb-bq-repo-"));
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(r, f, ".."), { recursive: true }); writeFileSync(join(r, f), t); }
  Bun.spawnSync(["git", "init", "-q"], { cwd: r });
  Bun.spawnSync(["git", "add", "-A"], { cwd: r });
  return r;
}

// Words made up here, so no file of this repo holds the run.
const secret = () => Array.from({ length: 10 }, () => `w${crypto.randomUUID().slice(0, 6)}`).join(" ");

test("a line that copies eight words of a brain page is reported by file and line, never by its words", () => {
  const words = secret();
  const brain = brainWith(`Some prose. ${words}. More prose.`);
  const repo = repoWith({ "a.txt": "nothing here\n", "test/b.ts": `// line one\n// quoted: ${words}\n` });
  const r = brainQuotes({ brain, repo, examples: [] });
  expect(r.hits).toEqual([{ file: "test/b.ts", line: 2 }]);
  expect(JSON.stringify(r)).not.toContain(words.split(" ")[0]);
});

test("case, punctuation and line breaks don't hide a copy", () => {
  const words = secret().split(" ");
  const brain = brainWith(words.join(" "));
  const repo = repoWith({ "c.md": `${words.slice(0, 4).join(", ").toUpperCase()}\n${words.slice(4).join(" ")}\n` });
  expect(brainQuotes({ brain, repo, examples: [] }).hits).toEqual([{ file: "c.md", line: 1 }]);
});

test("seven words in a row are not a copy", () => {
  const words = secret().split(" ");
  const brain = brainWith(words.join(" "));
  const repo = repoWith({ "d.md": words.slice(0, 7).join(" ") + " other\n" });
  expect(brainQuotes({ brain, repo, examples: [] }).hits).toEqual([]);
});

test("a run the fictional example brains share is the hub's own template, not the owner's data", () => {
  const words = secret();
  const brain = brainWith(words);
  const example = brainWith(`An example page. ${words}.`);
  const repo = repoWith({ "e.ts": `// ${words}\n` });
  expect(brainQuotes({ brain, repo, examples: [example] }).hits).toEqual([]);
});

test("only page text counts: rules, logs and the brain's git folder are not read", () => {
  const words = secret();
  const brain = brainWith("plain page");
  for (const d of ["rules", "log", ".git"]) { mkdirSync(join(brain, d), { recursive: true }); writeFileSync(join(brain, d, "x.md"), words); }
  const repo = repoWith({ "f.md": words + "\n" });
  expect(brainQuotes({ brain, repo, examples: [] }).hits).toEqual([]);
});

test("the example brains themselves are not scanned as repo files", () => {
  expect(shingles("a b c d e f g").length).toBe(0);
  expect(shingles("a b c d e f g h").length).toBe(1);
  // This repo against its own demo brain, with the demo brain as an example: nothing is reported.
  const r = brainQuotes({ brain: join(ROOT, "examples", "brain"), repo: ROOT, examples: [join(ROOT, "examples", "brain")] });
  expect(r.hits).toEqual([]);
});

// Slice audit (2026-11-15): a .md symlink was read through, so a file outside the brain counted,
// and a symlink to a folder crashed the run.
test("a symlink in the brain is never followed", () => {
  const words = secret();
  const outside = join(mkdtempSync(join(tmpdir(), "pb-bq-out-")), "o.md");
  writeFileSync(outside, words);
  const brain = brainWith("plain page");
  symlinkSync(outside, join(brain, "people", "link.md"));
  symlinkSync(join(brain, "people"), join(brain, "people", "loop.md"));
  const repo = repoWith({ "g.md": words + "\n" });
  expect(brainQuotes({ brain, repo, examples: [] }).hits).toEqual([]);
});

test("a repo that isn't a git checkout is an error, never a clean report", () => {
  const notGit = mkdtempSync(join(tmpdir(), "pb-bq-nogit-"));
  expect(() => brainQuotes({ brain: brainWith("x"), repo: notGit, examples: [] })).toThrow();
});
