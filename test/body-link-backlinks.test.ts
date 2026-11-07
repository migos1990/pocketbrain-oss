// SPDX-License-Identifier: AGPL-3.0-only
// Pages-ok, part 3 (real-brain north star, 2026-11-01: 11 of 13 project pages had no link in).
// A [[link]] someone wrote into a page's own text links back from the page it names ("See also"),
// cited by that text's references, as a fact's link already does (G670). It never says more than
// the page's readers can read: a page whose text a reader of the named page can't read, or one more
// private than it, gives no back-link, and neither does the hub's own lead or the owner's own page.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";

const env = { ...process.env, GIT_AUTHOR_NAME: "planner", GIT_AUTHOR_EMAIL: "planner@pocketbrain.local", GIT_COMMITTER_NAME: "planner", GIT_COMMITTER_EMAIL: "planner@pocketbrain.local" };
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root, env }); Bun.spawnSync(["git", "commit", "-qm", "planner: setup"], { cwd: root, env }); };
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const SINCE = "2000-01-01T00:00:00Z";
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: ${value}, as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n`;
function page(root: string, dir: string, slug: string, type: string, title: string, o: { area?: string; sensitivity?: string; facts?: string; text?: string } = {}) {
  writeFileSync(join(root, dir, `${slug}.md`), `---\nid: ${dir}/${slug}\ntype: ${type}\ntitle: ${title}\narea: ${o.area ?? "work"}\nsensitivity: ${o.sensitivity ?? "personal"}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n${o.facts ? `facts:\n${o.facts}` : ""}---\n${o.text ?? ""}`);
}
const cited = (line: string, ref: string) => `## Earlier notes\n${line}[^e1]\n\n[^e1]: Gmail, 2026-10-05 (${ref})\n`;

test("G670 a [[link]] in a page's own text links back from the page it names, cited by that text", () => {
  const root = makeBrain();
  page(root, "people", "kim-roux", "person", "Kim Roux", { facts: fact("role", "facilities lead", "gmail:f00000000000000c") });
  page(root, "projects", "office-move", "project", "Office move", { facts: fact("status", "planning", "gmail:f00000000000000d"), text: cited("[[Kim Roux]] books the movers for the office.", "gmail:f00000000000000e") });
  commit(root);
  renderTouchedPages(root, SINCE);
  const kim = body(root, "people/kim-roux");
  expect(kim).toMatch(/See also \[\[projects\/office-move\|Office move\]\]\.\[\^p-see-office-move\]/);
  expect(kim).toMatch(/\[\^p-see-office-move\]: Email, 2026-10-05 \(gmail:f00000000000000e\)/);
});

test("G670 no back-link from text with no reference, from the hub's own lead, or onto the owner's page", () => {
  const root = makeBrain();
  page(root, "people", "kim-roux", "person", "Kim Roux", { facts: fact("role", "facilities lead", "gmail:f00000000000000c") });
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  page(root, "people", "robin-vale", "person", "Robin Vale", { area: "personal", facts: fact("city", "Halifax", "gmail:f000000000000009") });
  // Uncited text: nothing to cite the back-link by.
  page(root, "projects", "office-move", "project", "Office move", { facts: fact("status", "planning", "gmail:f00000000000000d"), text: "## Earlier notes\n[[Kim Roux]] books the movers for the office.\n" });
  // A page whose text names the owner gives the owner's page no See also (G624: it says its own facts).
  page(root, "projects", "garden", "project", "Garden plan", { area: "personal", facts: fact("status", "planning", "gmail:f00000000000000f"), text: cited("[[Robin Vale]] wants raised beds this spring.", "gmail:f000000000000010") });
  commit(root);
  renderTouchedPages(root, SINCE);
  expect(body(root, "people/kim-roux")).not.toContain("Office move");
  // His page lists the project among his own (G725), cited by its status fact, never a See also
  // cited by the text that names him.
  expect(body(root, "people/robin-vale")).not.toContain("See also");
  expect(body(root, "people/robin-vale")).not.toContain("gmail:f000000000000010");
  // The hub's own lead links pages from facts; those already link back as facts do, never twice.
  const twice = renderTouchedPages(root, SINCE);
  expect(twice.written).toEqual([]);
});

test("G670 a back-link never names a page the named page's readers can't read, or one more private", () => {
  const root = makeBrain();
  page(root, "projects", "office-move", "project", "Office move", { facts: fact("status", "planning", "gmail:f00000000000000d") });
  // A personal-area person page: the work-only helper and planner don't read its text.
  page(root, "people", "dana-moss", "person", "Dana Moss", { area: "personal", facts: fact("city", "Truro", "gmail:f000000000000011"), text: cited("Dana is helping with the [[Office move]] boxes.", "gmail:f000000000000012") });
  // A private page's text names the project.
  page(root, "decisions", "2026-10-05-lease", "decision", "Lease call", { sensitivity: "private", facts: fact("chosen", "stay", "gmail:f000000000000013"), text: cited("Decided before the [[Office move]] budget.", "gmail:f000000000000014") });
  commit(root);
  const notes = loadBrain(root), rules = loadRules(root);
  const helper = carve(notes, rules, grantFor(rules, "helper"), { flags: false });
  expect(helper.visible.has("projects/office-move")).toBe(true);
  expect(helper.visible.get("people/dana-moss")?.body).toBeFalsy();
  renderTouchedPages(root, SINCE);
  const office = body(root, "projects/office-move");
  expect(office).not.toContain("Dana");
  expect(office).not.toContain("Lease");
});
