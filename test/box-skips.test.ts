// SPDX-License-Identifier: AGPL-3.0-only
// Louis's third outside read (2026-10-29, G495): with a plausible model answer, "Jane said the budget
// review moved to Friday and she wants the slides by Thursday" noted "next thing to do is wants the
// slides by Thursday" and dropped the Friday move without a word. A value that reports what someone
// else does or wants is not the owner's to-do, and a part of the sentence the box kept nothing from is
// named in the reply.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay, ownerSayModel, checkReading } from "../src/owner-say";
import { makeModel } from "../src/model";
import { loadBrain, type FactRecord } from "../src/brain";

const fake = (answer: unknown) => makeModel({ provider: "fake", model: "fake-reader" }, { fake: () => JSON.stringify(answer) });
const fact = (root: string, attr: string) => (loadBrain(root).find((n) => n.fm.title === "Jane Roy")!.fm.facts?.[attr] as FactRecord | undefined)?.value;

test("Louis's sentence: someone else's want is never noted as the owner's to-do, and the reply isn't silent", async () => {
  const root = makeBrain();
  const before = fact(root, "next_step");
  const s = "Jane said the budget review moved to Friday and she wants the slides by Thursday";
  const r = await ownerSayModel(root, s, {}, fake({ kind: "tell", facts: [
    { name: "Jane", attribute: "next_step", value: "wants the slides by Thursday", when: "by Thursday" },
    { name: "budget review", attribute: "next_step", value: "moved to Friday", when: "Friday" },
  ] }));
  expect(String(fact(root, "next_step") ?? "")).not.toContain("wants");
  expect(fact(root, "next_step")).toEqual(before);
  expect(r.kind).not.toBe("say.noted");
});

test("a value that starts with someone else's verb is refused, except a role", () => {
  const s = "Jane wants the slides by Thursday, she runs the new lab";
  const read = checkReading({ kind: "tell", facts: [
    { name: "Jane", attribute: "next_step", value: "wants the slides by Thursday" },
    { name: "Jane", attribute: "role", value: "runs the new lab" },
  ] }, s, ["next_step", "role"]);
  expect(read).toEqual({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "runs the new lab" }] });
});

test("one fact kept and one left out: the reply names the part it left out", async () => {
  const root = makeBrain();
  const r = await ownerSayModel(root, "Jane is the dean and she wants the slides by Thursday", {}, fake({ kind: "tell", facts: [
    { name: "Jane", attribute: "role", value: "the dean" },
    { name: "Jane", attribute: "next_step", value: "wants the slides by Thursday", when: "by Thursday" },
  ] }));
  expect(r.kind).toBe("say.noted");
  expect(fact(root, "role")).toBe("dean");
  expect(r.text).toContain("she wants the slides by Thursday");
});

test("a part the model never read is named too", async () => {
  const root = makeBrain();
  const r = await ownerSayModel(root, "Jane is the dean, the budget review moved to Friday", {}, fake({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "the dean" }] }));
  expect(r.kind).toBe("say.noted");
  expect(r.text).toContain("the budget review moved to Friday");
});

test("sentences the box reads whole say nothing about leaving anything out", async () => {
  const sentences = ["Met Marco Bianchi yesterday, he runs the new lab", "Remind me to call Jane tomorrow", "Jane moved to Brightwave", "Jane is the dean", "Had coffee with Rita Lemieux today"];
  for (const s of sentences) {
    const r = ownerSay(makeBrain(), s);
    expect({ s, text: r.text }).toEqual({ s, text: expect.not.stringContaining("left out") });
  }
  const r = await ownerSayModel(makeBrain(), "Met Marco Bianchi yesterday, he runs the new lab", {}, fake({ kind: "tell", facts: [
    { name: "Marco Bianchi", attribute: "last_contact", value: "yesterday", when: "yesterday" },
    { name: "Marco Bianchi", attribute: "role", value: "runs the new lab" },
  ] }));
  expect(r.text).not.toContain("left out");
});
