// SPDX-License-Identifier: AGPL-3.0-only
// G938 (2026-11-15): a quote of the owner's own page reached the public repo in a test comment and a
// gap's text, and no check reads a brain against the code. scripts/brain-quotes.ts runs on the Mac:
// every 8-word run of a brain page's text, hashed, against the same runs in this repo's tracked
// files. It reports file and line only, never the words, and runs that the fictional brains in
// examples/ share (the hub's own sentence templates) are not counted.
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainQuotes, freshBrain, shingles } from "../scripts/brain-quotes";

const ROOT = join(import.meta.dir, "..");

function brainWith(body: string): string {
  const b = mkdtempSync(join(tmpdir(), "pb-bq-brain-"));
  mkdirSync(join(b, "people"), { recursive: true });
  writeFileSync(join(b, "people", "zed.md"), `---\nid: people/zed\ntype: person\ntitle: Zed\n---\n${body}\n`);
  return b;
}

function repoWith(files: Record<string, string>, r = mkdtempSync(join(tmpdir(), "pb-bq-repo-"))): string {
  for (const [f, t] of Object.entries(files)) { mkdirSync(join(r, f, ".."), { recursive: true }); writeFileSync(join(r, f), t); }
  Bun.spawnSync(["git", "init", "-q"], { cwd: r });
  Bun.spawnSync(["git", "add", "-A"], { cwd: r });
  return r;
}

const commit = (r: string) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], { cwd: r });

// Words made up here, so no file of this repo holds the run.
const secret = (n = 10) => Array.from({ length: n }, () => `w${crypto.randomUUID().slice(0, 6)}`).join(" ");

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
  for (const d of ["rules", "log", "views", "digest", ".git"]) { mkdirSync(join(brain, d), { recursive: true }); writeFileSync(join(brain, d, "x.md"), words); }
  const repo = repoWith({ "f.md": words + "\n" });
  expect(brainQuotes({ brain, repo, examples: [] }).hits).toEqual([]);
});

test("the example brains themselves are not scanned as repo files", () => {
  expect(shingles("a b c d e f g").length).toBe(0);
  expect(shingles("a b c d e f g h").length).toBe(1);
  // This repo against its own demo brain, with the demo brain as an example: nothing is reported.
  // Without the code's history, which takes seconds on this repo and is tested on its own below.
  const r = brainQuotes({ brain: join(ROOT, "examples", "brain"), repo: ROOT, examples: [join(ROOT, "examples", "brain")], history: false });
  expect(r.hits).toEqual([]);
}, 30_000);

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

// G939 (2026-11-16): on the real brain the report named 426 lines in 156 files, most of them the
// hub's own sentences (src's sentence builders, the dashboard's aria snapshots, tests of them) that
// the brain carries because the code wrote them there. A run the code's own string literals hold
// could not have come from the owner, so it is dropped before the repo is read; what the code only
// interpolates, and anything in a comment, still counts.
test("a run the code's own string literals hold is the hub's sentence, not the owner's data", () => {
  const t = secret().split(" ");
  const fixed = t.slice(0, 9).join(" ");
  const brain = brainWith(`Ada ${fixed}.`);
  const repo = repoWith({
    "src/say.ts": `export const say = (who: string) => \`\${who} ${fixed}.\`;\n`,
    "test/ui/snap.aria.yml": `- text: Zed ${fixed}.\n`,
    "docs/x.md": `The note reads: "${fixed}".\n`,
  });
  const r = brainQuotes({ brain, repo, examples: [] });
  expect(r.hits).toEqual([]);
  expect(r.code).toBeGreaterThan(0);
});

test("plain strings joined with + read as one sentence of the code", () => {
  const t = secret().split(" ");
  const brain = brainWith(t.join(" "));
  const repo = repoWith({
    "src/say.ts": `export const s = "${t.slice(0, 5).join(" ")} " +\n  "${t.slice(5).join(" ")}";\n`,
    "docs/x.md": t.join(" ") + "\n",
  });
  expect(brainQuotes({ brain, repo, examples: [] }).hits).toEqual([]);
});

test("a sentence an older commit's code wrote is the hub's too", () => {
  const t = secret().split(" ");
  const brain = brainWith(t.join(" "));
  const repo = repoWith({ "src/say.ts": `export const s = "${t.join(" ")}";\n` });
  commit(repo);
  repoWith({ "src/say.ts": `export const s = "reworded since";\n`, "docs/x.md": t.join(" ") + "\n" }, repo);
  commit(repo);
  expect(brainQuotes({ brain, repo, examples: [] }).hits).toEqual([]);
});

test("the owner's words around a template, or in a comment of the code, still count", () => {
  const t = secret().split(" ");
  const fixed = t.slice(0, 4).join(" ");
  const own = secret();
  const noted = secret();
  // The code writes four fixed words, then the owner's value: the run crossing into it is his.
  const brain = brainWith(`${fixed} ${own}. Then ${noted}.`);
  const repo = repoWith({
    "src/say.ts": `// ${noted}\nexport const say = (v: string) => \`${fixed} \${v}\`;\n`,
    "docs/x.md": `${fixed} ${own}\n`,
  });
  const hits = brainQuotes({ brain, repo, examples: [] }).hits;
  expect(hits).toContainEqual({ file: "docs/x.md", line: 1 });
  expect(hits).toContainEqual({ file: "src/say.ts", line: 1 });
});

test("a brain the code makes from nothing is one of the hub's own, in a folder of its own", () => {
  const fresh = freshBrain(ROOT);
  expect(fresh.startsWith(tmpdir())).toBe(true);
  // init wrote pages from the sample seeds: their runs are dropped like the example brains'.
  const r = brainQuotes({ brain: fresh, repo: repoWith({ "x.md": "nothing\n" }), examples: [fresh] });
  expect(r.runs).toBe(0);
  expect(readdirSync(join(fresh, "people")).length).toBeGreaterThan(0);
});

// G940 (2026-11-16): the second run on the real brain still named frontmatter shapes: a design doc's
// example page and test fixtures whose keys, dates and agent names lined up with real pages'
// ("sensitivity: personal / status: active / created: 2026-10-04 / updated: ..."). A page's text
// is its body and each frontmatter value on its own; a long value is still the owner's words.
test("frontmatter keys and short values are a page's shape, never a quote; a long value still is", () => {
  const value = secret();
  const b = mkdtempSync(join(tmpdir(), "pb-bq-brain-"));
  mkdirSync(join(b, "people"), { recursive: true });
  const front = "id: people/zed\ntype: person\ntitle: Zed\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-04\nupdated: 2026-10-04\nby: town";
  writeFileSync(join(b, "people", "zed.md"), `---\n${front}\nfacts:\n  note: { value: "${value}", by: town }\n---\nBody.\n`);
  const repo = repoWith({ "test/fixture.md": `---\n${front}\n---\n`, "docs/x.md": `It said ${value}.\n` });
  expect(brainQuotes({ brain: b, repo, examples: [], history: false }).hits).toEqual([{ file: "docs/x.md", line: 1 }]);
});

test("a count or date the code fills into its sentence is still the hub's sentence", () => {
  const t = secret().split(" ");
  const brain = brainWith(`${t.slice(0, 3).join(" ")} 3 of 14 ${t.slice(3, 7).join(" ")} since 2026-10-12.`);
  const repo = repoWith({
    "src/say.ts": `export const s = (n: number, d: string) => \`${t.slice(0, 3).join(" ")} \${n} of 14 ${t.slice(3, 7).join(" ")} since \${d}.\`;\n`,
    "docs/x.md": `${t.slice(0, 3).join(" ")} 4 of 14 ${t.slice(3, 7).join(" ")} since 2026-10-19.\n`,
  });
  expect(brainQuotes({ brain, repo, examples: [], history: false }).hits).toEqual([]);
});

// Third run (2026-11-16): what was left included the hub's sentences put together from several
// literals (list items, "X also comes up in the sources of Y", a date then "(Written by the hub from
// this page's facts.)"), which no single literal holds eight words of.
test("a sentence the code puts together from short literals, with one word filled in, is the hub's", () => {
  const t = secret(14).split(" ");
  const brain = brainWith(`- ${t.slice(0, 4).join(" ")}.\n- ${t.slice(4, 8).join(" ")}.\nAda ${t.slice(8, 14).join(" ")} 7 Oct 2026.`);
  const repo = repoWith({
    "src/say.ts": `out.push("- ${t.slice(0, 4).join(" ")}.", "- ${t.slice(4, 8).join(" ")}.");\nconst s = (who: string, d: string) => \`\${who} ${t.slice(8, 14).join(" ")} \${d}.\`;\n`,
    "docs/x.md": `- ${t.slice(0, 4).join(" ")}.\n- ${t.slice(4, 8).join(" ")}.\nAda ${t.slice(8, 14).join(" ")} 1 Nov 2026.\n`,
  });
  expect(brainQuotes({ brain, repo, examples: [], history: false }).hits).toEqual([]);
});

test("two words of the owner's own inside the hub's sentence still make it a quote", () => {
  const t = secret(14).split(" ");
  const brain = brainWith(`- ${t.slice(0, 4).join(" ")}.\nAda Byron ${t.slice(4, 14).join(" ")}.`);
  const repo = repoWith({
    "src/say.ts": `out.push("- ${t.slice(0, 4).join(" ")}.");\nconst s = (who: string) => \`\${who} ${t.slice(4, 14).join(" ")}.\`;\n`,
    "docs/x.md": `- ${t.slice(0, 4).join(" ")}.\nAda Byron ${t.slice(4, 14).join(" ")}.\n`,
  });
  expect(brainQuotes({ brain, repo, examples: [], history: false }).hits).toContainEqual({ file: "docs/x.md", line: 2 });
});

test("--json prints one object for the deploy log: counts and file:line, never the words", () => {
  const words = secret();
  const brain = brainWith(words);
  const repo = repoWith({ "docs/x.md": `${words}\n` });
  const r = Bun.spawnSync(["bun", join(ROOT, "scripts", "brain-quotes.ts"), "--brain", brain, "--repo", repo, "--json"], { stdout: "pipe", stderr: "pipe" });
  expect(r.exitCode).toBe(0);
  const out = r.stdout.toString();
  expect(JSON.parse(out)).toMatchObject({ lines: 1, hits: ["docs/x.md:1"] });
  expect(out).not.toContain(words.split(" ")[0]);
}, 30_000);
