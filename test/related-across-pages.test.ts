// SPDX-License-Identifier: AGPL-3.0-only
// The owner, 2026-11-06: "org, project, people, notes, all of them are sometimes related … like an org
// as people who are tied to projects" (audit v12: nothing crosses pages). A page says how the pages
// it links are tied to each other, from the facts that tie them, each sentence cited by both facts:
// an org says which of its people are on which project (G685), a project says where its people work
// (G686), a person says who else is on their projects and who else is at their org (G687). A read
// drops such a sentence when any fact behind it, or any page it names, is out of that reader's view.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { loadBrain, saveNote, type Note, type FactRecord } from "../src/brain";
import { readNote } from "../src/core";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const SINCE = "2000-01-01T00:00:00Z";
const read = (root: string, agent: string, id: string) => (readNote(root, agent, id) as { body: string }).body;
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---");
const fact = (value: string, mail: string) => `{ value: "${value}", as_of: 2026-10-05, sources: ["gmail:${mail}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;
const head = (id: string, type: string, title: string) => `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;

function brain() {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `${head("orgs/north-college", "org", "North College")}---\n`);
  writeFileSync(join(root, "orgs", "east-lab.md"), `${head("orgs/east-lab", "org", "East Lab")}---\n`);
  writeFileSync(join(root, "people", "ana-diaz.md"), `${head("people/ana-diaz", "person", "Ana Diaz")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000a1")}\n---\n`);
  writeFileSync(join(root, "people", "ben-roy.md"), `${head("people/ben-roy", "person", "Ben Roy")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000a2")}\n---\n`);
  writeFileSync(join(root, "people", "cara-lee.md"), `${head("people/cara-lee", "person", "Cara Lee")}facts:\n  org: ${fact("[[orgs/east-lab]]", "f0000000000000a3")}\n---\n`);
  writeFileSync(join(root, "projects", "spring-course.md"), `${head("projects/spring-course", "project", "Spring course")}facts:\n  people:\n    items:\n      - ${fact("[[people/ana-diaz]]", "f0000000000000a4")}\n      - ${fact("[[people/cara-lee]]", "f0000000000000a4")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: the spring course");
  renderTouchedPages(root, SINCE);
  return root;
}
const edit = (root: string, id: string, f: (n: Note) => void) => {
  const n = loadBrain(root).find((x) => x.fm.id === id)!;
  f(n);
  saveNote(root, n);
  sh(root, "louis", "commit", "-qam", `owner: ${id}`);
};
// The reference a sentence cites, by the sentence's own words.
const cites = (b: string, words: string) => {
  const line = b.split(/(?<=\.(?:\[\^[^\]]+\])+)\s/).find((s) => s.includes(words)) ?? "";
  const labels = [...line.matchAll(/\[\^([^\]]+)\]/g)].map((m) => m[1]);
  return labels.map((l) => b.match(new RegExp(`^\\[\\^${l.replace(/[-]/g, "\\-")}\\]: (.*)$`, "m"))?.[1] ?? "").join(" ");
};

test("G685 an org says which of its people are on which project, cited by both facts", () => {
  const root = brain();
  const b = body(root, "orgs/north-college");
  expect(b).toContain("[[people/ana-diaz|Ana Diaz]] is on [[projects/spring-course|Spring course]].");
  const c = cites(b, "is on [[projects/spring-course");
  expect(c).toContain("gmail:f0000000000000a4"); // the project's people fact
  expect(c).toContain("gmail:f0000000000000a1"); // Ana's org fact
  // Ben is on no project: no sentence puts him on one.
  expect(b).not.toMatch(/Ben Roy\]\] (is|are) on/);
});

test("G686 a project says where its people work, one sentence per org", () => {
  const root = brain();
  const b = body(root, "projects/spring-course");
  expect(b).toContain("[[people/ana-diaz|Ana Diaz]] works at [[orgs/north-college|North College]].");
  expect(b).toContain("[[people/cara-lee|Cara Lee]] works at [[orgs/east-lab|East Lab]].");
  expect(cites(b, "works at [[orgs/east-lab")).toContain("gmail:f0000000000000a3");
  // The org it now names isn't named again as a bare See also.
  expect(b).not.toContain("See also [[orgs/north-college");
});

test("G687 a person says who else is on their project and who else is at their org", () => {
  const root = brain();
  const b = body(root, "people/ana-diaz");
  expect(b).toContain("is on [[projects/spring-course|Spring course]] with [[people/cara-lee|Cara Lee]].");
  expect(b).toContain("Also at [[orgs/north-college|North College]]: [[people/ben-roy|Ben Roy]].");
  expect(cites(b, "Also at [[orgs/north-college")).toContain("gmail:f0000000000000a2");
  // A second run writes nothing.
  const at = sh(root, "hub", "rev-parse", "HEAD");
  renderTouchedPages(root, SINCE);
  expect(sh(root, "hub", "rev-parse", "HEAD")).toBe(at);
});

test("G685 a read drops the sentence once a fact behind it is hidden from that reader", () => {
  const root = brain();
  expect(read(root, "helper", "orgs/north-college")).toContain("is on [[projects/spring-course");
  // The project's people kept to the steward, after the writer ran (no rerun in between).
  edit(root, "projects/spring-course", (n) => { for (const r of (n.fm.facts!.people as { items: FactRecord[] }).items) r.share_with = ["steward"]; });
  const b = read(root, "helper", "orgs/north-college");
  expect(b).not.toContain("is on");
  expect(b).not.toContain("Spring course");
  expect(b).not.toContain("gmail:f0000000000000a4");
  expect(read(root, "steward", "orgs/north-college")).toContain("is on [[projects/spring-course");
});

test("G686 a read drops the sentence once a person it names leaves that reader's view", () => {
  const root = brain();
  expect(read(root, "helper", "projects/spring-course")).toContain("works at [[orgs/east-lab");
  edit(root, "people/cara-lee", (n) => { n.fm.sensitivity = "private"; });
  const b = read(root, "helper", "projects/spring-course");
  expect(b).not.toContain("works at [[orgs/east-lab");
  expect(b).not.toContain("gmail:f0000000000000a3");
  // The other sentence stands.
  expect(b).toContain("works at [[orgs/north-college");
});
