// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10, 2026-11-01 (finding 4a, G607): the writer's sentences that state another page's fact
// (an org's "Ana Diaz works at North College", "comes up in the sources of", "See also") cite labels
// of their own (p-at-, p-in-, p-see-). An agent's read dropped only the sentences of the page's OWN
// hidden facts (view.ts hiddenAttrs), so a fact hidden from it after the writer last ran still
// showed through another page's sentence until that page was written again, or forever when it never
// was. Now a read drops such a sentence when the fact behind it, on the other page, is hidden from
// that reader, or the other page is out of its view.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { loadBrain, saveNote, type Note, type FactRecord } from "../src/brain";
import { readNote } from "../src/core";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const SINCE = "2000-01-01T00:00:00Z";
const read = (root: string, agent: string, id: string) => (readNote(root, agent, id) as { body: string }).body;

function brain() {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `---\nid: orgs/north-college\ntype: org\ntitle: North College\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  writeFileSync(join(root, "people", "ana-diaz.md"), `---\nid: people/ana-diaz\ntype: person\ntitle: Ana Diaz\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  org: { value: "[[North College]]", as_of: 2026-10-05, sources: ["gmail:f0000000000000a2"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n  role: { value: program director, as_of: 2026-10-05, sources: ["gmail:f0000000000000a1"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: ana and north college");
  renderTouchedPages(root, SINCE);
  return root;
}
const edit = (root: string, id: string, f: (n: Note) => void) => {
  const n = loadBrain(root).find((x) => x.fm.id === id)!;
  f(n);
  saveNote(root, n);
  sh(root, "louis", "commit", "-qam", `owner: ${id}`);
};
const rec = (n: Note, attr: string) => n.fm.facts![attr] as FactRecord;

test("an org's members sentence goes from a read once the person's org fact is hidden from that reader", () => {
  const root = brain();
  expect(read(root, "helper", "orgs/north-college")).toContain("works at North College");
  // The owner keeps Ana's org to the steward only, after the writer ran (no rerun in between).
  edit(root, "people/ana-diaz", (n) => { rec(n, "org").share_with = ["steward"]; });
  const b = read(root, "helper", "orgs/north-college");
  expect(b).not.toContain("works at North College");
  expect(b).not.toContain("gmail:f0000000000000a2");
  expect(b).not.toContain("Ana Diaz");
  // The one it was kept for still reads it.
  expect(read(root, "steward", "orgs/north-college")).toContain("works at North College");
});

test("the same when the person's page itself leaves the reader's view", () => {
  const root = brain();
  expect(read(root, "helper", "orgs/north-college")).toContain("works at North College");
  edit(root, "people/ana-diaz", (n) => { n.fm.sensitivity = "private"; });
  const b = read(root, "helper", "orgs/north-college");
  expect(b).not.toContain("works at North College");
  expect(b).not.toContain("gmail:f0000000000000a2");
  // planner (core, up to private) still sees Ana's page and its org fact: the sentence stays for it.
  expect(read(root, "planner", "orgs/north-college")).toContain("works at North College");
});

test("a fact of the person that the sentence doesn't state hiding leaves the sentence alone", () => {
  const root = brain();
  edit(root, "people/ana-diaz", (n) => { rec(n, "role").share_with = ["steward"]; });
  expect(read(root, "helper", "orgs/north-college")).toContain("works at North College");
});

test("an older lead that reused the org's own label for the members sentence loses it too", () => {
  const root = brain();
  // The org cites the same mail for a fact of its own; an older writer gave both sentences one label.
  edit(root, "orgs/north-college", (n) => {
    n.fm.facts = { status: { value: "open", as_of: "2026-10-05", sources: ["gmail:f0000000000000a2"], verification: "verified-by-source", by: "planner", recorded: "2026-10-05" } as never };
    n.body = "North College is open.[^p-status] [[people/ana-diaz|Ana Diaz]] works at North College.[^p-status]\n\n(Written by the hub from this page's facts.)\n\n[^p-status]: Email, 2026-10-05 (gmail:f0000000000000a2)\n";
  });
  expect(read(root, "helper", "orgs/north-college")).toContain("works at North College");
  edit(root, "people/ana-diaz", (n) => { rec(n, "org").share_with = ["steward"]; });
  const b = read(root, "helper", "orgs/north-college");
  expect(b).not.toContain("works at North College");
  expect(b).not.toContain("Ana Diaz");
});

test("the writer gives a members sentence its own label even when its reference matches one of the page's", () => {
  const root = brain();
  edit(root, "orgs/north-college", (n) => {
    n.fm.facts = { status: { value: "open", as_of: "2026-10-05", sources: ["gmail:f0000000000000a2"], verification: "verified-by-source", by: "planner", recorded: "2026-10-05" } as never };
  });
  renderTouchedPages(root, SINCE);
  const b = loadBrain(root).find((x) => x.fm.id === "orgs/north-college")!.body;
  expect(b).toMatch(/works at North College\.\[\^p-at-ana-diaz\]/);
});

// Audit v10 second report (Medium, G612): links_to, mentioned_in and context_pack's Connected line
// read links from the body with only redactLinks, so the link inside a hidden fact's sentence (the
// one scrubPage drops from the text) still named the page it pointed to.
test("a link only a hidden fact's sentence carries names no page in links_to or mentioned_in", () => {
  const root = brain();
  const before = readNote(root, "helper", "people/ana-diaz") as { links_to: { id: string }[] };
  expect(before.links_to.map((x) => x.id)).toContain("orgs/north-college");
  edit(root, "people/ana-diaz", (n) => { rec(n, "org").share_with = ["steward"]; });
  const ana = readNote(root, "helper", "people/ana-diaz") as { body: string; links_to: { id: string }[] };
  expect(ana.body).not.toContain("North College");
  expect(ana.links_to.map((x) => x.id)).not.toContain("orgs/north-college");
  const org = readNote(root, "helper", "orgs/north-college") as { mentioned_in: { id: string }[] };
  expect(org.mentioned_in.map((x) => x.id)).not.toContain("people/ana-diaz");
});

// PR 30 security review (Low): the label names the other page by its short name only (p-at-ana-diaz),
// so a visible page of another kind with the same short name (projects/ana-diaz) stood in for a
// hidden person page, and the sentence about the hidden one stayed. The sentence's own link decides.
test("a visible page sharing the hidden page's short name doesn't keep the sentence", () => {
  const root = brain();
  writeFileSync(join(root, "projects", "ana-diaz.md"), `---\nid: projects/ana-diaz\ntype: project\ntitle: Ana Diaz Fund\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: a namesake project");
  edit(root, "people/ana-diaz", (n) => { n.fm.sensitivity = "private"; });
  const b = read(root, "helper", "orgs/north-college");
  expect((readNote(root, "helper", "projects/ana-diaz") as { title: string }).title).toBe("Ana Diaz Fund");
  expect(b).not.toContain("works at North College");
  expect(b).not.toContain("gmail:f0000000000000a2");
});
