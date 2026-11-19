// SPDX-License-Identifier: AGPL-3.0-only
// The count of what waits on the owner read every page ten times over and built the dashboard's
// whole state to use three parts of it; on a big memory that was most of the owner's own page
// (G1004). It now reads the pages once and counts exactly what it counted. Every page is invented.
import { test, expect, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { brainReads, loadBrain, saveNote } from "../src/brain";
import { oneRead, readOnce } from "../src/util";
import { ownerAsks } from "../src/waiting";
import { waitingCount } from "../src/dashboard/home";

let root = "";
beforeAll(async () => { root = (await makeDemoBrain()).root; }, 120_000);
const now = new Date(DEMO_NOW);

test("the count of what waits reads the pages from disk once, and counts the same", () => {
  const before = brainReads();
  const a = ownerAsks(root, now);
  expect(brainReads() - before).toBe(1);
  // The demo week leaves questions open: the count is of something, and the home's number is it.
  expect(a.total).toBeGreaterThan(0);
  expect(waitingCount(root, now)).toBe(waitingCount(root, now, a));
  const b = ownerAsks(root, now);
  expect({ by: b.by, total: b.total, settings: b.settings, stuck: b.stuck, serving: b.serving, guesses: b.guesses }).toEqual({ by: a.by, total: a.total, settings: a.settings, stuck: a.stuck, serving: a.serving, guesses: a.guesses });
});

test("outside one look every load reads for itself, and a saved page ends the sharing", () => {
  const before = brainReads();
  loadBrain(root); loadBrain(root, { shared: true });
  expect(brainReads() - before).toBe(2);
  const file = join(root, "notes", "one-read.md");
  const text = (title: string) => `---\nid: notes/one-read\ntype: note\ntitle: ${title}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\n---\nThe kettle is on the top shelf.\n`;
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(file, text("Kettle"));
  const titleOf = () => loadBrain(root, { shared: true }).find((n) => n.fm.id === "notes/one-read")!.fm.title;
  oneRead(() => {
    const first = loadBrain(root, { shared: true }), again = loadBrain(root, { shared: true });
    expect(again).not.toBe(first); // each caller sorts and filters its own array
    expect(again[0]).toBe(first[0]);
    // A copy for a caller that edits is still its own.
    const mine = loadBrain(root).find((n) => n.fm.id === "notes/one-read")!;
    mine.fm.title = "Teapot";
    expect(titleOf()).toBe("Kettle");
    // Writing through saveNote is seen by the next load, inside the same look.
    saveNote(root, mine);
    expect(titleOf()).toBe("Teapot");
    expect(readOnce("k", () => 1)).toBe(1);
    expect(readOnce("k", () => 2)).toBe(1);
  });
  expect(readOnce("k", () => 3)).toBe(3);
  expect(readFileSync(file, "utf8")).toContain("Teapot");
  // A throw inside ends the look too.
  expect(() => oneRead(() => { readOnce("t", () => 1); throw new Error("x"); })).toThrow("x");
  expect(readOnce("t", () => 5)).toBe(5);
});
