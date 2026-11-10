// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13 (2026-11-09), item 10: sentence() spliced any value after "is" or "works as" as if it
// were a short noun phrase, so a whole clause, a list with a semicolon, a question or a value
// starting with a name became a broken sentence, and an attribute's code name ("what it is",
// "kind", "chose") was read as English. A value now says what shape it is: a short noun phrase
// goes in a sentence, anything else is quoted under a plain label; a role is glued to an org only
// when one source says both (G773). Made-up names; none of the audit's real-brain lines.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { readPage } from "../src/proofread";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env("steward") }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: ${JSON.stringify(value)}, as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }\n`;
function page(root: string, id: string, type: string, title: string, facts: string) {
  mkdirSync(join(root, id.split("/")[0]!), { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n${facts}---\n`);
}
// The hub's own block, as words: links as their names, no references.
const prose = (root: string, id: string) => body(root, id).split(/\n\[\^/)[0]!.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\[\^[^\]]+\]/g, "");

function brain() {
  const root = makeBrain();
  page(root, "orgs/north-hall", "org", "North Hall", fact("what_it_is", "A French-language university", "gmail:f0000000000000b1"));
  page(root, "orgs/sparkly", "org", "Sparkly", fact("kind", "dating app", "gmail:f0000000000000b2"));
  page(root, "orgs/fieldnote", "org", "Fieldnote", fact("city", "Halifax", "gmail:f0000000000000b3"));
  page(root, "projects/beta-scope", "project", "Beta scope", fact("status", "Robin is done with the iOS builds for now", "gmail:f0000000000000b4"));
  page(root, "projects/billing-move", "project", "Billing move", fact("status", "completed", "gmail:f0000000000000b5") + fact("next_step", "None: migration completed", "gmail:f0000000000000b5"));
  page(root, "projects/review-day", "project", "Review day", fact("next_step", "can we move the review?", "gmail:f0000000000000b6"));
  page(root, "decisions/2026-10-02-pick-builder", "decision", "Pick a builder", fact("chose", "Lee Builders", "gmail:f0000000000000b7") + fact("why", "they can start in November", "gmail:f0000000000000b7"));
  // A role and an org from two different sources: never glued into one claim no source made.
  page(root, "people/zoe-harper", "person", "Zoe Harper", fact("role", "guest lecturer", "gmail:f0000000000000c1") + fact("org", "[[orgs/fieldnote]]", "gmail:f0000000000000c2"));
  // The same source says both: one sentence, as before.
  page(root, "people/maya-chen", "person", "Maya Chen", fact("role", "design lead", "gmail:f0000000000000c3") + fact("org", "[[orgs/fieldnote]]", "gmail:f0000000000000c3"));
  // A role that is a list: quoted under its label, the org said on its own.
  page(root, "people/mei-lin", "person", "Mei Lin", fact("role", "student, team lead for group A", "gmail:f0000000000000c4") + fact("org", "[[orgs/north-hall]]", "gmail:f0000000000000c4"));
  page(root, "people/sam-ortiz", "person", "Sam Ortiz", fact("role", "Former colleague; collaborator on Atlas", "gmail:f0000000000000c5") + fact("org", "[[orgs/fieldnote]]", "gmail:f0000000000000c5"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "steward: setup");
  return root;
}

test("G773 a short noun phrase is said in a sentence, an attribute's code name never is", () => {
  const root = brain();
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(prose(root, "orgs/north-hall")).toContain("North Hall is a French-language university.");
  expect(prose(root, "orgs/sparkly")).toContain("Sparkly is a dating app.");
  expect(prose(root, "orgs/fieldnote")).toContain("Fieldnote's city is Halifax.");
  expect(prose(root, "decisions/2026-10-02-pick-builder")).toContain("Chose: Lee Builders.");
  for (const id of ["orgs/north-hall", "orgs/sparkly", "decisions/2026-10-02-pick-builder"]) {
    expect(prose(root, id)).not.toMatch(/what it is is|'s kind is|The chose of|, the why:/);
  }
});

test("G773 a clause, a question, a list or a value starting with a name is quoted under a plain label", () => {
  const root = brain();
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(prose(root, "projects/beta-scope")).toContain("Status: “Robin is done with the iOS builds for now.”");
  expect(prose(root, "projects/beta-scope")).not.toContain("Beta scope is Robin is");
  expect(prose(root, "projects/review-day")).toContain("Next step: “can we move the review?”");
  expect(prose(root, "decisions/2026-10-02-pick-builder")).toContain("Why: “they can start in November.”");
  expect(prose(root, "people/sam-ortiz")).toContain("Role: “Former colleague; collaborator on Atlas.”");
  expect(prose(root, "people/sam-ortiz")).not.toContain("works as Former");
  expect(prose(root, "people/mei-lin")).not.toContain("is the student, team lead");
  expect(prose(root, "people/mei-lin")).toContain("Mei works at North Hall.");
  // "None" is no next step at all.
  expect(prose(root, "projects/billing-move")).toContain("Billing move is completed.");
  expect(prose(root, "projects/billing-move")).not.toMatch(/None/);
});

test("G773 a role is glued to an org only when one source says both", () => {
  const root = brain();
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  expect(prose(root, "people/maya-chen")).toContain("Maya Chen is the design lead at Fieldnote.");
  expect(prose(root, "people/zoe-harper")).not.toContain("is the guest lecturer at Fieldnote");
  expect(prose(root, "people/zoe-harper")).toContain("Zoe Harper's role is guest lecturer.");
  expect(prose(root, "people/zoe-harper")).toContain("Zoe works at Fieldnote.");
});

test("G773 the nightly read finds nothing odd in what the writer now says", () => {
  const root = brain();
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  for (const id of ["orgs/north-hall", "orgs/sparkly", "projects/beta-scope", "projects/billing-move", "projects/review-day", "decisions/2026-10-02-pick-builder", "people/zoe-harper", "people/mei-lin", "people/sam-ortiz"]) {
    const html = `<main><h1>${id}</h1><div class="prose">${prose(root, id).split(/\n\n+/).map((p) => `<p>${p}</p>`).join("")}<h2>References</h2><ol class="b-refs"></ol></div></main>`.replace(`<h1>${id}</h1>`, `<h1>${readFileSync(join(root, `${id}.md`), "utf8").match(/^title: (.+)$/m)![1]}</h1>`);
    expect({ id, odd: readPage(html) }).toEqual({ id, odd: [] });
  }
});
