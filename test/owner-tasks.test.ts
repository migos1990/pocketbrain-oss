// SPDX-License-Identifier: AGPL-3.0-only
// What waits on the owner's own hands, and what the hub's own jobs are failing at, in one place.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { addTask, doneTask, openTasks } from "../src/measure";
import { digest } from "../src/digest";
import { record } from "../src/probe";
import { week } from "../src/measure";

test("hand tasks: added, listed oldest first with a number, and closed by number", () => {
  const root = makeBrain();
  addTask(root, "brew install age", "cli");
  addTask(root, "save the backup key in 1Password", "cli");
  expect(openTasks(root).map((t) => t.what)).toEqual(["brew install age", "save the backup key in 1Password"]);
  expect(doneTask(root, 1)).toContain("brew install age");
  expect(openTasks(root).map((t) => t.what)).toEqual(["save the backup key in 1Password"]);
  expect(() => doneTask(root, 5)).toThrow();
  expect(() => addTask(root, " ", "cli")).toThrow();
});

test("operator ledger: a hand task carries the exact command, shown in the list and the digest; never a secret", () => {
  const root = makeBrain();
  expect(addTask(root, "install age on the Mac", "cli", "brew install age")).toBe("task 1: install age on the Mac\n   run: brew install age");
  expect(openTasks(root)[0]).toMatchObject({ id: 1, cmd: "brew install age" });
  expect(digest(root).text).toContain("- **Hand task** 1: install age on the Mac (since ");
  expect(digest(root).text).toContain("Run: `brew install age`.");
  expect(() => addTask(root, "set the key", "cli", "export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456")).toThrow(/secret/);
  expect(() => addTask(root, "my password is hunter2", "cli")).toThrow(/secret/);
  expect(openTasks(root).length).toBe(1);
});

test("the digest lists open hand tasks and hub checks still failing", () => {
  const root = makeBrain();
  addTask(root, "brew install age", "cli");
  record(root, [{ name: "night", ok: false, detail: "night failed: disk full" }]);
  const t = digest(root).text;
  expect(t).toContain("- **Hand task** 1: brew install age (since ");
  expect(t).toContain("- **Hub problem** night: night failed: disk full (since ");
});

test("the week totals the stale and due facts agents were handed", () => {
  const root = makeBrain();
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-10-07T12:00:00Z", agent: "planner", op: "read", fresh: { stale: 2, due: 1, disputed: 0 } }) + "\n");
  appendFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-10-08T12:00:00Z", agent: "planner", op: "read", fresh: { stale: 1, due: 0, disputed: 1 } }) + "\n");
  const v = week(root, "2026-10-08").verdicts.find((x) => x.measure === "Stale or due facts handed out (labelled)");
  expect(v).toMatchObject({ value: "3 stale, 1 due, 1 disputed" });
});
