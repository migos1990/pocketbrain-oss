// SPDX-License-Identifier: AGPL-3.0-only
// G844: a line backed only by an assistant's memory or imported free text read as plain truth. On
// the owner's brain a person's page said "X works at A / B", cited "An assistant's memory", linking
// an organisation page that the same line had made; the person never worked there. Every line is in
// one of three states (plans/wrong-grouping-family, rule 5): the owner's word, a source that states
// it, or a guess. A guess is said as a guess, links no page, and feeds no other page: the org page
// doesn't list the person, and a page it names doesn't link back. Temp brains removed after.
import { test, expect, afterAll } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { lineState } from "../src/sources";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---");
const head = (id: string, type: string, title: string) => `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;
const rec = (value: string, ref: string, verification = "unverified") => `{ value: "${value}", as_of: 2026-09-15, sources: ["${ref}"], verification: ${verification}, by: planner, recorded: 2026-09-15 }`;

function brain() {
  const root = makeBrain();
  roots.push(root);
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "northwind-brightwell.md"), `${head("orgs/northwind-brightwell", "org", "Northwind / Brightwell")}---\n`);
  writeFileSync(join(root, "orgs", "harbourline.md"), `${head("orgs/harbourline", "org", "Harbourline")}---\n`);
  // A guess: only an assistant's memory says it.
  writeFileSync(join(root, "people", "oli-stone.md"), `${head("people/oli-stone", "person", "Oli Stone")}facts:\n  org: ${rec("[[orgs/northwind-brightwell]]", "instinct-mem:entities/people/oli")}\n---\n`);
  // Sourced: a mail states it.
  writeFileSync(join(root, "people", "maya-chen.md"), `${head("people/maya-chen", "person", "Maya Chen")}facts:\n  org: ${rec("[[orgs/harbourline]]", "gmail:f0000000000000a1", "verified-by-source")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: people");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  return root;
}

test("each line's state: the owner's word, a source that states it, or a guess", () => {
  expect(lineState({ value: "x", sources: ["owner:2026-10-01/box"], verification: "confirmed-by-owner" } as never)).toBe("yours");
  expect(lineState({ value: "x", sources: ["gmail:f0000000000000a1"], verification: "verified-by-source" } as never)).toBe("sourced");
  expect(lineState({ value: "x", sources: ["instinct-mem:entities/people/oli"], verification: "unverified" } as never)).toBe("guess");
  expect(lineState({ value: "x", sources: ["notion:abc"], verification: "verified-by-source" } as never)).toBe("guess");
  expect(lineState({ value: "x", sources: ["agent:planner/chat"], verification: "self-reported" } as never)).toBe("guess");
  expect(lineState({ value: "x", sources: ["gmail:f0000000000000a1"], verification: "verified-by-source", confidence: "inferred" } as never)).toBe("guess");
});

test("a guess is said as a guess and links no page; a sourced line reads plainly", () => {
  const root = brain();
  const oli = body(root, "people/oli-stone");
  expect(oli).toContain("Not confirmed: Oli Stone works at Northwind / Brightwell.");
  expect(oli).not.toContain("[[orgs/northwind-brightwell");
  const maya = body(root, "people/maya-chen");
  expect(maya).toContain("Maya Chen works at [[orgs/harbourline|Harbourline]].");
  expect(maya).not.toContain("Not confirmed");
});

test("a guess feeds no other page: the org it names doesn't list the person", () => {
  const root = brain();
  expect(body(root, "orgs/northwind-brightwell")).not.toContain("people/oli-stone");
  expect(body(root, "orgs/harbourline")).toContain("people/maya-chen");
});

test("a page written before stating a guess plainly is healed on the next pass, untouched", () => {
  const root = makeBrain();
  roots.push(root);
  mkdirSync(join(root, "orgs"), { recursive: true });
  const org = join(root, "orgs", "northwind-brightwell.md"), oli = join(root, "people", "oli-stone.md");
  writeFileSync(org, `${head("orgs/northwind-brightwell", "org", "Northwind / Brightwell")}---\n`);
  writeFileSync(oli, `${head("people/oli-stone", "person", "Oli Stone")}facts:\n  org: ${rec("[[orgs/northwind-brightwell]]", "instinct-mem:entities/people/oli")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: the pages");
  // The page writer's text from before G844, committed as the writer.
  writeFileSync(org, readFileSync(org, "utf8") + "\n[[people/oli-stone|Oli Stone]] works at Northwind / Brightwell.[^p-at-oli-stone]\n\n(Written by the hub from this page's facts.)\n\n[^p-at-oli-stone]: An assistant's memory, 2026-09-15 (instinct-mem:entities/people/oli)\n");
  writeFileSync(oli, readFileSync(oli, "utf8") + "\nOli Stone works at [[orgs/northwind-brightwell|Northwind / Brightwell]].[^pf-org]\n\n(Written by the hub from this page's facts.)\n\n[^pf-org]: An assistant's memory, 2026-09-15 (instinct-mem:entities/people/oli)\n");
  sh(root, "hub", "commit", "-qam", "hub: pages written");
  // Nothing changed since now: only the healing brings these pages in.
  renderTouchedPages(root, "2100-01-01T00:00:00Z");
  expect(body(root, "people/oli-stone")).toContain("Not confirmed: Oli Stone works at Northwind / Brightwell.");
  expect(body(root, "orgs/northwind-brightwell")).not.toContain("people/oli-stone");
});
