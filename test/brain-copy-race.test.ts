// SPDX-License-Identifier: AGPL-3.0-only
// G968: main's CI on fa72ad11 (2026-11-16) failed in test/brain-format.test.ts: `migrate` copies
// the brain for its dry run (src/format.ts), and the copy threw ENOENT on
// .git/objects/maintenance.lock, which a background `git maintenance run --auto` took and dropped
// while the copy walked .git. G931 fixed the same race for the drill's copy only. A real owner's
// git (their own commits, an editor's git, the hub's night gc) does the same on a real brain, so
// every copy of a brain goes through one walk: a git lock file is never copied, and anything else
// that vanishes mid-walk makes the copy start again, never a copy quietly missing a file.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { migrate, type Migration } from "../src/format";
import { copyBrain } from "../src/brain-copy";

const noop: Migration = { to: 2, what: "nothing", run: () => [] };

// A brain whose .git holds enough files that the walk takes a while, and a child process that
// makes and drops git lock files in it as fast as it can, as `git maintenance` and `git gc` do.
function churning(): { root: string; stop: () => void } {
  const root = makeBrain();
  for (let d = 0; d < 20; d++) {
    const dir = join(root, ".git", "objects", `f${d}`);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 150; i++) writeFileSync(join(dir, `pad${i}`), "x");
  }
  const locks = ["objects/maintenance.lock", "index.lock", "packed-refs.lock", ...Array.from({ length: 20 }, (_, d) => `objects/f${d}/tmp.lock`)].map((p) => join(root, ".git", p));
  const script = `const fs=require("fs");const ls=${JSON.stringify(locks)};for(;;){for(const l of ls){try{fs.writeFileSync(l,"")}catch{}}for(const l of ls){try{fs.unlinkSync(l)}catch{}}}`;
  const child = Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "ignore" });
  return { root, stop: () => child.kill() };
}

test("migrate's dry run copies a brain while git takes and drops its locks (G968)", async () => {
  const { root, stop } = churning();
  await Bun.sleep(200);
  try {
    for (let i = 0; i < 8; i++) expect(migrate(root, { migrations: [noop], code: 2 }).steps.map((s) => s.to)).toEqual([2]);
  } finally { stop(); }
});

test("the drill's copy goes through the same walk: no lock file in the copy (G968, G931)", async () => {
  const { root, stop } = churning();
  await Bun.sleep(200);
  const to = join(mkdtempSync(join(tmpdir(), "pb-copy-")), "brain");
  try { copyBrain(root, to); } finally { stop(); }
  expect(existsSync(join(to, ".git", "HEAD"))).toBe(true);
  expect(existsSync(join(to, ".git", "objects", "maintenance.lock"))).toBe(false);
  expect(existsSync(join(to, ".git", "objects", "f19", "pad149"))).toBe(true);
});

test("a real file that vanishes mid-walk starts the copy again; the copy never quietly lacks it (G968)", () => {
  const root = makeBrain({ git: false });
  writeFileSync(join(root, "people", "zz-late.md"), "---\nid: people/zz-late\n---\n");
  const to = join(mkdtempSync(join(tmpdir(), "pb-copy-")), "brain");
  let starts = 0;
  // The first pass loses a file between listing its folder and reading it, as a pack does to a
  // loose object; the file is back by the second pass (git wrote it elsewhere, or it was rewritten).
  const late = join(root, "people", "zz-late.md");
  copyBrain(root, to, { onEntry: (p) => {
    if (p === root && ++starts === 2) writeFileSync(late, "---\nid: people/zz-late\n---\n");
    if (p === late && starts === 1) rmSync(late);
  } });
  expect(starts).toBe(2);
  expect(readFileSync(join(to, "people", "zz-late.md"), "utf8")).toContain("people/zz-late");
});

test("a brain that keeps changing mid-copy is refused with one sentence and leaves no half copy (G968)", () => {
  const root = makeBrain({ git: false });
  const to = join(mkdtempSync(join(tmpdir(), "pb-copy-")), "brain");
  const victim = join(root, "people", "zz-flaky.md");
  writeFileSync(victim, "x");
  expect(() => copyBrain(root, to, { onEntry: (p) => {
    if (p === root) writeFileSync(victim, "x");
    if (p === victim) rmSync(victim);
  } })).toThrow("the brain kept changing while it was copied (people/zz-flaky.md went away mid-copy); nothing was changed, run it again");
  expect(existsSync(to)).toBe(false);
});
