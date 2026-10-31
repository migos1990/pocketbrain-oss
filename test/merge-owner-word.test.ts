// SPDX-License-Identifier: AGPL-3.0-only
// Builder's audit, 2026-10-31 (G572): a merge folded the owner's confirmation of a value into a
// record that only a source vouched for, and kept the weaker verification. The owner's word was
// lost: an assistant's contradicting write that was a conflict before the merge ("contradicts a fact
// the owner confirmed", invariant 6) replaced the value after it. The merged record keeps the
// strongest word that joined it: the owner's, else a co-owner's (with whose).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { samePersonProposals, mergeSamePerson } from "../src/sameperson";
import { loadBrain, type FactRecord } from "../src/brain";
import { remember } from "../src/core";

const OPEN = `{ value: "(514) 555-0100", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }`;
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: root }); };
const setup = (dropVerification = "confirmed-by-owner, by: steward", keepVerification = "verified-by-source, by: steward") => {
  const root = makeBrain();
  const p = join(root, "people/jane-roy.md");
  writeFileSync(p, readFileSync(p, "utf8").replace(/\nfacts:\n/, `\nfacts:\n  home: { value: "12 Elm St", as_of: 2026-09-01, sources: ["gmail:f000000000000044"], verification: ${keepVerification}, recorded: 2026-10-01 }\n`));
  writeFileSync(join(root, "people/j-roy.md"), `---\nid: people/j-roy\ntype: person\ntitle: Jay Roy\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-03\nupdated: 2026-10-03\nby: steward\nfacts:\n  phones: { items: [${OPEN}] }\n  home: { value: "12 Elm St", as_of: 2026-09-02, sources: ["imsg:12345"], verification: ${dropVerification}, recorded: 2026-10-02 }\n---\nA person.\n`);
  commit(root);
  return root;
};
const contradict = (root: string, id: string) => remember(root, "planner", { id, attribute: "home", value: "1 Other Rd", as_of: "2026-10-05", sources: ["gmail:f000000000000043"], verification: "verified-by-source" } as never).outcome;
const merged = (root: string) => {
  const pr = samePersonProposals(root).find((x) => [x.keep, x.drop].includes("people/j-roy"))!;
  expect(pr.blocked).toBeUndefined();
  mergeSamePerson(root, pr.id);
  return { id: pr.keep, rec: loadBrain(root).find((n) => n.fm.id === pr.keep)!.fm.facts!.home as FactRecord };
};

test("G572 the owner's confirmation survives a merge, so a contradicting write is still a conflict", () => {
  const before = contradict(setup(), "people/j-roy");
  const root = setup();
  const m = merged(root);
  expect(m.rec.verification).toBe("confirmed-by-owner");
  expect(m.rec.sources).toContain("imsg:12345");
  expect(contradict(root, m.id)).toBe(before);
  expect(before).not.toBe("committed");
});

test("G572 a co-owner's confirmation survives a merge with whose it is", () => {
  const root = setup("confirmed-by-co-owner, co_owner: sam, by: steward");
  const m = merged(root);
  expect(m.rec.verification).toBe("confirmed-by-co-owner");
  expect(m.rec.co_owner).toBe("sam");
});
