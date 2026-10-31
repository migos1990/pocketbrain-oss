// SPDX-License-Identifier: AGPL-3.0-only
// The owner's text box (phone UI spec §4, owner 2026-10-26): fixed patterns, no model; a question
// never writes; a told fact is the owner's own word through write(); one fixed sentence per outcome.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { intentOf, parseTell, whenOf, ownerSay } from "../src/owner-say";
import { loadBrain, type FactRecord } from "../src/brain";
import { readDiary } from "../src/diary";
import { write } from "../src/write";

const jane = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
const commits = (root: string) => new TextDecoder().decode(Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: root }).stdout).trim();

test("intents", () => {
  expect(intentOf("what's Jane's role?")).toBe("lookup");
  expect(intentOf("Who is Jane Roy")).toBe("lookup");
  expect(intentOf("Jane is now program director")).toBe("tell");
  expect(intentOf("forget Paul Advisor")).toBe("forget");
  expect(intentOf("send Jane a reply")).toBe("act");
  expect(intentOf("tell Jane to call me")).toBe("act");
});

test("patterns", () => {
  const d = "2026-10-26";
  expect(parseTell("Jane Roy is now program director", d)).toMatchObject({ name: "Jane Roy", attribute: "role", value: "program director" });
  expect(parseTell("Jane works at Bay Institute", d)).toMatchObject({ name: "Jane", attribute: "org", value: "Bay Institute" });
  expect(parseTell("Jane's phone number is 514 555 0199", d)).toMatchObject({ name: "Jane", attribute: "phone_number", value: "514 555 0199" });
  expect(parseTell("Course A: next step is send the room plan", d)).toMatchObject({ name: "Course A", attribute: "next_step", value: "send the room plan" });
  expect(parseTell("met Jane yesterday", d)).toMatchObject({ name: "Jane", attribute: "last_contact", value: "2026-10-25" });
  expect(parseTell("Ana isn't at North College anymore, she moved to Bay Institute last week", d)).toMatchObject({ name: "Ana", attribute: "org", value: "Bay Institute", when: { as_of: "2026-10-19", approx: true, phrase: "last week" } });
  expect(parseTell("the weather is nice and warm", d)).toBeUndefined(); // a thing, never someone's role (G476)
  expect(parseTell("hello there", d)).toBeUndefined();
});

test("a date the owner didn't say is never made up: none means today, a vague one is marked approximate", () => {
  expect(whenOf("Jane moved", "2026-10-26").when).toBeUndefined();
  expect(whenOf("Jane moved on 12 Oct", "2026-10-26").when).toEqual({ phrase: "on 12 Oct", as_of: "2026-10-12", approx: false });
  expect(whenOf("Jane moved last month", "2026-10-26").when?.approx).toBe(true);
});

test("a question never writes", () => {
  const root = makeBrain();
  const n = commits(root);
  const r = ownerSay(root, "what is Jane Roy's role?");
  expect(r.kind).toBe("say.answer");
  expect(r.text).toStartWith("Here's what I have:");
  expect(r.text).toContain("Course coordinator");
  expect(commits(root)).toBe(n);
  expect(readDiary(root)).toHaveLength(0);
});

test("a told fact is saved as the owner's word, with a diary line, Undo and its audience", () => {
  const root = makeBrain();
  const r = ownerSay(root, "Jane Roy's role is program director");
  expect(r.kind).toBe("say.noted");
  expect(r.text).toBe("Noted: Jane Roy: role is program director. Seen by your assistants.");
  const f = jane(root).fm.facts!.role as FactRecord;
  expect(f.value).toBe("program director");
  expect(f.verification).toBe("confirmed-by-owner");
  expect(f.by).toBe("owner");
  const row = readDiary(root).at(-1)!;
  expect(row.source_word).toBe("you");
  expect(r.undo_token).toBe(row.undo_token);
});

test("on a page, a pronoun means that page", () => {
  const root = makeBrain();
  const r = ownerSay(root, "she works at Bay Institute", { page: "people/jane-roy" });
  expect(r.kind).toBe("say.noted");
  expect(String((jane(root).fm.facts!.org as FactRecord).value)).toContain("Bay Institute");
});

test("a vague date is said back as a guess", () => {
  const root = makeBrain();
  const r = ownerSay(root, "Jane moved to Bay Institute last week");
  expect(r.kind).toBe("say.noted");
  expect(r.text).toContain("I guessed around");
  expect((jane(root).fm.facts!.org as FactRecord).as_of_approx).toBe(true);
});

test("the owner's word replaces an assistant's value without asking", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "Senior assistant", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  expect(ownerSay(root, "Jane Roy's role is program director").kind).toBe("say.noted");
  expect((jane(root).fm.facts!.role as FactRecord).value).toBe("program director");
  expect(loadBrain(root).filter((n) => n.fm.type === "dispute")).toHaveLength(0);
});

test("saying it again changes nothing", () => {
  const root = makeBrain();
  ownerSay(root, "Jane Roy's role is program director");
  const r = ownerSay(root, "Jane Roy's role is program director");
  expect(r.kind).toBe("say.already");
});

test("a near name asks, an unknown one never makes a page", () => {
  const root = makeBrain();
  const near = ownerSay(root, "Jane Ray is program director");
  expect(near.kind).toBe("say.near-name");
  expect(near.text).toBe("I don't know Jane Ray. Did you mean Jane Roy?");
  const n = loadBrain(root).length;
  // No article: the owner confirms it's a role, and the page starts only on that tap.
  const none = ownerSay(root, "Zed Quorum is program director");
  expect(none.kind).toBe("say.confirm-role");
  expect(none.chips![0]!.say).toBe("new page in personal: Zed Quorum's role is program director");
  expect(loadBrain(root)).toHaveLength(n);
});

test("a secret is refused in plain words, by its name or its shape", () => {
  const root = makeBrain();
  const n = commits(root);
  for (const t of ["Jane's password is hunter2-" + "Xy9!kQ", "Jane's card is 4111 1111 " + "1111 1111", "Jane's pin is 4421"]) {
    const r = ownerSay(root, t);
    expect(r.kind).toBe("say.refused");
    expect(r.text).toBe("Here's what I have: nothing new. That looks like a password or a number to keep secret; I don't keep those.");
  }
  expect(commits(root)).toBe(n);
});

test("forget and act never write", () => {
  const root = makeBrain();
  const n = commits(root);
  expect(ownerSay(root, "forget Paul Advisor").kind).toBe("say.forget-confirm");
  expect(ownerSay(root, "send Jane a reply").kind).toBe("say.act");
  expect(commits(root)).toBe(n);
});

test("only the owner's own word gets the owner option", () => {
  const root = makeBrain();
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value: "x", as_of: "2026-10-05", sources: ["owner:2026-10-05/home"], verification: "confirmed-by-owner" } as never, { owner: true });
  expect(r.outcome).toBe("refused");
});
