// SPDX-License-Identifier: AGPL-3.0-only
// The owner's Mentioned on list is a list of connections the brain holds, not of guesses (G828,
// after G844): a link that comes only from a line nothing firm stands behind (an assistant's
// memory, an inferred or unverified record) is said on its own page as "Not confirmed" and must
// not list that page under the linked one. A sourced or owner's line still does, and so does a
// link written in a page's own text.
import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadState } from "../src/dashboard/data";
import { connections } from "../src/dashboard/browse";
import { peoplePage } from "../src/dashboard/people";

const head = (id: string, type: string, title: string) => `---\nid: ${id}\ntype: ${type}\ntitle: "${title}"\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;
const rec = (value: string, rest: string) => `{ value: "${value}", as_of: 2026-10-05, ${rest}, by: planner, recorded: 2026-10-05 }`;

test("G828 a link only a guess stands behind is not a connection; a sourced line, the owner's word and the page's own text are", () => {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `${head("orgs/north-college", "org", "North College")}---\n`);
  const person = (slug: string, title: string, org: string, body = "") => writeFileSync(join(root, "people", `${slug}.md`), `${head(`people/${slug}`, "person", title)}facts:\n  org: ${org}\n---\n${body}\n`);
  person("guess-only", "Gus Guess", rec("[[orgs/north-college]]", `sources: ["agent:planner/2026-10-05"], verification: self-reported`));
  person("inferred", "Ina Inferred", rec("[[orgs/north-college]]", `sources: ["gmail:f0000000000000a1"], verification: verified-by-source, confidence: inferred`));
  person("sourced", "Sol Sourced", rec("[[orgs/north-college]]", `sources: ["gmail:f0000000000000a2"], verification: verified-by-source`));
  person("owned", "Oda Owned", rec("[[orgs/north-college]]", `sources: ["owner:2026-10-05/dashboard"], verification: confirmed-by-owner`));
  person("written", "Wes Written", rec("somewhere", `sources: ["agent:planner/2026-10-05"], verification: self-reported`), "Works with [[orgs/north-college]].");
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=planner", "-c", "user.email=p@x", "commit", "-qm", "people"], { cwd: root });
  const s = loadState(root);
  const org = s.notes.find((n) => n.fm.id === "orgs/north-college")!;
  expect(connections(s, org).mentionedIn.map((n) => n.fm.id).sort()).toEqual(["people/owned", "people/sourced", "people/written"]);
  // And the page that only guesses does not list the org as a link of its own.
  expect(connections(s, s.notes.find((n) => n.fm.id === "people/guess-only")!).linksTo.map((n) => n.fm.id)).toEqual([]);
});

test("Who matters never says 'no authority either way' for someone whose authority nobody set (G865, seen on the owner's phone)", () => {
  const root = makeBrain();
  const s = loadState(root);
  const html = peoplePage(s, "c").body;
  expect(html).toContain("authority not set");
  expect(html).not.toContain("no authority either way");
});

test("G828 only the hub's own family guess keeps its link, and an ended line links nothing, single or listed", () => {
  const root = makeBrain();
  const hub = `{ value: "[[people/kin]]", as_of: 2026-10-05, sources: ["agent:hub/2026-10-05"], verification: unverified, confidence: inferred, by: hub, recorded: 2026-10-05 }`;
  const page = (slug: string, title: string, facts: string) => writeFileSync(join(root, "people", `${slug}.md`), `${head(`people/${slug}`, "person", title)}facts:\n${facts}---\n`);
  page("kin", "Kim Kin", "");
  page("hub-family", "Hal Hub", `  family: ${hub}\n`);
  page("told-family", "Tia Told", `  family: ${rec("[[people/kin]]", `sources: ["agent:planner/2026-10-05"], verification: self-reported`)}\n`);
  page("ended-one", "Edo Ended", `  friend: { value: "[[people/kin]]", as_of: 2026-10-05, sources: ["owner:2026-10-05/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-05, valid_to: 2026-10-06 }\n`);
  page("ended-list", "Eli Ended", `  friends:\n    items:\n      - { value: "[[people/kin]]", as_of: 2026-10-05, sources: ["owner:2026-10-05/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-05, valid_to: 2026-10-06 }\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=planner", "-c", "user.email=p@x", "commit", "-qm", "people"], { cwd: root });
  const s = loadState(root);
  expect(connections(s, s.notes.find((n) => n.fm.id === "people/kin")!).mentionedIn.map((n) => n.fm.id).sort()).toEqual(["people/hub-family"]);
});
