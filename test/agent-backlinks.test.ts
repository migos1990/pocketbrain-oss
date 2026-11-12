// SPDX-License-Identifier: AGPL-3.0-only
// Links both ways for agents (memory-graph.md item 1, docs/wiki.md "What assistants see"): read
// names the notes that link to a page ("Mentioned in") and the ones it links to, and context_pack
// adds one Connected line per hit. Only links the reader itself can see count: a link in a body it
// has no grant for, or in a fact carved out of its view, never shows, and a hidden note never does.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { readNote, contextPack } from "../src/core";
import { useCells, cellsOn } from "../src/cell";
import { withTokenRole } from "../src/tokenrole";
import { tokensOf } from "../src/context";

const COURSE = "projects/course-a", PAUL = "people/paul-advisor";
// Each edit is committed, as every brain change is: a cell is current for a brain commit, so an
// uncommitted edit after a read is invisible through cells (the lane ran this file without cells
// until G801).
const edit = (root: string, id: string, f: (s: string) => string) => {
  const p = join(root, `${id}.md`); writeFileSync(p, f(readFileSync(p, "utf8")));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "owner: edit"], { cwd: root });
};
const ids = (xs: { id: string }[] | undefined) => (xs ?? []).map((x) => x.id);

test("read names the notes that link to a page, and the notes it links to, with titles", () => {
  const root = makeBrain();
  const r = readNote(root, "planner", COURSE);
  expect(r.mentioned_in).toEqual([{ id: "people/jane-roy", title: "Jane Roy" }]);
  expect(r.markdown).toContain("Mentioned in: Jane Roy `people/jane-roy`");
  expect(ids(readNote(root, "planner", "people/jane-roy").links_to)).toEqual([COURSE]);
});

test("a note hidden from the reader is never named, either way", () => {
  const root = makeBrain();
  // Course A links to money/main-bank, which the planner can't see.
  expect(ids(readNote(root, "planner", COURSE).links_to)).toEqual([]);
  expect(JSON.stringify(readNote(root, "planner", COURSE))).not.toContain("money/main-bank");
  expect(ids(readNote(root, "steward", COURSE).links_to)).toEqual(["money/main-bank"]);
  expect(ids(readNote(root, "steward", "money/main-bank").mentioned_in)).toEqual([COURSE]);
});

test("only links the reader can see count: not in a body it has no grant for, nor in a carved fact", () => {
  const root = makeBrain();
  // Untagged, the planner sees Paul through contacts-basic only: his org and role, no body.
  edit(root, PAUL, (s) => s.replace("tags: [finance]\n", "").replace(/\n*$/, "\nAdvises on [[projects/course-a]].\n"));
  expect(readNote(root, "planner", PAUL).body).toBeUndefined();
  expect(ids(readNote(root, "steward", COURSE).mentioned_in)).toContain(PAUL);
  expect(ids(readNote(root, "planner", COURSE).mentioned_in)).not.toContain(PAUL);
  edit(root, PAUL, (s) => s.replace("Advises on [[projects/course-a]].", "").replace("facts:\n", 'facts:\n  relationship: { value: "[[projects/course-a]]", as_of: 2026-09-01, sources: ["gmail:f000000000000002"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }\n'));
  expect(ids(readNote(root, "steward", COURSE).mentioned_in)).toContain(PAUL);
  expect(ids(readNote(root, "planner", COURSE).mentioned_in)).not.toContain(PAUL);
  edit(root, PAUL, (s) => s.replace("relationship:", "org:"));
  expect(ids(readNote(root, "planner", COURSE).mentioned_in)).toContain(PAUL);
});

test("context_pack adds a Connected line to each hit, so the next hop is one read away", () => {
  const root = makeBrain();
  const pack = contextPack(root, "planner", "Course A next step");
  const block = pack.split("\n\n### ").find((b) => b.includes("`projects/course-a`"))!;
  expect(block).toContain("Connected: Jane Roy `people/jane-roy`");
  expect(pack).not.toContain("money/main-bank");
});

// Cases from the slice audit (pocketbrain-app-reviews/agent-backlinks-slice-audit.md).
test("a reader token never names a note above its ceiling, in read or context_pack, cells on or off", () => {
  const root = makeBrain();
  const was = cellsOn();
  try {
    for (const on of [false, true]) {
      useCells(on);
      expect(ids(readNote(root, "steward", COURSE).links_to)).toEqual(["money/main-bank"]);
      const asReader = withTokenRole("steward", "reader", () => [JSON.stringify(readNote(root, "steward", COURSE)), contextPack(root, "steward", "Course A")].join("\n"));
      expect(asReader, `cells ${on}`).not.toContain("money/main-bank");
    }
  } finally { useCells(was); }
});

test("a link to a merged note names the note it became, or nothing when that one is hidden", () => {
  const root = makeBrain();
  const twin = join(root, "people/j-roy.md");
  writeFileSync(twin, readFileSync(join(root, "people/jane-roy.md"), "utf8").replace("id: people/jane-roy", "id: people/j-roy").replace("status: active", "status: merged\nmerged_into: people/jane-roy").replace("Coordinates [[projects/course-a]].", ""));
  edit(root, "projects/course-b", (s) => s.replace(/\n*$/, "\nWith [[people/j-roy]].\n"));
  expect(ids(readNote(root, "planner", "projects/course-b").links_to)).toEqual(["people/jane-roy"]);
  expect(ids(readNote(root, "planner", "people/jane-roy").mentioned_in)).toContain("projects/course-b");
});

test("a link written into a fact's writer fields, which agents never read, never counts", () => {
  const root = makeBrain();
  edit(root, "people/jane-roy", (s) => s.replace("by: planner, recorded: 2026-10-01 }\n  phones", "by: planner, confirmed_by: \"[[projects/course-b]]\", recorded: 2026-10-01 }\n  phones"));
  expect(ids(readNote(root, "planner", "people/jane-roy").links_to)).toEqual([COURSE]);
  expect(ids(readNote(root, "planner", "projects/course-b").mentioned_in)).toEqual([]);
});

test("context_pack stays inside its budget with the Connected lines, and names what it left out", () => {
  const root = makeBrain();
  const c = join(root, "rules/policy.yaml");
  writeFileSync(c, readFileSync(c, "utf8").replace(/^/, "context_budget: { context_pack: 150 }\n"));
  const pack = contextPack(root, "planner", "Course A Jane Roy coordinator");
  expect(tokensOf(pack)).toBeLessThanOrEqual(150);
  expect(pack).toMatch(/over your context budget of 150 tokens/);
});
