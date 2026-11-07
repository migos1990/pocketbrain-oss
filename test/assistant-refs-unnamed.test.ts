// SPDX-License-Identifier: AGPL-3.0-only
// Builder's slice audit of G720 (backlog 422): an agent never learns which other assistants exist
// (G30; agentRecord strips by). A fact's raw ref "agent:helper/…" still told the planner that
// helper filed it, in readNote's facts, in its cell and in the lines search and context packs
// read (G722); a page's footnote "Helper's note, … (agent:helper/…)" told it the same (G723). A
// reader gets "agent:[withheld]" and "An assistant's note"; its own refs stay as they are,
// and the owner's own view keeps every name byte for byte.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { readNote, why } from "../src/core";
import { buildCell, cellDir } from "../src/cell";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const PAGE = `---\nid: people/ana-diaz\ntype: person\ntitle: Ana Diaz\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: helper\nfacts:\n  role: { value: "lecturer", as_of: 2026-11-02, sources: ["agent:helper/2026-11-02"], verification: self-reported, by: helper, recorded: 2026-11-02 }\n  org: { value: "North College", as_of: 2026-11-02, sources: ["agent:planner/2026-11-02"], verification: self-reported, by: planner, recorded: 2026-11-02 }\n---\nAna Diaz works as lecturer.[^pf-role] Her org is North College.[^pf-org]\n\n[^pf-role]: Helper's note, 2026-11-02 (agent:helper/2026-11-02)\n[^pf-org]: Planner's note, 2026-11-02 (agent:planner/2026-11-02)\n`;
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "people", "ana-diaz.md"), PAGE);
  sh(root, "helper", "add", "-A"); sh(root, "helper", "commit", "-qm", "helper: Ana");
  return root;
}
const note = (root: string, agent: string) => readNote(root, agent, "people/ana-diaz") as { body: string; facts: Record<string, { sources: string[] }> };

test("G722 a reader's facts never carry another assistant's ref; its own stay as they are", () => {
  const root = brain();
  const p = note(root, "planner");
  expect(JSON.stringify(p.facts)).not.toMatch(/helper/i);
  expect(p.facts.role.sources).toEqual(["agent:[withheld]"]);
  expect(p.facts.org.sources).toEqual(["agent:planner/2026-11-02"]);
  buildCell(root, "planner");
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]);
  for (const f of files(cellDir(root, "planner"))) expect(readFileSync(f, "utf8")).not.toMatch(/agent:helper|Helper's note/);
});

test("G723 a page's footnotes never name another assistant to a reader; the owner's file keeps every name", () => {
  const root = brain();
  const b = note(root, "planner").body;
  expect(b).not.toMatch(/helper/i);
  expect(b).toContain("[^pf-role]: An assistant's note, 2026-11-02 (agent:[withheld])");
  expect(b).toContain("[^pf-org]: Planner's note, 2026-11-02 (agent:planner/2026-11-02)");
  expect(readFileSync(join(root, "people", "ana-diaz.md"), "utf8")).toBe(PAGE);
});

test("G722 why on a fact another assistant filed never names it to a reader; the owner's why does", () => {
  const root = brain();
  const w = why(root, "planner", "people/ana-diaz#role");
  expect(JSON.stringify(w)).not.toMatch(/helper/i);
  expect(w.current[0]!.sources[0]!.ref).toBe("agent:[withheld]");
  expect(JSON.stringify(why(root, "planner", "people/ana-diaz#org"))).toContain("agent:planner/2026-11-02");
});
