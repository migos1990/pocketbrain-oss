// SPDX-License-Identifier: AGPL-3.0-only
// Audit v7 (2026-10-31, G557): the box with no model key failed the brief's own example sentence,
// "I owe Ben the sample by tomorrow", with "I didn't catch who or what that's about". Bring your own
// model means it works with none: a thing the owner owes someone, or means to do, is a next step on
// the page of the person it names, in the owner's words.
import { test, expect } from "bun:test";
import { makeBrain, makeDemoBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { loadBrain, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { homeView } from "../src/dashboard/home";

const step = (root: string, title: string) => (loadBrain(root).find((n) => n.fm.title === title)?.fm.facts?.next_step as FactRecord | undefined)?.value;

test("the brief's sentence, with no model, is a next step on Ben's page", async () => {
  const { root } = await makeDemoBrain();
  const r = ownerSay(root, "I owe Ben the sample by tomorrow");
  expect(r.kind).toBe("say.noted");
  expect(String(step(root, "Ben Carter"))).toMatch(/^owe Ben the sample by /);
  expect(r.text).not.toContain("left out");
  // Said back as the owner's own to-do, not "Next for Ben Carter: owe Ben…" (audits v8 to v10, G623).
  expect(r.text).toStartWith("Noted: You owe Ben the sample by ");
  expect(r.text).not.toContain("Next for");
  // and the home says it the same way.
  const v = homeView(root, loadRules(root), loadBrain(root), new Date(process.env.PB_NOW ?? Date.now()), { all: true }); const lines = [...v.since, ...v.earlier.flatMap((e) => e.lines)].map((l) => l.what);
  expect(lines.some((w) => w.startsWith("You owe Ben the sample by "))).toBe(true);
}, 60_000);

test("what the owner means to do for someone is theirs too, and names the page it's about", () => {
  const cases: [string, RegExp][] = [
    ["I need to send Jane the slides by Friday", /^need to send Jane the slides by Friday$/],
    ["I promised Jane the grades", /^promised Jane the grades$/],
    ["I have to call Jane Roy tomorrow", /^have to call Jane Roy on /],
    ["I've got to call Jane Roy tomorrow", /^have got to call Jane Roy on /],
    ["I’m going to send Jane the slides", /^are going to send Jane the slides$/],
  ];
  for (const [said, value] of cases) {
    const root = makeBrain();
    const r = ownerSay(root, said);
    expect({ said, kind: r.kind }).toEqual({ said, kind: "say.noted" });
    expect(r.text).toStartWith("Noted: You ");
    expect(String(step(root, "Jane Roy"))).toMatch(value);
  }
});

test("a to-do that names nobody the brain holds starts no page and writes nothing", () => {
  const root = makeBrain();
  const before = loadBrain(root).length;
  for (const said of ["I need to buy milk", "I owe Zed Quill fifty dollars"]) {
    const r = ownerSay(root, said);
    expect(r.kind).not.toBe("say.noted");
  }
  expect(loadBrain(root).length).toBe(before);
});
