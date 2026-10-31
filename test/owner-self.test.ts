// SPDX-License-Identifier: AGPL-3.0-only
// The owner is never a new note (owner's phone, 2026-10-25: a social-network mail asked him to
// "Remember this as a new note, '<his name>, M.Sc.'"). A name with credentials is the same person
// as the name without them, and the owner's own name resolves to the owner's page, or starts that
// one page when there is none yet. Temp brains removed after.
import { test, expect, afterAll } from "bun:test";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { checkCandidate } from "../src/capture";
import { resolveEntity, personKey } from "../src/write";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const brain = (owner: string, page?: string) => {
  const root = makeBrain(); roots.push(root);
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("owner: { name: Robin }", `owner: ${owner}`));
  if (page) writeFileSync(join(root, "people", "robin-lake.md"), `---\nid: people/robin-lake\ntype: person\ntitle: ${page}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\nfacts: {}\n---\n`);
  return { notes: loadBrain(root), rules: loadRules(root) };
};
const text = "Congratulate Robin Lake, M.Sc. for 6 years at Northwind";
const fact = (entity: string) => ({ entity, type: "person", attribute: "org", value: "Northwind", quote: "Congratulate Robin Lake, M.Sc. for 6 years at Northwind" });

test("credentials and honorifics don't make a new person", () => {
  expect(personKey("Robin Lake, M.Sc.")).toBe(personKey("Robin Lake"));
  expect(personKey("Dr. Jane Roy, PhD, CISSP")).toBe(personKey("Jane Roy"));
  // "Last, First" stays a name: only credential-shaped pieces after a comma go.
  expect(personKey("Roy, Jane")).not.toBe(personKey("Roy"));
  const { notes } = brain("{ name: Robin }");
  expect(resolveEntity(notes, "person", "Jane Roy, M.Sc.").id).toBe("people/jane-roy");
});

test("the owner's own name lands on the owner's page, never a new note", () => {
  const { notes, rules } = brain("{ name: Robin Lake }", "Robin Lake");
  const r = checkCandidate(fact("Robin Lake, M.Sc.") as never, text, notes, rules);
  expect(r.status).not.toBe("new-note");
  expect(r.target).toBe("people/robin-lake");
});

// G401: with no page of their own, the fact starts the owner's page under the owner's full name.
test("with no page of their own, a fact about the owner starts the owner's own page", () => {
  const { notes, rules } = brain("{ name: Robin Lake }");
  const r = checkCandidate(fact("Robin Lake, M.Sc.") as never, text, notes, rules);
  expect(r.status).toBe("new-note");
  expect(r.candidate.entity).toBe("Robin Lake");
  expect(r.why).toMatch(/your own page/);
});

test("owner.aliases name the owner too; a one-word owner name alone doesn't claim every namesake", () => {
  const { notes, rules } = brain("{ name: Robin, aliases: [Robin Lake] }");
  expect(checkCandidate(fact("Robin Lake, M.Sc.") as never, text, notes, rules).candidate.entity).toBe("Robin Lake");
  const other = checkCandidate({ entity: "Robin Fox", type: "person", attribute: "org", value: "Northwind", quote: "Robin Fox joins Northwind" } as never, "Robin Fox joins Northwind", notes, rules);
  expect(other.status).toBe("new-note");
});

// Slice audit 2026-10-25 (4597a941): stripping too much merged different people.
test("generational suffixes, initials and all-caps names stay distinct people", () => {
  for (const [a, b] of [["John Smith, Jr.", "John Smith, Sr."], ["John Smith, Jr.", "John Smith"], ["Roy, J.", "Roy, K."], ["LEE, KIM", "LEE, ANN"], ["Tran, MAI", "Tran, LAN"], ["M. Dupont", "Dupont"]])
    expect(personKey(a)).not.toBe(personKey(b));
  expect(personKey("Jane Roy, MBA, CISSP")).toBe(personKey("Jane Roy"));
});

test("the owner's son is not the owner; 'Last, First' is the owner; a namesake page makes it ambiguous", () => {
  const { notes, rules } = brain("{ name: Robin Lake }", "Robin Lake");
  const jr = checkCandidate({ ...fact("Robin Lake, Jr."), quote: "Robin Lake, Jr. joins Northwind" } as never, "Robin Lake, Jr. joins Northwind", notes, rules);
  expect(jr.target).not.toBe("people/robin-lake");
  const lf = checkCandidate({ ...fact("Lake, Robin"), quote: "Lake, Robin joins Northwind" } as never, "Lake, Robin joins Northwind", notes, rules);
  expect(lf.target).toBe("people/robin-lake");
  const two = brain("{ name: Robin Lake }", "Robin Lake");
  writeFileSync(join(roots.at(-1)!, "people", "robin-lake-2.md"), `---\nid: people/robin-lake-2\ntype: person\ntitle: Robin Lake\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts: {}\n---\n`);
  const r = checkCandidate(fact("Robin Lake, M.Sc.") as never, text, loadBrain(roots.at(-1)!), two.rules);
  expect(r.status).toBe("ambiguous");
});

// Re-audit 2026-10-25 (45d24834): degree words that are also given names.
test("a given name that spells a degree stays a name; the owner's 'Last, First, M.Sc.' is the owner", () => {
  for (const [a, b] of [["Li, Ma", "Li, Ba"], ["CHEN, MA", "CHEN, MED"], ["Tran, Ba", "Tran"], ["Lee, Ing", "Lee"], ["Jane Roy, Ma", "Jane Roy"]])
    expect(personKey(a)).not.toBe(personKey(b));
  expect(personKey("Jane Roy, MA")).toBe(personKey("Jane Roy"));
  expect(personKey("Jane Roy, M.A.")).toBe(personKey("Jane Roy"));
  const { notes, rules } = brain("{ name: Robin Lake }", "Robin Lake");
  const r = checkCandidate({ ...fact("Lake, Robin, M.Sc."), quote: "Lake, Robin, M.Sc. joins Northwind" } as never, "Lake, Robin, M.Sc. joins Northwind", notes, rules);
  expect(r.target).toBe("people/robin-lake");
});
