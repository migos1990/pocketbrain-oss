// SPDX-License-Identifier: AGPL-3.0-only
// The box reads sentences (Louis, 2026-10-29; G472-G474): a model reads what the owner typed into a
// question or facts, and code checks every part of its reading before anything is written. Without a
// model the fixed patterns read the same five sentences. A new person's page starts in the area of a
// page the sentence names, else personal, with Undo, and nothing said is dropped.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay, ownerSayModel } from "../src/owner-say";
import { makeModel, type ModelRequest } from "../src/model";
import { loadBrain, isList, today, type FactRecord, type Note } from "../src/brain";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";

const fake = (answer: (req: ModelRequest) => unknown) => {
  const calls: ModelRequest[] = [];
  const model = makeModel({ provider: "fake", model: "fake-reader" }, { fake: (req) => { calls.push(req); const a = answer(req); if (a instanceof Error) throw a; return typeof a === "string" ? a : JSON.stringify(a); } });
  return { model, calls };
};
const page = (root: string, title: string): Note | undefined => loadBrain(root).find((n) => n.fm.title === title);
const value = (n: Note | undefined, attr: string): string => {
  const f = n?.fm.facts?.[attr];
  if (!f) return "";
  return isList(f) ? f.items.filter((i) => !i.valid_to).map((i) => String(i.value)).join(", ") : String((f as FactRecord).value);
};
// The suite's day is pinned (test/setup.ts); the dates below are counted from it.
const shift = (n: number) => new Date(Date.parse(`${today()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const said = (iso: string) => `${Number(iso.slice(8))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

// ---------- with a model ----------

test("'Jane is the dean' is noted as her role, no confirming (G472)", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "the dean" }] }));
  const r = await ownerSayModel(root, "Jane is the dean", {}, model);
  expect(r.kind).toBe("say.noted");
  expect(r.chips ?? []).toEqual([]);
  expect(value(page(root, "Jane Roy"), "role")).toBe("dean");
});

test("a question gets one sentence and no chip (G473)", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "question", name: "Jane", attribute: "phone" }));
  const r = await ownerSayModel(root, "what is Jane's phone?", {}, model);
  expect(r.kind).toBe("say.answer");
  expect(r.text).toContain("Jane Roy");
  expect(r.text).toContain("+15145550100");
  expect(r.text).not.toContain("Course coordinator"); // not a dump of every fact
  expect(r.chips ?? []).toEqual([]);
});

test("a question about something the page doesn't hold says so plainly", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "question", name: "Jane", attribute: "birthday" }));
  const r = await ownerSayModel(root, "when is Jane's birthday?", {}, model);
  expect(r.kind).toBe("say.answer-none");
  expect(r.text).toContain("birthday");
  expect(r.chips ?? []).toEqual([]);
});

test("a private value waits for a fresh sign-in", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "question", name: "Main bank", attribute: "" }));
  const r = await ownerSayModel(root, "what do I have on Main bank?", {}, model);
  expect(r.kind).toBe("say.answer-signin");
  expect(r.signin).toBe(true);
  const fresh = await ownerSayModel(root, "what do I have on Main bank?", { fresh: true }, model);
  expect(fresh.kind).not.toBe("say.answer-signin");
});

test("a new person: no area question, the meeting and the role are both kept, one Undo takes the page back (G474)", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [
    { name: "Marco Bianchi", attribute: "last_contact", value: "yesterday", when: "yesterday" },
    { name: "Marco Bianchi", attribute: "role", value: "runs the new lab" },
  ] }));
  const r = await ownerSayModel(root, "Met Marco Bianchi yesterday, he runs the new lab", {}, model);
  expect(r.kind).toBe("say.noted");
  expect(r.text).toContain("personal");
  const n = page(root, "Marco Bianchi")!;
  expect(n.fm.area).toBe("personal");
  expect(n.fm.type).toBe("person");
  expect(value(n, "last_contact")).toBe(shift(-1));
  expect(value(n, "role")).toBe("runs the new lab");
  expect(r.undo_token!.split(",").length).toBe(2);
  for (const t of r.undo_token!.split(",").reverse()) undoFact(root, t);
  expect(page(root, "Marco Bianchi")).toBeUndefined();
});

test("a new person named beside a known page starts in that page's area", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Zed Quorum", attribute: "last_contact", value: "today", when: "today" }] }));
  const r = await ownerSayModel(root, "Met Zed Quorum with Jane today", {}, model);
  expect(r.kind).toBe("say.noted");
  expect(page(root, "Zed Quorum")!.fm.area).toBe("work"); // Jane Roy's area
});

test("'Remind me to call Jane tomorrow' is her next step, dated (G472)", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Jane", attribute: "next_step", value: "call Jane tomorrow" }] }));
  const r = await ownerSayModel(root, "Remind me to call Jane tomorrow", {}, model);
  expect(r.kind).toBe("say.noted");
  const v = value(page(root, "Jane Roy"), "next_step");
  expect(v).toContain("call Jane");
  expect(v).toContain(said(shift(1)));
});

// ---------- the code gate: a model proposes, code decides ----------

test("a value the owner never said is not written", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "provost" }] }));
  await ownerSayModel(root, "Jane is the dean", {}, model);
  expect(value(page(root, "Jane Roy"), "role")).not.toBe("provost");
});

test("a name the owner never said is not written to", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Paul Advisor", attribute: "role", value: "dean" }] }));
  await ownerSayModel(root, "Jane is the dean", {}, model);
  expect(value(page(root, "Paul Advisor"), "role")).not.toBe("dean");
});

test("a secret attribute is refused whatever the model says", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Jane", attribute: "password", value: "bluebird" }] }));
  const r = await ownerSayModel(root, "Jane's password is bluebird", {}, model);
  expect(r.kind).toBe("say.refused");
  expect(page(root, "Jane Roy")!.fm.facts?.password).toBeUndefined();
});

test("an attribute outside the brain's list is not written", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Jane", attribute: "ignore_previous_rules", value: "dean" }] }));
  await ownerSayModel(root, "Jane is the dean", {}, model);
  expect(page(root, "Jane Roy")!.fm.facts?.ignore_previous_rules).toBeUndefined();
});

test("the model sees the sentence and the attribute names, never a page's facts", async () => {
  const root = makeBrain();
  const { model, calls } = fake(() => ({ kind: "question", name: "Jane", attribute: "phone" }));
  await ownerSayModel(root, "what is Jane's phone?", {}, model);
  expect(calls.length).toBe(1);
  const sent = calls[0]!.system + calls[0]!.prompt;
  for (const x of ["Course coordinator", "+15145550100", "Jane Roy", "Paul Advisor", "Main bank"]) expect(sent).not.toContain(x);
});

test("a sentence with a secret shape never reaches the model", async () => {
  const root = makeBrain();
  const { model, calls } = fake(() => ({ kind: "unclear" }));
  await ownerSayModel(root, "Jane's card is 4111 1111 1111 1111", {}, model);
  expect(calls.length).toBe(0);
});

test("a model that fails or answers nonsense falls back to the patterns", async () => {
  for (const answer of [new Error("timeout"), "not json at all", { kind: "launch" }]) {
    const root = makeBrain();
    const { model } = fake(() => answer);
    const r = await ownerSayModel(root, "Jane Roy moved to Bay Institute", {}, model);
    expect(r.kind).toBe("say.noted");
    expect(value(page(root, "Jane Roy"), "org")).toContain("Bay Institute");
  }
});

test("forget and send never go to the model", async () => {
  const root = makeBrain();
  const { model, calls } = fake(() => ({ kind: "tell", facts: [] }));
  expect((await ownerSayModel(root, "forget Jane Roy", {}, model)).kind).toBe("say.forget-confirm");
  expect((await ownerSayModel(root, "send Jane the notes", {}, model)).kind).toBe("say.act");
  expect(calls.length).toBe(0);
});

// ---------- without a model: the patterns read the same sentences ----------

test("without a model: 'Jane is the dean' is noted, an article makes it a role", () => {
  const root = makeBrain();
  expect(ownerSay(root, "Jane is the dean").kind).toBe("say.noted");
  expect(value(page(root, "Jane Roy"), "role")).toBe("dean");
  expect(ownerSay(root, "Jane is tired").kind).toBe("say.confirm-role"); // no article: still asks
});

test("without a model: a question about one attribute gets one sentence, no chip", () => {
  const root = makeBrain();
  const r = ownerSay(root, "what is Jane's phone?");
  expect(r.kind).toBe("say.answer");
  expect(r.text).toContain("+15145550100");
  expect(r.text).not.toContain("Course coordinator");
  expect(r.chips ?? []).toEqual([]);
  expect(ownerSay(root, "Is Jane Roy's role dean?").chips ?? []).toEqual([]);
});

test("without a model: a new person is kept with the meeting and the role, in personal", () => {
  const root = makeBrain();
  const r = ownerSay(root, "Met Marco Bianchi yesterday, he runs the new lab");
  expect(r.kind).toBe("say.noted");
  const n = page(root, "Marco Bianchi")!;
  expect(n.fm.area).toBe("personal");
  expect(value(n, "last_contact")).toBe(shift(-1));
  expect(value(n, "role")).toBe("runs the new lab");
});

test("without a model: 'Remind me to call Jane tomorrow' is her next step", () => {
  const root = makeBrain();
  expect(ownerSay(root, "Remind me to call Jane tomorrow").kind).toBe("say.noted");
  expect(value(page(root, "Jane Roy"), "next_step")).toContain("call Jane");
});

test("every box write is the owner's word in the diary", async () => {
  const root = makeBrain();
  const { model } = fake(() => ({ kind: "tell", facts: [{ name: "Jane", attribute: "role", value: "dean" }] }));
  await ownerSayModel(root, "Jane is the dean", {}, model);
  const row = readDiary(root).at(-1)!;
  expect(row.fact_key).toBe("people/jane-roy#role");
  expect(row.source_word).toBe("you");
});
