// SPDX-License-Identifier: AGPL-3.0-only
// North star 2026-11-07: 7 projects and 1 decision held no person, org or project fact, so no page
// linked them and the wiki never reached them (pages_ok counts a page only with a link in). The
// owner's own page now lists his live projects and standing decisions, one sentence per area,
// each name cited by that page's own facts (G725). For a reader who can't see one of those pages,
// or a fact behind it, the sentence drops whole, as "…: your colleagues." does (G703): all its
// pages or none, never the ones left (G726).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { readNote } from "../src/core";
import { inboundLinks } from "../scripts/north-star";
import { loadBrain } from "../src/brain";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const SINCE = "2000-01-01T00:00:00Z";
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: ${value}, as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }\n`;
function page(root: string, id: string, type: string, title: string, facts: string, o: { area?: string; sensitivity?: string; status?: string; extra?: string } = {}) {
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: ${o.area ?? "personal"}\nsensitivity: ${o.sensitivity ?? "personal"}\nstatus: ${o.status ?? "active"}\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n${o.extra ?? ""}${facts ? `facts:\n${facts}` : ""}---\n`);
}
const commit = (root: string) => { sh(root, "steward", "add", "-A"); sh(root, "steward", "commit", "-qm", "steward: setup"); };

function brain() {
  const root = makeBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }").replace("agents:\n", "agents:\n  reader: { tier: trial, slices: [all] }\n"));
  page(root, "people/robin-vale", "person", "Robin Vale", fact("city", "Halifax", "gmail:f000000000000009"));
  // Holds no person, org or project fact: before G725 nothing linked it.
  page(root, "projects/garden-shed", "project", "Garden shed", fact("next_step", "order the cedar boards", "gmail:f00000000000000a"));
  page(root, "projects/old-fence", "project", "Old fence", fact("next_step", "paint it", "gmail:f00000000000000b"), { status: "archived" });
  page(root, "projects/empty-thing", "project", "Empty thing", "");
  page(root, "decisions/2026-10-02-pick-contractor", "decision", "Pick a contractor", fact("chose", "Lee Builders", "gmail:f00000000000000c"), { extra: "decided_on: 2026-10-02\n" });
  page(root, "projects/course-b", "project", "Course B", fact("status", "planning", "gmail:f00000000000000d"), { area: "work" });
  commit(root);
  return root;
}

test("G725 the owner's own page lists his live projects and standing decisions by area, each cited by that page's facts", () => {
  const root = brain();
  renderTouchedPages(root, SINCE);
  const me = body(root, "people/robin-vale");
  expect(me).toContain("Halifax");
  expect(me).toMatch(/Your personal projects: \[\[projects\/garden-shed\|Garden shed\]\]\.\[\^p-see-garden-shed\]/);
  expect(me).toMatch(/Your work projects: \[\[projects\/course-a\|Course A\]\] and \[\[projects\/course-b\|Course B\]\]\.\[\^p-see-course-a\]\[\^p-see-course-b\]/);
  expect(me).toMatch(/Your decisions: \[\[decisions\/2026-10-02-pick-contractor\|Pick a contractor\]\]\.\[\^p-see-2026-10-02-pick-contractor\]/);
  expect(me).toContain("[^p-see-garden-shed]: Email, 2026-10-05 (gmail:f00000000000000a)");
  // Archived, holding no fact, or more private than the owner's page: never named.
  expect(me).not.toContain("Old fence");
  expect(me).not.toContain("Empty thing");
  expect(me).not.toContain("Pick a bank");
  // The orphan now has a link in, so the north star can count it.
  expect(inboundLinks(loadBrain(root)).get("projects/garden-shed")).toBe(1);
});

test("G725 nothing to list says nothing: no empty sentence", () => {
  const root = makeBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  page(root, "people/robin-vale", "person", "Robin Vale", fact("city", "Halifax", "gmail:f000000000000009"));
  for (const p of ["course-a", "course-b"]) writeFileSync(join(root, "projects", `${p}.md`), readFileSync(join(root, "projects", `${p}.md`), "utf8").replace("status: active", "status: archived"));
  commit(root);
  renderTouchedPages(root, SINCE);
  const me = body(root, "people/robin-vale");
  expect(me).toContain("Halifax");
  expect(me).not.toMatch(/Your (?:\w+ )?(?:projects|decisions)/);
});

test("G726 a reader who can't see one listed page loses that whole sentence, never just the name", () => {
  const root = brain();
  renderTouchedPages(root, SINCE);
  const read = (agent: string) => (readNote(root, agent, "people/robin-vale") as { body: string }).body;
  // The reader reads the owner's page and both work projects.
  expect(read("reader")).toContain("Your work projects: [[projects/course-a|Course A]] and [[projects/course-b|Course B]].");
  // Course B turns private after the writer ran: the reader (personal at most) can't see it.
  const f = join(root, "projects", "course-b.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  commit(root);
  const g = read("reader");
  expect(g).not.toContain("Your work projects");
  expect(g).not.toContain("Course A");
  expect(g).not.toContain("[[projects/course-a|Course A]]");
  // The other area's sentence stays: each sentence goes on its own pages' facts.
  expect(g).toContain("Your personal projects: [[projects/garden-shed|Garden shed]].");
  // The owner's own file is unchanged until the writer runs again.
  expect(body(root, "people/robin-vale")).toContain("Your work projects:");
});

test("G726 a fact behind a listed name hidden from the reader drops the sentence too", () => {
  const root = brain();
  renderTouchedPages(root, SINCE);
  const f = join(root, "projects", "garden-shed.md");
  // The writer wrote the page out in block form; its one fact turns private.
  writeFileSync(f, readFileSync(f, "utf8").replace("    recorded: 2026-10-05\n", "    recorded: 2026-10-05\n    sensitivity: private\n"));
  commit(root);
  const g = (readNote(root, "reader", "people/robin-vale") as { body: string }).body;
  expect(g).not.toContain("Garden shed");
  expect(g).toContain("Your work projects:");
});

test("G733 two listed pages with the same last name each keep their own source in the footnote they share", () => {
  const root = brain();
  page(root, "projects/atlas", "project", "Atlas", fact("next_step", "ship the beta", "gmail:f000000000000011"));
  page(root, "decisions/atlas", "decision", "Atlas call", fact("chose", "ship in spring", "gmail:f000000000000012"), { extra: "decided_on: 2026-10-03\n" });
  commit(root);
  renderTouchedPages(root, SINCE);
  const me = body(root, "people/robin-vale");
  expect(me).toContain("[[projects/atlas|Atlas]]");
  expect(me).toContain("[[decisions/atlas|Atlas call]]");
  const def = me.match(/^\[\^p-see-atlas\]: (.*)$/m)?.[1] ?? "";
  expect(def).toContain("gmail:f000000000000011");
  expect(def).toContain("gmail:f000000000000012");
});
