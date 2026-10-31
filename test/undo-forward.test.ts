// SPDX-License-Identifier: AGPL-3.0-only
// Undo is a forward write, never git revert (phone UI spec §5, owner 2026-10-26): it puts back the
// record the diary line replaced, with its own verification and sources, and moves the undone one to
// history as never right, so the same value from the same source doesn't land again. A fact that
// changed since says so instead of undoing.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { loadBrain, type FactRecord } from "../src/brain";

const sh = (cwd: string, ...args: string[]) => new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } }).stdout).trim();
const jane = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
const roleWrite = (root: string, value: string, src = "gmail:f000000000000002", as_of = "2026-10-05") =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value, as_of, sources: [src], verification: "verified-by-source" } as never);
const last = (root: string) => readDiary(root).at(-1)!;

test("Undo of a changed value puts the old record back as it was", () => {
  const root = makeBrain();
  const was = structuredClone(jane(root).fm.facts!.role as FactRecord);
  expect(roleWrite(root, "Program director").outcome).toBe("committed");
  const r = undoFact(root, last(root).undo_token);
  expect(r.outcome).toBe("undone");
  const now = jane(root).fm.facts!.role as FactRecord;
  expect(now.value).toBe(was.value);
  expect(now.verification).toBe(was.verification);
  expect(now.sources).toEqual(was.sources);
  expect(now.valid_to).toBeUndefined();
  expect(now.ended_by).toBeUndefined();
  const gone = jane(root).fm.history!.role!.at(-1)!;
  expect(gone.value).toBe("Program director");
  expect(gone.ended_by?.by).toBe("owner");
  expect(gone.ended_by?.correction).toBe(true);
  // A forward commit by the owner, not a revert; and a diary line saying it was undone.
  // (the page writer's own commit for the page's text may follow it)
  const log = sh(root, "log", "-2", "--format=%an %s").split("\n");
  expect(log.some((l) => /^(owner|louis|Robin) owner: undo people\/jane-roy#role$/.test(l))).toBe(true);
  expect(log.some((l) => /Revert/.test(l))).toBe(false);
  expect(last(root).kind).toBe("undone");
  expect(last(root).undoes).toBe(readDiary(root)[0]!.undo_token);
});

test("Undo of a new fact takes it out", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "org", value: "North College", as_of: "2026-10-05", sources: ["gcal:e9@e9"], verification: "verified-by-source" } as never);
  expect(undoFact(root, last(root).undo_token).outcome).toBe("undone");
  expect(jane(root).fm.facts!.org).toBeUndefined();
});

test("Undo of a captured value keeps it from landing again from the same source", () => {
  const root = makeBrain();
  roleWrite(root, "Program director");
  undoFact(root, last(root).undo_token);
  const rows = readDiary(root).length;
  const again = roleWrite(root, "Program director");
  expect(again.outcome).not.toBe("committed");
  expect((jane(root).fm.facts!.role as FactRecord).value).toBe("Course coordinator");
  expect(readDiary(root)).toHaveLength(rows);
});

test("Undo works after a later commit touched the page (no revert to collide with)", () => {
  const root = makeBrain();
  roleWrite(root, "Program director");
  const token = last(root).undo_token;
  // Someone else's text on the page after the change, as the nightly page writer does.
  const p = join(root, "people", "jane-roy.md");
  const txt = readFileSync(p, "utf8");
  writeFileSync(p, txt.replace("Coordinates [[projects/course-a]].", "Jane Roy is a program director.[^p-role] Coordinates [[projects/course-a]]."));
  sh(root, "commit", "-qam", "page text");
  expect(undoFact(root, token).outcome).toBe("undone");
  expect((jane(root).fm.facts!.role as FactRecord).value).toBe("Course coordinator");
});

test("a fact changed since says so and is left alone", () => {
  const root = makeBrain();
  roleWrite(root, "Program director");
  const token = last(root).undo_token;
  roleWrite(root, "Dean of studies", "gmail:f000000000000003", "2026-10-06");
  const r = undoFact(root, token);
  expect(r.outcome).toBe("changed_since");
  expect((jane(root).fm.facts!.role as FactRecord).value).toBe("Dean of studies");
});

test("an unknown or already used token undoes nothing", () => {
  const root = makeBrain();
  expect(undoFact(root, "0000000000000000").outcome).toBe("not_found");
  roleWrite(root, "Program director");
  const token = last(root).undo_token;
  expect(undoFact(root, token).outcome).toBe("undone");
  expect(undoFact(root, token).outcome).toBe("already_undone");
});
