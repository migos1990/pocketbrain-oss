// SPDX-License-Identifier: AGPL-3.0-only
// Red team: after the owner hides a note from an agent, memory_check still serves that note's
// title (open quiz question) and its value (approved correction).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import * as ms from "../src/memsync";
import { hideNoteFrom } from "../src/dashboard/edit";
import { readNote } from "../src/core";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

test("an open question about a note hidden since is not served (its title would leak)", () => {
  const root = makeBrain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  expect(q.question).toContain("Jane Roy");
  hideNoteFrom(root, "people/jane-roy", "helper");
  expect(() => readNote(root, "helper", "people/jane-roy")).toThrow(); // hidden now
  const check = ms.memoryCheck(root, "helper");
  const text = JSON.stringify(check);
  expect(text).not.toContain("Jane Roy");
});

test("an approved correction for a note hidden since is not delivered (title and value would leak)", () => {
  const root = makeBrain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Program director" }] });
  const c = ms.state(root).corrections.find((x) => x.agent === "helper" && x.key === "people/jane-roy#role")!;
  ms.approve(root, c.id);
  hideNoteFrom(root, "people/jane-roy", "helper");
  const check = ms.memoryCheck(root, "helper");
  const text = JSON.stringify(check.corrections);
  expect(text).not.toContain("Course coordinator");
  expect(text).not.toContain("Jane Roy");
});

test("the reply to a question on a since-hidden note answers like an unknown id", () => {
  const root = makeBrain();
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  hideNoteFrom(root, "people/jane-roy", "helper");
  const r = ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "x" }, { id: "q-00000000", answer: "x" }] });
  expect(r.answers[0].result).toBe(r.answers[1].result);
});

test("an approved forget correction for a note hidden since is not delivered (it names the note)", () => {
  const root = makeBrain();
  const f = join(root, "people", "jane-roy.md");
  const fs = require("node:fs");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("role: { value: Course coordinator, as_of: 2026-09-01,", "role: { value: Course coordinator, as_of: 2026-09-01, valid_to: 2026-09-30,"));
  Bun.spawnSync(["git", "commit", "-qam", "end role"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Course coordinator" }] });
  const c = ms.state(root).corrections.find((x) => x.agent === "helper" && x.key === "people/jane-roy#role")!;
  expect(c.kind).toBe("forget");
  ms.approve(root, c.id);
  hideNoteFrom(root, "people/jane-roy", "helper");
  const text = JSON.stringify(ms.memoryCheck(root, "helper").corrections);
  expect(text).not.toContain("Jane Roy");
});

test("an approved update correction carrying a lower-case value of a note hidden since is not delivered", () => {
  const root = makeBrain();
  const f = join(root, "people", "jane-roy.md");
  const fs = require("node:fs");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("role: { value: Course coordinator,", "role: { value: registrar,"));
  Bun.spawnSync(["git", "commit", "-qam", "role"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Program director" }] });
  const c = ms.state(root).corrections.find((x) => x.agent === "helper" && x.key === "people/jane-roy#role")!;
  ms.approve(root, c.id);
  hideNoteFrom(root, "people/jane-roy", "helper");
  expect(() => readNote(root, "helper", "people/jane-roy")).toThrow();
  const text = JSON.stringify(ms.memoryCheck(root, "helper").corrections);
  expect(text).not.toContain("registrar");
});

test("G75 on the per-correction approve path: a correction graded before the owner changed the fact never goes out with the old value", () => {
  const root = makeBrain();
  const { setFact } = require("../src/dashboard/edit");
  const [q] = ms.quiz(root, "helper", 1, ["people/jane-roy#role"]);
  ms.memoryReply(root, "helper", { answers: [{ id: q.id, answer: "Program director" }] });
  const c = ms.state(root).corrections.find((x) => x.agent === "helper" && x.key === "people/jane-roy#role")!;
  setFact(root, "people/jane-roy", "role", "Department chair");
  ms.approve(root, c.id); // the dashboard's memsync-approve button
  const text = JSON.stringify(ms.memoryCheck(root, "helper").corrections);
  expect(text).not.toContain("Course coordinator");
});
