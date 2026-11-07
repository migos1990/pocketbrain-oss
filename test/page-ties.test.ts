// SPDX-License-Identifier: AGPL-3.0-only
// Owner, 2026-11-01 (his own page on the phone): "How you know Louis Migault: customer of Best Buy
// Canada. Louis also comes up in the sources of <a physio appointment>, Bell, … See also <a flight>,
// <a developer agreement>, …": unrelated mail glued into a page about a person. The owner's own page
// says only its facts, one sentence each; any other page names a page its sources tie it to only when
// that source names the page, at most three, each its own sentence (G624).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { nameKey } from "../src/mentions";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const SINCE = "2000-01-01T00:00:00Z";
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: ${value}, as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n`;
function person(root: string, slug: string, title: string, facts: string, area = "work") {
  writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n${facts}---\n`);
}
function capture(root: string, ref: string, names: string[]) {
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", `2026-10-05-${ref.slice(-8)}.md`), `---\n${YAML.stringify({ id: `2026-10-05-${ref.slice(-8)}`, kind: "text", via: "source", source_ref: ref, name_keys: names.map(nameKey), status: "extracted" })}---\nNot kept here.\n`);
}
const commit = (root: string) => { sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: setup"); };

test("G624 the owner's own page says its facts, one sentence each: no how-you-know, no sources line, no See also; no page's sources name him", () => {
  const root = makeBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  person(root, "robin-vale", "Robin Vale", fact("city", "Halifax", "gmail:f000000000000009") + fact("relationship", "customer of Best Buy Canada", "gmail:f00000000000000b"), "personal");
  person(root, "kim-roux", "Kim Roux", fact("role", "physiotherapist", "gmail:f00000000000000c"));
  capture(root, "gmail:f00000000000000c", ["Robin Vale"]); // the physio's mail names the owner
  const dec = join(root, "decisions", "2026-09-01-pick-bank.md");
  writeFileSync(dec, readFileSync(dec, "utf8").replace("by: steward\n---", "by: steward\nfacts:\n  chosen: { value: Maple Trust Bank, as_of: 2026-09-01, sources: [\"gmail:f000000000000007\"], verification: verified-by-source, by: steward, recorded: 2026-09-01 }\n---"));
  commit(root);
  renderTouchedPages(root, SINCE);
  const robin = body(root, "people/robin-vale");
  expect(robin).toContain("Halifax");
  expect(robin).not.toContain("How you know");
  expect(robin).not.toContain("Best Buy");
  expect(robin).not.toContain("comes up in");
  expect(robin).not.toContain("See also");
  expect(robin).not.toContain("Kim Roux");
  expect(robin).not.toContain("Pick a bank");
  // Nor does another page name the owner just because its mail does: every mail does.
  expect(body(root, "people/kim-roux")).not.toContain("Robin Vale");
});

test("G624 two pages citing one mail tie only when that mail names the page", () => {
  const root = makeBrain();
  person(root, "ana-diaz", "Ana Diaz", fact("role", "program director", "gmail:f0000000000000c1"));
  person(root, "cy-moss", "Cy Moss", fact("role", "registrar", "gmail:f0000000000000c1"));
  commit(root);
  renderTouchedPages(root, SINCE);
  expect(body(root, "people/cy-moss")).not.toContain("Ana Diaz");
  expect(body(root, "people/ana-diaz")).not.toContain("Cy Moss");
  capture(root, "gmail:f0000000000000c1", ["Cy Moss"]); // the mail is about Cy
  writeFileSync(join(root, "people", "cy-moss.md"), readFileSync(join(root, "people", "cy-moss.md"), "utf8").replace("updated: 2026-10-01", "updated: 2026-10-02"));
  commit(root);
  renderTouchedPages(root, SINCE);
  expect(body(root, "people/cy-moss")).toContain("[[people/ana-diaz|Ana Diaz]]");
});

test("G624 a page names at most three pages its sources tie it to, in one sentence (G704)", () => {
  const root = makeBrain();
  person(root, "ben-okafor", "Ben Okafor", fact("role", "analyst", "gmail:f0000000000000b0"));
  for (const [i, who] of ["Ann Lake", "Cal Dunn", "Dee Ray", "Eli Novak", "Fay Wong"].entries()) {
    const ref = `gmail:f0000000000000d${i}`;
    person(root, who.toLowerCase().replace(" ", "-"), who, fact("role", "colleague", ref));
    capture(root, ref, ["Ben Okafor"]);
  }
  commit(root);
  renderTouchedPages(root, SINCE);
  const ben = body(root, "people/ben-okafor");
  const tied = ["Ann Lake", "Cal Dunn", "Dee Ray", "Eli Novak", "Fay Wong"].filter((w) => ben.includes(`|${w}]]`));
  expect(tied.length).toBe(3);
  // One sentence for them all, not one each (owner, 2026-11-07, on his school's page: the same
  // sentence said twice read as a bug; G704).
  expect(ben.match(/also comes up in the sources of/g)?.length).toBe(1);
});
