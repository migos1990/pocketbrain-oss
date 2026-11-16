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
import { renderTouchedPages, rawGuess } from "../src/wiki";
import { loadBrain } from "../src/brain";
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
  writeFileSync(join(root, "people", "tove-ek.md"), `${head("people/tove-ek", "person", "Tove Ek")}facts:\n  org: ${rec("[[orgs/northwind-brightwell]]", "instinct-mem:notes/tove-e")}\n---\n`);
  // Sourced: a mail states it.
  writeFileSync(join(root, "people", "maya-chen.md"), `${head("people/maya-chen", "person", "Maya Chen")}facts:\n  org: ${rec("[[orgs/harbourline]]", "gmail:f0000000000000a1", "verified-by-source")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: people");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  return root;
}

test("each line's state: the owner's word, a source that states it, or a guess", () => {
  expect(lineState({ value: "x", sources: ["owner:2026-10-01/box"], verification: "confirmed-by-owner" } as never)).toBe("yours");
  expect(lineState({ value: "x", sources: ["gmail:f0000000000000a1"], verification: "verified-by-source" } as never)).toBe("sourced");
  expect(lineState({ value: "x", sources: ["instinct-mem:notes/tove-e"], verification: "unverified" } as never)).toBe("guess");
  expect(lineState({ value: "x", sources: ["notion:abc"], verification: "verified-by-source" } as never)).toBe("guess");
  expect(lineState({ value: "x", sources: ["agent:planner/chat"], verification: "self-reported" } as never)).toBe("guess");
  expect(lineState({ value: "x", sources: ["gmail:f0000000000000a1"], verification: "verified-by-source", confidence: "inferred" } as never)).toBe("guess");
});

test("a guess is said as a guess and links no page; a sourced line reads plainly", () => {
  const root = brain();
  const tove = body(root, "people/tove-ek");
  expect(tove).toContain("Not confirmed: Tove Ek works at Northwind / Brightwell.");
  expect(tove).not.toContain("[[orgs/northwind-brightwell");
  const maya = body(root, "people/maya-chen");
  expect(maya).toContain("Maya Chen works at [[orgs/harbourline|Harbourline]].");
  expect(maya).not.toContain("Not confirmed");
});

test("a guess feeds no other page: the org it names doesn't list the person", () => {
  const root = brain();
  expect(body(root, "orgs/northwind-brightwell")).not.toContain("people/tove-ek");
  expect(body(root, "orgs/harbourline")).toContain("people/maya-chen");
});

test("a page written before stating a guess plainly is healed on the next pass, untouched", () => {
  const root = makeBrain();
  roots.push(root);
  mkdirSync(join(root, "orgs"), { recursive: true });
  const org = join(root, "orgs", "northwind-brightwell.md"), tove = join(root, "people", "tove-ek.md");
  writeFileSync(org, `${head("orgs/northwind-brightwell", "org", "Northwind / Brightwell")}---\n`);
  writeFileSync(tove, `${head("people/tove-ek", "person", "Tove Ek")}facts:\n  org: ${rec("[[orgs/northwind-brightwell]]", "instinct-mem:notes/tove-e")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: the pages");
  // The page writer's text from before G844, committed as the writer.
  writeFileSync(org, readFileSync(org, "utf8") + "\n[[people/tove-ek|Tove Ek]] works at Northwind / Brightwell.[^p-at-tove-ek]\n\n(Written by the hub from this page's facts.)\n\n[^p-at-tove-ek]: An assistant's memory, 2026-08-03 (instinct-mem:notes/tove-e)\n");
  writeFileSync(tove, readFileSync(tove, "utf8") + "\nTove Ek works at [[orgs/northwind-brightwell|Northwind / Brightwell]].[^pf-org]\n\n(Written by the hub from this page's facts.)\n\n[^pf-org]: An assistant's memory, 2026-08-03 (instinct-mem:notes/tove-e)\n");
  sh(root, "hub", "commit", "-qam", "hub: pages written");
  // Nothing changed since now: only the healing brings these pages in.
  renderTouchedPages(root, "2099-01-01T00:00:00Z");
  expect(body(root, "people/tove-ek")).toContain("Not confirmed: Tove Ek works at Northwind / Brightwell.");
  expect(body(root, "orgs/northwind-brightwell")).not.toContain("people/tove-ek");
});

// The live hub, 2026-11-14 (shape only): an assistant filed how the owner knows someone from a mail
// whose sender no person page holds; it cited the mail, so it read as sourced. A sender nobody
// vouches for can claim a thing, not establish it: a record filed under that mark (`sender:
// unknown`, set by write() on a stranger's private or money fact, src/sender.ts) is a guess whatever
// its attribute (G868). The owner's own yes on it is still the owner's word.
test("a record from a sender no page holds is a guess, whatever it cites; the owner's yes makes it his", () => {
  const mail = { value: "x", sources: ["gmail:f0000000000000a1"], verification: "verified-by-source" };
  expect(lineState({ ...mail, sender: "unknown" } as never)).toBe("guess");
  expect(lineState({ ...mail, verification: "self-reported", sender: "unknown" } as never)).toBe("guess");
  expect(lineState({ ...mail, sources: [...mail.sources, "approved:2026-10-08/inbox"], sender: "unknown" } as never)).toBe("yours");
  expect(lineState({ ...mail, verification: "confirmed-by-owner", sender: "unknown" } as never)).toBe("yours");
});

test("on the page it is said as a guess, links nothing and lists nobody (G868)", () => {
  const root = brain();
  // Let out by the owner already (no `unseen`): the mark stays, and so does the guess.
  writeFileSync(join(root, "people", "pat-quill.md"), `${head("people/pat-quill", "person", "Pat Quill")}facts:\n  org: { value: "[[orgs/harbourline]]", as_of: 2026-09-15, sources: ["gmail:f0000000000000b2"], verification: self-reported, by: planner, recorded: 2026-09-15, sender: unknown }\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: a stranger's mail");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body(root, "people/pat-quill")).toContain("Not confirmed: Pat Quill works at Harbourline.");
  expect(body(root, "people/pat-quill")).not.toContain("[[orgs/harbourline");
  expect(body(root, "orgs/harbourline")).not.toContain("people/pat-quill");
  expect(body(root, "orgs/harbourline")).toContain("people/maya-chen");
});

test("a stranger's guess the page keeps back gives the heal step nothing to do (G868)", () => {
  const root = brain();
  // Private on a personal page: the page writer never says it, so there is no line to heal.
  writeFileSync(join(root, "people", "pat-quill.md"), `${head("people/pat-quill", "person", "Pat Quill")}facts:\n  org: { value: "[[orgs/harbourline]]", as_of: 2026-09-15, sources: ["gmail:f0000000000000b2"], verification: self-reported, by: planner, recorded: 2026-09-15, sender: unknown, sensitivity: private }\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: a stranger's private mail");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body(root, "people/pat-quill")).not.toContain("Harbourline");
  expect([...rawGuess(loadBrain(root))]).not.toContain("people/pat-quill");
});

test("a page whose firm fact links the same page a guess names has nothing to heal", () => {
  const root = brain();
  // Sourced: Maya works at Harbourline. A guess beside it names the same page.
  writeFileSync(join(root, "people", "maya-chen.md"), `${head("people/maya-chen", "person", "Maya Chen")}facts:\n  org: ${rec("[[orgs/harbourline]]", "gmail:f0000000000000a1", "verified-by-source")}\n  met_at: ${rec("[[orgs/harbourline]]", "instinct-mem:entities/people/maya")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: a guess beside a source");
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body(root, "people/maya-chen")).toContain("[[orgs/harbourline");
  expect(body(root, "people/maya-chen")).toContain("Not confirmed:");
  expect([...rawGuess(loadBrain(root))]).not.toContain("people/maya-chen");
});

test("a link is its exact id: a firm fact linking a longer id keeps nothing for a guess naming a shorter one", () => {
  const root = brain();
  writeFileSync(join(root, "orgs", "harbour.md"), `${head("orgs/harbour", "org", "Harbour")}---\n`);
  // Written before the rule: the text links the page only a guess names. The firm fact links
  // orgs/harbourline, whose id starts with orgs/harbour.
  writeFileSync(join(root, "people", "maya-chen.md"), `${head("people/maya-chen", "person", "Maya Chen")}facts:\n  org: ${rec("[[orgs/harbourline]]", "gmail:f0000000000000a1", "verified-by-source")}\n  met_at: ${rec("[[orgs/harbour]]", "instinct-mem:entities/people/maya")}\n---\nNot confirmed: something else.\n\nMaya Chen met you at [[orgs/harbour|Harbour]].\n`);
  expect([...rawGuess(loadBrain(root))]).toContain("people/maya-chen");
  // And the other way: text that links only the longer id owes the shorter guess nothing.
  writeFileSync(join(root, "people", "maya-chen.md"), `${head("people/maya-chen", "person", "Maya Chen")}facts:\n  met_at: ${rec("[[orgs/harbour]]", "instinct-mem:entities/people/maya")}\n---\nNot confirmed: Maya Chen met you at Harbour.\n\nSee [[orgs/harbourline|Harbourline]].\n`);
  expect([...rawGuess(loadBrain(root))]).not.toContain("people/maya-chen");
});
