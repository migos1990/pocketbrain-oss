// SPDX-License-Identifier: AGPL-3.0-only
// The owner, 2026-11-07, on his school's org page: "it should have understood by then that I teach
// there, and these are the people I'm interacting with." An org page opens with the owner's own tie
// to it, from his own page's role and org facts (G702); the people there are said by how the owner
// knows them, from their relationship facts, before the rest who just work there (G703); and the
// pages whose sources name it are one sentence, not one "also comes up in the sources of" each
// (G704). A read drops each sentence once a fact behind it is out of that reader's view.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages, pageLead } from "../src/wiki";
import { loadBrain, saveNote, type Note } from "../src/brain";
import { readNote } from "../src/core";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const SINCE = "2000-01-01T00:00:00Z";
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---");
const read = (root: string, agent: string, id: string) => (readNote(root, agent, id) as { body: string }).body;
const fact = (value: string, mail: string) => `{ value: "${value}", as_of: 2026-10-05, sources: ["gmail:${mail}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;
const head = (id: string, type: string, title: string) => `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;

function brain() {
  const root = makeBrain();
  const policy = join(root, "rules", "policy.yaml");
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(policy, readFileSync(policy, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  writeFileSync(join(root, "orgs", "north-college.md"), `${head("orgs/north-college", "org", "North College")}---\n`);
  writeFileSync(join(root, "people", "robin-vale.md"), `${head("people/robin-vale", "person", "Robin Vale")}facts:\n  role: ${fact("lecturer", "f0000000000000b0")}\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b0")}\n---\n`);
  writeFileSync(join(root, "people", "ana-diaz.md"), `${head("people/ana-diaz", "person", "Ana Diaz")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b1")}\n  relationship: ${fact("colleague", "f0000000000000b1")}\n---\n`);
  writeFileSync(join(root, "people", "ben-roy.md"), `${head("people/ben-roy", "person", "Ben Roy")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b2")}\n  relationship: ${fact("colleague", "f0000000000000b2")}\n---\n`);
  writeFileSync(join(root, "people", "cara-lee.md"), `${head("people/cara-lee", "person", "Cara Lee")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b3")}\n  relationship: ${fact("student", "f0000000000000b3")}\n---\n`);
  writeFileSync(join(root, "people", "dan-poe.md"), `${head("people/dan-poe", "person", "Dan Poe")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b4")}\n  relationship: ${fact("works with Robin Vale on the course", "f0000000000000b4")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: the college");
  renderTouchedPages(root, SINCE);
  return root;
}

test("G702 an org page opens with the owner's own tie to it, from his own role and org facts", () => {
  const root = brain();
  const b = body(root, "orgs/north-college");
  const first = b.trim().split("\n")[0]!;
  expect(first.startsWith("You work as a lecturer at North College.")).toBe(true);
  // He isn't listed by his own name among the people there.
  expect(b).not.toContain("Robin Vale|");
});

test("G702 a reader who can't see the owner's role or org gets no tie sentence", () => {
  const root = brain();
  expect(read(root, "helper", "orgs/north-college")).toContain("You work as a lecturer at North College.");
  const n = loadBrain(root).find((x) => x.fm.id === "people/robin-vale")!;
  n.fm.sensitivity = "private";
  saveNote(root, n);
  sh(root, "louis", "commit", "-qam", "owner: his page private");
  const b = read(root, "helper", "orgs/north-college");
  expect(b).not.toContain("You work");
  expect(b).not.toContain("lecturer");
});

test("G703 the people at an org are said by how the owner knows them, then the rest", () => {
  const root = brain();
  const b = body(root, "orgs/north-college");
  expect(b).toContain("[[people/ana-diaz|Ana Diaz]] and [[people/ben-roy|Ben Roy]] work at North College: your colleagues.");
  expect(b).toContain("[[people/cara-lee|Cara Lee]] works at North College: your student.");
  // A relationship that says what someone does, not who they are to him, isn't made a noun.
  expect(b).toContain("[[people/dan-poe|Dan Poe]] works at North College.");
  expect(b).not.toContain("your works");
});

test("G704 the pages whose sources name a page are one sentence", () => {
  const rec = (m: string) => ({ value: "x", sources: [`gmail:${m}`], verification: "verified-by-source", by: "planner", recorded: "2026-10-05" });
  const page = (id: string, title: string) => ({ fm: { id, type: "project", title }, body: "", path: "" }) as unknown as Note;
  const org = { fm: { id: "orgs/north-college", type: "org", title: "North College" }, body: "", path: "" } as unknown as Note;
  const a = page("projects/exam-due", "Intra exam due"), c = page("projects/session-moved", "Session moved");
  const byId = new Map([org, a, c].map((n) => [n.fm.id, n]));
  const lead = pageLead(org, { hidden: () => false, blind: () => false, names: new Map(), byId, namedIn: [{ from: a.fm.id, rec: rec("f0000000000000c1") as never }, { from: c.fm.id, rec: rec("f0000000000000c2") as never }] })!;
  expect(lead.text.match(/comes up in the sources of/g)?.length).toBe(1);
  expect(lead.text).toContain("North College also comes up in the sources of [[projects/exam-due|Intra exam due]] and [[projects/session-moved|Session moved]].[^p-in-exam-due][^p-in-session-moved]");
});
