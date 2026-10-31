// SPDX-License-Identifier: AGPL-3.0-only
// A change reaches its neighbours (memory-graph.md item 3, docs/wiki.md "When a fact changes"):
// once a fact gets a new value, the page's own text and every note linking to it that still state
// the earlier value get a review line. The line names no page, fact, date or value: the Gardener
// reads findings filtered by note only (slice audit). A value still part of the current one is fine.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { upkeep } from "../src/upkeep";
import { write } from "../src/write";

const JANE = "people/jane-roy", B = "projects/course-b";
const commit = (root: string) => Bun.spawnSync(["git", "commit", "-qam", "setup"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const append = (root: string, id: string, text: string) => { const p = join(root, `${id}.md`); writeFileSync(p, readFileSync(p, "utf8").replace(/\n*$/, `\n${text}\n`)); };
const role = (root: string, value: string) => write(root, { agent: "planner", id: JANE, attribute: "role", value, as_of: "2026-10-06", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
const drift = (root: string) => upkeep(root, { now: "2026-10-08" }).findings.filter((f) => f.rule === "neighbour-drift");

test("a note linking to a page that still states the page's earlier value gets a review line", () => {
  const root = makeBrain();
  append(root, B, "Ask [[people/jane-roy]], the course coordinator, about rooms.");
  append(root, JANE, "She has been course coordinator since 2024.");
  commit(root);
  expect(drift(root)).toEqual([]);
  expect(role(root, "Department chair").outcome).toBe("committed");
  const found = drift(root);
  expect(found.map((f) => f.key).sort()).toEqual([JANE, B]);
  expect(found.find((f) => f.key === B)!.detail).toBe("the text still states a value that has since changed on a note it links to; update it or check it");
  expect(found.find((f) => f.key === JANE)!.detail).toBe("the text still states an earlier value of one of this note's facts; update it or check it");
  for (const f of found) for (const w of ["coordinator", "jane", "role", "2026"]) expect(f.detail.toLowerCase()).not.toContain(w);
});

test("an earlier value still part of the current one, or not stated anywhere, is never flagged", () => {
  const root = makeBrain();
  append(root, B, "Ask [[people/jane-roy]], the course coordinator.");
  commit(root);
  role(root, "Senior course coordinator");
  expect(drift(root)).toEqual([]);
});

test("a note that doesn't link to the page is left alone: no link, no neighbour", () => {
  const root = makeBrain();
  append(root, B, "The course coordinator books rooms.");
  commit(root);
  role(root, "Department chair");
  expect(drift(root).filter((f) => f.key === B)).toEqual([]);
});

test("a hidden history record gives the same plain line: no page, fact or date", () => {
  const root = makeBrain();
  // Jane's role is shared with the steward only; the planner sees Course B and Jane, not her role.
  append(root, B, "Ask [[people/jane-roy]], the course coordinator.");
  const p = join(root, `${JANE}.md`);
  writeFileSync(p, readFileSync(p, "utf8").replace(/  role: \{ value: Course coordinator,(.*)\}\n/, "  role: { share_with: [steward], value: Department chair,$1}\n").replace(/\n---\n/, "\nhistory:\n  role:\n    - { share_with: [steward], value: Course coordinator, as_of: 2026-09-01, valid_to: 2026-10-06, sources: [\"gmail:f000000000000001\"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }\n---\n"));
  commit(root);
  const f = drift(root).find((x) => x.key === B);
  expect(f?.detail).toBe("the text still states a value that has since changed on a note it links to; update it or check it");
});
