// SPDX-License-Identifier: AGPL-3.0-only
// Live, 2026-10-31 (G576): after G569 the owner's merge of his two pages was still refused, because
// the resolver couldn't see a held fact (and, as a reader token, two private ones) on one page and
// the merge would open a dispute. The resolver needs to see what the dispute shows it: the facts in
// dispute. A fact hidden from it on another attribute never reaches the packet, and stays hidden on
// the merged page by its own flags (G569). A disputed fact the resolver can't see still refuses.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { samePersonProposals, mergeSamePerson } from "../src/sameperson";
import { loadBrain, isDisputed } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { withTokenRole } from "../src/tokenrole";

const OPEN = `{ value: "(514) 555-0100", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }`;
const rec = (v: string, extra = "") => `{ value: "${v}", as_of: 2026-09-02, sources: ["gmail:f0000000000000b1"], verification: verified-by-source, by: steward, recorded: 2026-10-02${extra} }`;
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: root }); };
function brain(disputeHeld: boolean, keepRolePrivate = false) {
  const root = makeBrain();
  const p = join(root, "people/jane-roy.md");
  // Jane Roy's held fact (waiting for the owner to see it): hidden from every assistant, the resolver too.
  let jane = readFileSync(p, "utf8").replace(/\nfacts:\n/, `\nfacts:\n  home: ${rec("12 Elm St", ", unseen: true")}\n`);
  // As on the owner's page: the disputed fact on the kept page is private, so the resolver's reader token can't see it.
  if (keepRolePrivate) jane = jane.replace("recorded: 2026-10-01 }\n  phones", "recorded: 2026-10-01, sensitivity: private }\n  phones");
  writeFileSync(p, jane);
  // Jay Roy: the same person, with a different role (the merge disputes it) and the same phone.
  writeFileSync(join(root, "people/j-roy.md"), `---\nid: people/j-roy\ntype: person\ntitle: Jay Roy\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-03\nupdated: 2026-10-03\nby: steward\nfacts:\n  phones: { items: [${OPEN}] }\n  role: ${rec("Head of studies")}\n${disputeHeld ? `  home: ${rec("9 Oak Ave")}\n` : ""}---\nA person.\n`);
  commit(root);
  return root;
}
const pair = (root: string) => samePersonProposals(root).find((x) => [x.keep, x.drop].includes("people/j-roy"))!;

test("G576 a held fact the merge doesn't dispute no longer stops the resolver check; the dispute opens", () => {
  const root = brain(false);
  const p = pair(root);
  expect(p.blocked).toBeUndefined();
  mergeSamePerson(root, p.id);
  const kept = loadBrain(root).find((n) => n.fm.id === p.keep)!;
  expect(isDisputed(kept.fm.facts!.role!)).toBe(true);
  expect((kept.fm.facts!.home as { unseen?: boolean }).unseen).toBe(true);
});

test("G576 a disputed fact the resolver can't see still refuses", () => {
  const root = brain(true);
  expect(pair(root).blocked).toMatch(/one of these notes but not the other/);
});

test("G576 a disputed private fact the resolver's reader token can't see doesn't refuse: a reader never reads the packet", () => {
  const root = brain(false, true);
  const p = pair(root);
  expect(p.blocked).toBeUndefined();
  mergeSamePerson(root, p.id);
  const kept = loadBrain(root).find((n) => n.fm.id === p.keep)!;
  expect(isDisputed(kept.fm.facts!.role!)).toBe(true);
  // The stricter view: the resolver's reader token reads neither side of the dispute, nor the value
  // it read on the dropped page today.
  const rules = loadRules(root);
  const res = withTokenRole("steward", "reader", () => carve(loadBrain(root), rules, grantFor(rules, "steward"), { flags: false }));
  expect(res.hiddenFacts.some((h) => h.key === `${p.keep}#role`)).toBe(true);
  expect(res.carvedValues.map((x) => x.toLowerCase())).toContain("head of studies");
});

// Builder's slice audit of G576: a word leaving the shown set was let through whenever any held value
// on the merged note held it, though that value was hidden already and never withholds the line. The
// card offered a merge the backstop then refused. Only a value the merge newly hides explains a word.
test("G576 audit: a word a value hidden before the merge holds still refuses at the card, as the backstop does", () => {
  const root = makeBrain();
  const ph = `{ value: "+15145550100", as_of: 2026-09-01, sources: ["gmail:f000000000000001"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }`;
  const sw = (v: string, src: string) => `{ value: "${v}", as_of: 2026-09-01, sources: ["${src}"], verification: verified-by-source, by: planner, recorded: 2026-10-01, share_with: [steward] }`;
  writeFileSync(join(root, "people/jaylen-fournier.md"), `---\nid: people/jaylen-fournier\ntype: person\ntitle: Jaylen Fournier\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-05\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${ph}] }\n  nickname: ${sw("Jaylen T", "gmail:f000000000000002")}\n  employer: ${sw("Fournier Inc", "gmail:f000000000000003")}\n---\nA person.\n`);
  writeFileSync(join(root, "projects/holdco.md"), `---\nid: projects/holdco\ntype: project\ntitle: The holdco\naliases: [Jaylen Fournier Holdings]\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nPrivate.\n`);
  writeFileSync(join(root, "projects/lunch.md"), `---\nid: projects/lunch\ntype: project\ntitle: Lunch\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nLunch with Jaylen Fournier on Friday.\n`);
  commit(root);
  const p = samePersonProposals(root).find((x) => [x.keep, x.drop].includes("people/jaylen-fournier"))!;
  let merged = true;
  if (!p.blocked) { try { mergeSamePerson(root, p.id); } catch { merged = false; } }
  // The card and the merge agree: refused at the card, not offered and then refused.
  expect(p.blocked).toBeDefined();
  expect(merged).toBe(true);
});
