// SPDX-License-Identifier: AGPL-3.0-only
// Re-audit 2026-10-30 (first audit's high finding, still reproduced on 6e15f79): the box read "Paul
// told me Jane is the dean" as a fact and wrote it at the top rank, as the owner's own word (with a
// model, Jane's role; with the patterns, a role on the name "Paul told me Jane", which can land on
// Paul). What someone else said is theirs: the box files nothing from it and says so, with one chip
// to say the fact as the owner's own (G528).
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay, ownerSayModel, hearsay } from "../src/owner-say";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel } from "../src/model";

const roles = (root: string) => Object.fromEntries(loadBrain(root).filter((n) => /jane|paul/.test(n.fm.id)).map((n) => [n.fm.id, (n.fm.facts?.role as FactRecord | undefined)?.value]));
const SAID = "Paul told me Jane is the dean";

test("with a model: nothing is written, the reply names whose word it is, one chip says it as the owner's", async () => {
  const root = makeBrain();
  const before = roles(root);
  const m = makeModel({ provider: "fake", model: "f" }, { fake: () => JSON.stringify({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "the dean", when: "" }] }) });
  const r = await ownerSayModel(root, SAID, {}, m);
  expect(r.kind).toBe("say.hearsay");
  expect(r.text).toContain("Paul's word");
  expect(r.chips).toEqual([{ label: "I know it's so", say: "Jane is the dean" }]);
  expect(roles(root)).toEqual(before);
});

test("with the patterns alone: no role for Paul or Jane", () => {
  const root = makeBrain();
  const before = roles(root);
  for (const s of [SAID, "Paul said that Jane is the dean.", "According to Paul, Jane is the dean", "I heard Jane is the dean", "Apparently Jane is the dean"]) {
    expect(ownerSay(root, s).kind, s).toBe("say.hearsay");
  }
  expect(roles(root)).toEqual(before);
});

test("the owner's own sentences are not hearsay", () => {
  for (const s of ["Jane is the dean", "Met Paul today", "Remind me to call Jane tomorrow", "Jane runs the new lab", "I met Jane", "Ana isn't at North College anymore, she moved to Bay Institute"]) expect(hearsay(s), s).toBeUndefined();
  expect(hearsay("I heard Jane moved to Bay Institute")).toEqual({ who: "someone else", rest: "Jane moved to Bay Institute" });
});
