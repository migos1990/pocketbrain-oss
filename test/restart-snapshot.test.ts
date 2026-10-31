// SPDX-License-Identifier: AGPL-3.0-only
// Restart snapshot (backlog 305): a restarted hub reads each note's parsed frontmatter from
// .cells/parse.json instead of parsing its YAML again. Keyed by the YAML text's hash, so an edited
// note is parsed again; a file from another version, or one that doesn't read, is rebuilt; and
// the notes loaded are the same with or without it.
import { test, expect, spyOn, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, resetParseSnapshots, saveParseSnapshots } from "../src/brain";

const restart = () => resetParseSnapshots(); // a new process: nothing parsed in memory
afterEach(() => resetParseSnapshots({ off: false }));

function parses(fn: () => unknown): number {
  const spy = spyOn(YAML, "parse");
  try { fn(); return spy.mock.calls.length; } finally { spy.mockRestore(); }
}

test("a restart reads the snapshot instead of parsing every note again, and loads the same notes", () => {
  const root = makeBrain();
  restart();
  const first = loadBrain(root);
  saveParseSnapshots();
  const file = join(root, ".cells", "parse.json");
  expect(existsSync(file)).toBe(true);
  // Derived: never committed.
  expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString()).toBe("");
  restart();
  let again: ReturnType<typeof loadBrain> = [];
  expect(parses(() => { again = loadBrain(root); })).toBe(0);
  expect(again).toEqual(first);
  resetParseSnapshots({ off: true });
  expect(loadBrain(root)).toEqual(first);
});

test("an edited note is parsed again and its new value is read; the others come from the snapshot", () => {
  const root = makeBrain();
  restart(); loadBrain(root); saveParseSnapshots(); restart();
  const f = join(root, "money", "main-bank.md");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^title: .*$/m, "title: Renamed bank"));
  let notes: ReturnType<typeof loadBrain> = [];
  expect(parses(() => { notes = loadBrain(root); })).toBe(1);
  expect(notes.find((n) => n.path === "money/main-bank.md")!.fm.title).toBe("Renamed bank");
});

test("a snapshot from another version, or one that doesn't read, is rebuilt", () => {
  const root = makeBrain();
  restart(); const want = loadBrain(root); saveParseSnapshots();
  const file = join(root, ".cells", "parse.json");
  const good = readFileSync(file, "utf8");
  const n = want.length;
  for (const bad of [good.replace(/^pocketbrain-parse 1/, "pocketbrain-parse 0"), "not a snapshot", good.replace(/\t\{/g, "\t{oops")]) {
    writeFileSync(file, bad);
    restart();
    let got: ReturnType<typeof loadBrain> = [];
    expect(parses(() => { got = loadBrain(root); })).toBe(n);
    expect(got).toEqual(want);
    saveParseSnapshots();
    expect(readFileSync(file, "utf8")).toBe(good);
  }
});

test("a cell shares its brain's snapshot file", () => {
  const root = makeBrain();
  const cell = join(root, ".cells", "helper");
  mkdirSync(join(cell, "notes"), { recursive: true });
  writeFileSync(join(cell, "notes", "x.md"), "---\nid: notes/x\ntype: note\ntitle: X\narea: life\nsensitivity: personal\n---\nbody\n");
  restart(); loadBrain(cell); saveParseSnapshots();
  expect(existsSync(join(cell, ".cells"))).toBe(false);
  expect(readFileSync(join(root, ".cells", "parse.json"), "utf8").split("\n").length).toBe(3);
});
