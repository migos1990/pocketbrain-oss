// SPDX-License-Identifier: AGPL-3.0-only
// The independent review of the box's reading (2026-10-29, G476): what the looser patterns and the
// model's reading must never do. A page starts without asking only for a name that looks like one; a
// question or a "not" sentence never writes; a new person never takes the area of someone who only
// shares a first name; a reminder keeps its day; replies say dates and attributes in the owner's words.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay, ownerSayModel } from "../src/owner-say";
import { makeModel, type ModelRequest } from "../src/model";
import { loadBrain, isList, today, type FactRecord, type Note } from "../src/brain";
import { FORBIDDEN } from "./owner-copy.test";
import { attrWords } from "../src/dashboard/home";

const fake = (answer: unknown) => {
  const calls: ModelRequest[] = [];
  return { calls, model: makeModel({ provider: "fake", model: "fake-reader" }, { fake: (req) => { calls.push(req); return JSON.stringify(answer); } }) };
};
const page = (root: string, title: string): Note | undefined => loadBrain(root).find((n) => n.fm.title === title);
const value = (n: Note | undefined, attr: string): string => {
  const f = n?.fm.facts?.[attr];
  if (!f) return "";
  return isList(f) ? f.items.filter((i) => !i.valid_to).map((i) => String(i.value)).join(", ") : String((f as FactRecord).value);
};

test("a sentence that isn't about a name never starts a page", () => {
  for (const s of ["Saw the movie with Jane", "Spoke to Jane about the grant", "Called it a day", "It is a good day", "This week is a mess", "The meeting is at noon"]) {
    const root = makeBrain();
    const before = loadBrain(root).map((n) => n.fm.id).sort();
    const r = ownerSay(root, s);
    expect({ s, made: loadBrain(root).map((n) => n.fm.id).sort().filter((id) => !before.includes(id)) }).toEqual({ s, made: [] });
    // "Spoke to Jane about the grant" is a contact with Jane, and noted on her page.
    if (!s.includes("Jane")) expect(r.kind).not.toBe("say.noted");
  }
});

test("'Jane runs every morning' is not a role; 'he runs the new lab' is", () => {
  const root = makeBrain();
  ownerSay(root, "Jane runs every morning");
  expect(value(page(root, "Jane Roy"), "role")).toBe("Course coordinator");
});

test("a question or a 'not' sentence the model reads as facts writes nothing", async () => {
  for (const s of ["Is Jane the dean?", "Jane is not the dean"]) {
    const root = makeBrain();
    const { model } = fake({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "the dean" }] });
    await ownerSayModel(root, s, {}, model);
    expect({ s, role: value(page(root, "Jane Roy"), "role") }).toEqual({ s, role: "Course coordinator" });
  }
});

test("a pronoun with no page to mean never starts a page", async () => {
  const root = makeBrain();
  const before = loadBrain(root).length;
  const { model } = fake({ kind: "tell", facts: [{ name: "He", attribute: "role", value: "runs the new lab" }] });
  await ownerSayModel(root, "He runs the new lab", {}, model);
  ownerSay(root, "Remind me to call Jane, she is the dean");
  expect(loadBrain(root).length).toBe(before);
  expect(page(root, "Remind")).toBeUndefined();
});

test("a new person who only shares a first name with a page doesn't take its area", () => {
  const root = makeBrain();
  ownerSay(root, "Jane Doe works at Bay Institute");
  expect(page(root, "Jane Doe")!.fm.area).toBe("personal");
});

test("a reminder about someone else with the same first name isn't put on the wrong page", () => {
  const root = makeBrain();
  ownerSay(root, "Remind me to call Jane Doe tomorrow");
  expect(value(page(root, "Jane Roy"), "next_step")).toBe("");
});

test("a reminder keeps the day it was said for", async () => {
  const root = makeBrain();
  ownerSay(root, "Remind me to call Jane on 12 Nov");
  expect(value(page(root, "Jane Roy"), "next_step")).toContain("12 Nov");
  const r2 = makeBrain();
  const { model } = fake({ kind: "tell", facts: [{ name: "Jane", attribute: "next_step", value: "call Jane", when: "on 12 Nov" }] });
  await ownerSayModel(r2, "Remind me to call Jane on 12 Nov", {}, model);
  const f = page(r2, "Jane Roy")!.fm.facts!.next_step as FactRecord;
  expect(String(f.value)).toContain("12 Nov");
  expect(String(f.as_of) >= today()).toBe(true);
  expect(String(f.value)).not.toContain("tomorrow");
});

test("time words the box can't date never become today", async () => {
  const root = makeBrain();
  const { model } = fake({ kind: "tell", facts: [{ name: "Jane", attribute: "last_contact", value: "last Tuesday", when: "last Tuesday" }] });
  await ownerSayModel(root, "Met Jane last Tuesday", {}, model);
  expect(value(page(root, "Jane Roy"), "last_contact")).not.toBe(today());
});

test("a date that is the value is not when it was said", async () => {
  const root = makeBrain();
  const { model } = fake({ kind: "tell", facts: [{ name: "Jane", attribute: "birthday", value: "12 March", when: "12 March" }] });
  await ownerSayModel(root, "Jane's birthday is 12 March", {}, model);
  expect(String((page(root, "Jane Roy")!.fm.facts!.birthday as FactRecord).as_of)).toBe(today());
});

test("a health or legal sentence is not sent to a model allowed only everyday notes", async () => {
  const root = makeBrain();
  const { model, calls } = fake({ kind: "unclear" });
  await ownerSayModel(root, "Jane's diagnosis is diabetes", {}, model);
  expect(calls.length).toBe(0);
});

test("a private page says nothing about what it holds before a fresh sign-in", () => {
  const root = makeBrain();
  const r = ownerSay(root, "what is Main bank's colour?");
  expect(r.kind).toBe("say.answer-signin");
});

test("replies say days and attributes in the owner's words", () => {
  const root = makeBrain();
  const r = ownerSay(root, "Met Marco Bianchi yesterday, he runs the new lab");
  expect(r.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  const t = ownerSay(root, "Remind me to call Jane tomorrow");
  expect(FORBIDDEN.filter((w) => new RegExp(`\\b${w}`, "i").test(t.text))).toEqual([]);
  expect(FORBIDDEN.filter((w) => new RegExp(`\\b${w}`, "i").test(attrWords("next_step")))).toEqual([]);
  expect(value(page(root, "Jane Roy"), "next_step")).not.toContain("tomorrow");
});

test("a model's role for a bare 'Jane is tired' still asks first, as the patterns do", async () => {
  const root = makeBrain();
  const { model } = fake({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "tired" }] });
  const r = await ownerSayModel(root, "Jane is tired", {}, model);
  expect(r.kind).toBe("say.confirm-role");
  expect(value(page(root, "Jane Roy"), "role")).toBe("Course coordinator");
});
