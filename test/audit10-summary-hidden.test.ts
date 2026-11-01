// SPDX-License-Identifier: AGPL-3.0-only
// Audit v10, 2026-11-01 (finding 4b, G608): a page's one-line summary is plain words with no
// reference, so a read's sentence scrub (view.ts) never touches it. Written while a fact was shown
// to every reader, it kept saying that fact after the owner made it private, and nothing listed the
// page for a new summary (wiki_missing held only pages with none). Now the summary carries the facts
// it was written from (summary_facts, set by wiki_sync); a reader from whom one of them is hidden
// gets no summary, an older summary with no such list goes to no reader who has any fact of the page
// hidden, and the Gardener's wiki_missing lists every page whose summary some reader no longer gets.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { readNote, gardenerWikiSync, gardenerLast } from "../src/core";
import { git } from "../src/git";

const ID = "people/sam-lee";
function brain(summary?: string) {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.wiki = { sync: true };
  writeFileSync(f, YAML.stringify(p));
  mkdirSync(join(root, "people"), { recursive: true });
  writeFileSync(join(root, `${ID}.md`), `---\nid: ${ID}\ntype: person\ntitle: Sam Lee\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n${summary ? `summary: ${summary}\n` : ""}facts:\n  role: { value: program director, as_of: 2026-10-05, sources: ["gmail:f0000000000000b1"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n  hobby: { value: rock climbing, as_of: 2026-10-05, sources: ["gmail:f0000000000000b2"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n---\nSam runs the program.\n`);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner: sam"], "owner");
  return root;
}
const summaryFor = (root: string, agent: string) => (readNote(root, agent, ID) as { summary?: string }).summary;
const hideRole = (root: string) => {
  const n = loadBrain(root).find((x) => x.fm.id === ID)!;
  (n.fm.facts!.role as FactRecord).sensitivity = "private";
  saveNote(root, n);
  git(root, ["commit", "-qam", "owner: role private"], "owner");
};

test("a summary the Gardener wrote from a fact goes from a reader once that fact is hidden from it", () => {
  const was = process.env.PB_NOW;
  process.env.PB_NOW = "2026-10-08T07:30:00Z";
  try {
    const root = brain();
    const r = gardenerWikiSync(root, "gardener", { id: ID, summary: "Sam Lee leads the program." });
    expect(r.applied).toBe(true);
    expect(summaryFor(root, "helper")).toBe("Sam Lee leads the program.");
    hideRole(root);
    // helper (trial, up to personal) no longer sees the role: nor the summary that says it.
    expect(summaryFor(root, "helper")).toBeUndefined();
    // A reader who still sees the role keeps the summary.
    expect(summaryFor(root, "planner")).toBe("Sam Lee leads the program.");
    // The Gardener is told to write it again.
    expect(gardenerLast(root, "gardener").wiki_missing).toContain(ID);
  } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
});

test("hiding a fact the summary wasn't written from leaves it to every reader", () => {
  const was = process.env.PB_NOW;
  process.env.PB_NOW = "2026-10-08T07:30:00Z";
  try {
    const root = brain();
    // The hobby is private before the summary is written: the summary comes from the role alone.
    const n = loadBrain(root).find((x) => x.fm.id === ID)!;
    (n.fm.facts!.hobby as FactRecord).sensitivity = "private";
    saveNote(root, n);
    git(root, ["commit", "-qam", "owner: hobby private"], "owner");
    expect(gardenerWikiSync(root, "gardener", { id: ID, summary: "Sam Lee leads the program." }).applied).toBe(true);
    expect(summaryFor(root, "helper")).toBe("Sam Lee leads the program.");
    expect(gardenerLast(root, "gardener").wiki_missing).not.toContain(ID);
  } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
});

test("an older summary that names no facts goes to no reader with a fact of the page hidden", () => {
  const root = brain("Sam Lee leads the program.");
  expect(summaryFor(root, "helper")).toBe("Sam Lee leads the program.");
  hideRole(root);
  expect(summaryFor(root, "helper")).toBeUndefined();
  expect(summaryFor(root, "planner")).toBe("Sam Lee leads the program.");
});
