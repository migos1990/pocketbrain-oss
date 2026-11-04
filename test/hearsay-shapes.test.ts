// SPDX-License-Identifier: AGPL-3.0-only
// Audit v7, medium (G556): G528 caught "Paul told me …", "according to …", "I heard …", but other
// shapes of someone else's word ("Per Paul, Jane is the dean", "Jane is the dean, Paul says",
// "Selon Paul, …") still filed at the owner's rank. Any of them is that person's word: the box files
// nothing and says whose word it is.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay, hearsay } from "../src/owner-say";
import { loadBrain, type FactRecord } from "../src/brain";

const roles = (root: string) => Object.fromEntries(loadBrain(root).filter((n) => /jane|paul/.test(n.fm.id)).map((n) => [n.fm.id, (n.fm.facts?.role as FactRecord | undefined)?.value]));

const SHAPES: [string, string][] = [
  ["Per Paul, Jane is the dean", "Paul"],
  ["As per Paul, Jane is the dean", "Paul"],
  ["Per Paul: Jane is the dean", "Paul"],
  ["Via Paul, Jane is the dean", "Paul"],
  ["From Paul: Jane is the dean", "Paul"],
  ["As Paul put it, Jane is the dean", "Paul"],
  ["Paul let me know Jane is the dean", "Paul"],
  ["Paul informed me that Jane is the dean", "Paul"],
  ["Paul pointed out that Jane is the dean", "Paul"],
  ["Paul's take: Jane is the dean", "Paul"],
  ["Heard from Paul that Jane is the dean", "Paul"],
  ["Jane is the dean, Paul says", "Paul"],
  ["Jane is the dean, according to Paul", "Paul"],
  ["Jane is the dean (per Paul)", "Paul"],
  ["Jane is the dean per Paul", "Paul"],
  ["Jane is the dean, or so Paul says", "Paul"],
  ["Jane is the dean, says Paul", "Paul"], // G661: the verb before the name
  ["Jane is the dean (says Paul)", "Paul"],
  ["In Paul's words, Jane is the dean", "Paul"],
  ["Supposedly Jane is the dean", "someone else"],
  ["Reportedly, Jane is the dean", "someone else"],
  ["Allegedly Jane is the dean", "someone else"],
  ["Selon Paul, Jane est la doyenne", "Paul"],
  ["D'après Paul, Jane est la doyenne", "Paul"],
  ["Paul m'a dit que Jane est la doyenne", "Paul"],
  ["Paul dit que Jane est la doyenne", "Paul"],
  ["Apparemment Jane est la doyenne", "someone else"],
  ["Il paraît que Jane est la doyenne", "someone else"],
  ["J'ai entendu dire que Jane est la doyenne", "someone else"],
];

test("each shape of someone else's word is theirs, and names them (G556)", () => {
  for (const [s, who] of SHAPES) {
    const h = hearsay(s);
    expect(h, s).toBeDefined();
    expect(h!.who, s).toBe(who);
    expect(h!.rest.toLowerCase(), s).toContain("jane");
    expect(h!.rest.toLowerCase(), s).not.toContain("paul");
  }
});

test("the box files none of them (G556)", () => {
  const root = makeBrain();
  const before = roles(root);
  for (const [s] of SHAPES.filter(([x]) => /dean/.test(x))) expect(ownerSay(root, s).kind, s).toBe("say.hearsay");
  expect(roles(root)).toEqual(before);
});

test("the owner's own sentences with those words are not hearsay (G556)", () => {
  for (const s of ["Jane is the dean", "Jane earns 90k per year", "Paul is paid per hour", "Jane moved from Paris to Lyon", "Jane says hi", "Jane is the dean of permaculture", "Paul's take-home pay went up", "Supper with Jane at 7", "Jane via Zoom tomorrow"]) expect(hearsay(s), s).toBeUndefined();
});
