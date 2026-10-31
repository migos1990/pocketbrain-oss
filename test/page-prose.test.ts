// SPDX-License-Identifier: AGPL-3.0-only
// The owner, 2026-10-31: the app's pages feel underwhelming. The hub's opening text read "Maya
// Chen's role is design lead. Maya Chen works at Harbourline Software. … Maya Chen's city is
// Montréal." with "(Written by the hub from this page's facts.)" inside the paragraph. A person
// reads like the owner's canvas: the full name once, then the first name; role and org in one
// sentence; a date this year without its year; the made-by line its own paragraph, after the text.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages, MADE } from "../src/wiki";
import { loadBrain } from "../src/brain";
import { proseBeyondHub } from "../scripts/north-star";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!.body.trim();
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: ${value}, as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n`;
function page(root: string, id: string, type: string, title: string, facts = "") {
  mkdirSync(join(root, id.split("/")[0]!), { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n${facts ? `facts:\n${facts}` : ""}---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", `planner: ${id}`);
}

function maya(lastContact = "2026-10-07") {
  const root = makeBrain();
  page(root, "orgs/harbourline", "org", "Harbourline Software");
  page(root, "people/maya-chen", "person", "Maya Chen",
    fact("role", "design lead", "gmail:f0000000000000a1") + fact("org", "\"[[orgs/harbourline]]\"", "gmail:f0000000000000a1")
    + fact("relationship", "works with you on Atlas", "gmail:f0000000000000a2") + fact("city", "Montréal", "gmail:f0000000000000a3")
    + fact("last_contact", lastContact, "gmail:f0000000000000a4"));
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  return root;
}

test("a person reads like a person: full name once, then the first name; role and org in one sentence; this year's dates without the year", () => {
  const lead = body(maya(), "people/maya-chen").split("\n\n")[0]!;
  expect(lead).toBe("Maya Chen is the design lead at [[orgs/harbourline|Harbourline Software]].[^p-role] Maya works with you on Atlas.[^p-relationship] Maya's city is Montréal.[^p-city] You were last in touch with Maya on 7 Oct.[^p-last-contact]");
});

test("a date from another year keeps its year", () => {
  expect(body(maya("2025-10-07"), "people/maya-chen")).toContain("You were last in touch with Maya on 7 Oct 2025.");
});

test("the made-by line is its own paragraph after the opening text, and still marks the writer's text", () => {
  const root = maya();
  const b = body(root, "people/maya-chen");
  const [lead, made] = b.split("\n\n");
  expect(lead).not.toContain(MADE);
  expect(made).toBe(MADE);
  // Still the writer's own text: not counted as prose someone else wrote, and rewritten in place.
  expect(proseBeyondHub(loadBrain(root).find((n) => n.fm.id === "people/maya-chen")!)).toBe(false);
  const head = sh(root, "hub", "rev-parse", "HEAD");
  expect(renderTouchedPages(root, "2000-01-01T00:00:00Z").written).toEqual([]);
  expect(sh(root, "hub", "rev-parse", "HEAD")).toBe(head);
});

test("a role that doesn't read as a title is said as work, never 'the' in front", () => {
  const root = makeBrain();
  page(root, "orgs/harbourline", "org", "Harbourline Software");
  page(root, "people/sam-roy", "person", "Sam Roy", fact("role", "coach tennis", "gmail:f0000000000000b1") + fact("org", "\"[[orgs/harbourline]]\"", "gmail:f0000000000000b2"));
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body(root, "people/sam-roy")).toContain("Sam Roy works as coach tennis at [[orgs/harbourline|Harbourline Software]].[^p-role][^p-org]");
});

test("a title with 'of' reads as a title: 'the VP of Product at'", () => {
  const root = makeBrain();
  page(root, "orgs/harbourline", "org", "Harbourline Software");
  page(root, "people/priya-shah", "person", "Priya Shah", fact("role", "VP of Product", "gmail:f0000000000000c1") + fact("org", "\"[[orgs/harbourline]]\"", "gmail:f0000000000000c1"));
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body(root, "people/priya-shah")).toStartWith("Priya Shah is the VP of Product at [[orgs/harbourline|Harbourline Software]].[^p-role]\n\n");
});

test("a name that starts with a title or an initial is said in full every time", () => {
  const root = makeBrain();
  page(root, "people/dr-lee", "person", "Dr Lee", fact("role", "advisor", "gmail:f0000000000000d1") + fact("city", "Laval", "gmail:f0000000000000d2"));
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(body(root, "people/dr-lee")).toContain("Dr Lee's city is Laval.");
});
