// SPDX-License-Identifier: AGPL-3.0-only
// Drift report (src/memsync.ts driftReport, docs/memory-sync.md "Drift report"): what Claude Code's
// own memory files say against the brain, line by line: contradicts, stale, brain lacks.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import * as ms from "../src/memsync";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const OLD = { as_of: "2026-06-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source" as const, by: "planner", recorded: "2026-06-01" };
const MEMORY = `# Working notes

- Always run the tests before pushing.
- Jane Roy's role is Teaching assistant.
- Jane's phones: +15145559999
- Course A next step: Grade the final exam
- Jane Roy's birthday is March 3
- Jane's home address is Elm Street 9
- Course A next step: Grade the midterm
`;

// Claude Code as an agent with a readable memory folder, and Jane's role changed since June.
function setup() {
  const root = makeBrain();
  const notes = loadBrain(root);
  const jane = notes.find((n) => n.fm.id === "people/jane-roy")!;
  jane.fm.history = { role: [{ value: "Teaching assistant", ...OLD, ended_by: { at: "2026-09-01", by: "louis" } } as any] };
  (jane.fm.facts as any).home_address = { value: "Larkspur Lane 4410", share_with: ["steward"], ...OLD };
  saveNote(root, jane);
  const dir = mkdtempSync(join(tmpdir(), "pb-claude-"));
  writeFileSync(join(dir, "CLAUDE.md"), MEMORY);
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.agents.claude = { tier: "core", aliases: ["Claude"], slices: ["area:work", "contacts-basic"], exclude_types: ["money"], memory: { files: [dir] } };
  writeFileSync(f, YAML.stringify(p));
  return { root, file: join(dir, "CLAUDE.md") };
}

test("the drift report sorts Claude Code's memory lines into contradicts, stale and brain lacks, each with its file:line and the brain's refs", () => {
  const { root, file } = setup();
  const r = ms.driftReport(root, "claude");
  expect(r.files).toEqual([file]);
  expect(r.stale.map((x) => [x.line, x.key, x.said])).toEqual([[4, "people/jane-roy#role", "Teaching assistant"]]);
  expect(r.contradicts.map((x) => [x.line, x.key, x.said, x.brain])).toEqual([
    [5, "people/jane-roy#phones", "+15145559999", "+15145550100"],
    [6, "projects/course-a#next_step", "Grade the final exam", "Grade the midterm"],
  ]);
  expect(r.contradicts[0].refs).toEqual(["gmail:f000000000000001"]);
  expect(r.lacks.map((x) => [x.line, x.subject, x.attr, x.said])).toEqual([[7, "people/jane-roy", "birthday", "March 3"]]);
  expect(r.outside).toBe(1); // the home address is shared with steward only: no correction, no value
  expect(JSON.stringify(r)).not.toContain("Larkspur");
  // Line 9 matches the brain and line 3 is an instruction: neither is listed.
  expect([...r.stale, ...r.contradicts, ...r.lacks].map((x) => x.line)).not.toContain(9);
});

test("stale and contradicting lines become corrections for the owner; approving one rewrites only that line", () => {
  const { root, file } = setup();
  const r = ms.driftReport(root, "claude");
  expect([...r.stale, ...r.contradicts].every((x) => x.correction)).toBe(true);
  const waiting = ms.state(root).corrections.filter((c) => c.agent === "claude" && c.state === "proposed");
  expect(waiting.length).toBe(3);
  const c = waiting.find((x) => x.key === "projects/course-a#next_step")!;
  ms.approve(root, c.id);
  const lines = readFileSync(file, "utf8").split("\n");
  expect(lines[5]).toBe("- Course A next step: Grade the midterm");
  expect(lines[4]).toBe("- Jane's phones: +15145559999"); // the others wait for the owner
  // A second report proposes nothing new for lines already waiting.
  ms.driftReport(root, "claude");
  expect(ms.state(root).corrections.filter((x) => x.agent === "claude" && x.state === "proposed").length).toBe(2);
});

test("a contradiction on a fact holding a withheld value is corrected with the scrubbed text (G74)", () => {
  const { root } = setup();
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  (jane.fm.facts as any).role.value = "Course coordinator, see [[money/main-bank]]";
  saveNote(root, jane);
  const dir = mkdtempSync(join(tmpdir(), "pb-claude-"));
  writeFileSync(join(dir, "CLAUDE.md"), "- Jane Roy's role is Dean of arts\n");
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.agents.claude.memory = { files: [dir] };
  writeFileSync(f, YAML.stringify(p));
  const r = ms.driftReport(root, "claude");
  expect(r.contradicts.map((x) => x.brain)).toEqual(["Course coordinator, see [[redacted]]"]);
  expect(JSON.stringify(ms.state(root).corrections)).not.toContain("money/main-bank");
});

test("an agent with no memory files gets an empty report that says so", () => {
  const root = makeBrain();
  const r = ms.driftReport(root, "planner");
  expect(r.files).toEqual([]);
  expect(ms.renderDrift(r)).toContain("no memory files");
});
