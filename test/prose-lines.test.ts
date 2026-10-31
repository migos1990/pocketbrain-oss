// SPDX-License-Identifier: AGPL-3.0-only
// A prose attribute reads as a sentence (coordinator, from the demo brain, 2026-10-30, G512): the
// home said "Diego Alvarez: prefers is long novels". An attribute that is itself a verb ("prefers")
// reads "Jane Roy prefers long novels" on the home and in the box's replies, never "prefers is".
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { homeView } from "../src/dashboard/home";
import { ownerSay } from "../src/owner-say";
import { loadRules } from "../src/rules";
import { loadBrain, today } from "../src/brain";
import { ownerRef } from "../src/owner";

const lines = (root: string) => homeView(root, loadRules(root), loadBrain(root), new Date(`${today()}T14:00:00Z`)).since.map((l) => l.what);

test("a preference on the home reads as a sentence, first and added", () => {
  const root = makeBrain();
  const d = today();
  for (const value of ["long novels", "email over phone calls"]) {
    const r = write(root, { agent: "owner", id: "people/jane-roy", attribute: "prefers", value, as_of: d, sources: [ownerRef(d, "home")], verification: "confirmed-by-owner" }, { owner: true });
    expect(r.outcome).not.toBe("refused");
  }
  const got = lines(root);
  expect(got).toContain("Jane prefers long novels.");
  expect(got).toContain("Jane prefers email over phone calls.");
  expect(got.join("\n")).not.toMatch(/prefers is|added to prefers/);
});

test("the box's reply about a preference reads as a sentence too", () => {
  const root = makeBrain();
  const r = ownerSay(root, "Jane Roy's prefers is long novels");
  expect(r.text).not.toContain("prefers is");
});

test("a question about a preference is answered as a sentence", () => {
  const root = makeBrain();
  ownerSay(root, "Jane Roy's prefers is long novels");
  const r = ownerSay(root, "what is Jane Roy's prefers?");
  expect(r.kind).toBe("say.answer");
  expect(r.text).toBe("Here's what I have: Jane Roy prefers long novels.");
});
