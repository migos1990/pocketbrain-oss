// SPDX-License-Identifier: AGPL-3.0-only
// The box never guesses the owner's word (audit v4, 2026-10-26): "X is <anything>" asks "Did you
// mean to note a role?" before writing; a negation keeps nothing; every clause of a sentence is
// kept; "birthday is 12 March" keeps the date as the value.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { loadBrain, type FactRecord } from "../src/brain";
import { readDiary } from "../src/diary";

const jane = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!;

test("'Jane is tired today' writes nothing and asks whether it's a role; the chip says it plainly and writes", () => {
  const root = makeBrain();
  const before = readDiary(root).length;
  const r = ownerSay(root, "Jane is tired today");
  expect(r.kind).toBe("say.confirm-role");
  expect(r.text).toBe("Did you mean to note a role? Jane Roy: role is tired.");
  expect(readDiary(root).length).toBe(before);
  expect((jane(root).role as FactRecord | undefined)?.value).not.toBe("tired");
  expect(r.chips).toEqual([{ label: "Yes, note the role", say: "Jane Roy's role is tired" }]);
  expect(ownerSay(root, r.chips![0]!.say).kind).toBe("say.noted");
  expect((jane(root).role as FactRecord).value).toBe("tired");
});

test("a negation keeps nothing", () => {
  const root = makeBrain();
  const was = JSON.stringify(jane(root).role);
  for (const t of ["Jane's role is not dean", "Jane isn't dean", "Jane's role is no longer dean"]) {
    const r = ownerSay(root, t);
    expect([t, r.kind]).toEqual([t, "say.negated"]);
  }
  expect(JSON.stringify(jane(root).role)).toBe(was);
});

test("every clause is kept, and a birthday keeps its date", () => {
  const root = makeBrain();
  const r = ownerSay(root, "Jane's title is dean, her birthday is 12 March");
  expect(r.kind).toBe("say.noted");
  expect((jane(root).title as FactRecord).value).toBe("dean");
  expect((jane(root).birthday as FactRecord).value).toBe("12 March");
  expect(r.text).toContain("title is dean");
  expect(r.text).toContain("birthday is 12 March");
  const r2 = ownerSay(root, "Jane's anniversary is 3 June");
  expect((jane(root).anniversary as FactRecord).value).toBe("3 June");
  expect(r2.kind).toBe("say.noted");
});
