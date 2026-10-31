// SPDX-License-Identifier: AGPL-3.0-only
// The owner's diary (phone UI spec §6, owner 2026-10-26): write() appends one row per fact change
// to diary/YYYY-MM.jsonl in the same commit as the change, so the home renders what the brain
// learned from this file, never from git log. A write that changes no value adds no row.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readDiary, diaryPath } from "../src/diary";

const sh = (cwd: string, ...args: string[]) => new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd }).stdout).trim();
const role = (root: string, value: string, extra: Record<string, unknown> = {}) =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", ...extra } as never);

test("a changed value adds one diary row, committed with the change", () => {
  const root = makeBrain();
  const r = role(root, "Program director");
  expect(r.outcome).toBe("committed");
  const rows = readDiary(root);
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.fact_key).toBe("people/jane-roy#role");
  expect(row.from).toBe("Course coordinator");
  expect(row.to).toBe("Program director");
  expect(row.kind).toBe("changed");
  expect(row.by).toBe("planner");
  expect(row.source_word).toBe("email");
  expect(row.sensitivity).toBe("personal");
  expect(row.title).toBe("Jane Roy");
  expect(row.undo_token).toMatch(/^[0-9a-f]{16}$/);
  // Same commit as the note: nothing left uncommitted, and the diary file is in HEAD's change.
  expect(sh(root, "status", "--porcelain", "--", "diary", "people")).toBe("");
  expect(sh(root, "show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual(["diary/2026-10.jsonl", "people/jane-roy.md"]);
});

test("a new fact is a row with nothing before it", () => {
  const root = makeBrain();
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "org", value: "North College", as_of: "2026-10-05", sources: ["gcal:e9@e9"], verification: "verified-by-source" } as never).outcome).toBe("committed");
  const [row] = readDiary(root);
  expect(row!.kind).toBe("new");
  expect(row!.from).toBeUndefined();
  expect(String(row!.to)).toContain("North College");
  expect(row!.source_word).toBe("calendar");
});

test("saying the same value again changes nothing and adds no row", () => {
  const root = makeBrain();
  const r = role(root, "Course coordinator", { sources: ["gmail:f000000000000003"] });
  expect(r.outcome).toBe("committed"); // sources merged
  expect(readDiary(root)).toHaveLength(0);
  expect(existsSync(diaryPath(root, "2026-10"))).toBe(false);
});

test("a refused write adds no row", () => {
  const root = makeBrain();
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "x", as_of: "2026-10-05", sources: ["gmail:f0000000000000ff9"], verification: "verified-by-source" } as never).outcome).not.toBe("committed");
  expect(readDiary(root)).toHaveLength(0);
});

test("a write that opens a conflict is a row too, so the home can show it", () => {
  const root = makeBrain();
  // An older, weaker source against the live value: a conflict, the live value kept.
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "Senior assistant", as_of: "2026-08-01", sources: ["notion:abc"], verification: "self-reported" } as never);
  expect(r.outcome).toBe("disputed");
  const [row] = readDiary(root);
  expect(row!.kind).toBe("conflict");
  expect(row!.from).toBe("Course coordinator");
  expect(row!.to).toBe("Senior assistant");
});

test("an agent can't write into the diary folder", () => {
  const root = makeBrain();
  const r = write(root, { agent: "planner", id: "diary/2026-10", title: "x", type: "note", area: "work", attribute: "a", value: "b", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  expect(r.outcome).toBe("refused");
  expect(join(root, "diary")).toBeTruthy();
  expect(readDiary(root)).toHaveLength(0);
});
