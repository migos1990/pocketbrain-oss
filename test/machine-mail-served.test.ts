// SPDX-License-Identifier: AGPL-3.0-only
// G964: the machine-mail cleanup took only a fact still held for the owner. A fact filed from a
// no-reply mail before write() refused such mail, that assistants were already given or that became
// one side of a question, stayed, and could ask the owner to pick it. By the owner's typed yes
// (2026-11-16) it is set aside too, with Undo, and it is no side in a question.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { ownerConflicts } from "../src/core";
import { loadBrain, isList, type Fact, type FactRecord } from "../src/brain";
import { recordMachineMail, recordCheckedRefs } from "../src/louis";
import { setAsideMachineMail } from "../src/receipt-pages";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { markSeen } from "../src/seen";

const NOW = new Date("2026-10-08T15:00:00Z");
const BULK = "gmail:e0000000000000a1", BULK2 = "gmail:e0000000000000a2", HUMAN = "gmail:e0000000000000b1", HUMAN2 = "gmail:e0000000000000b2";
const page = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-b")!;
const live = (f: Fact | undefined) => !f ? [] : isList(f) ? f.items.filter((i) => !i.valid_to && !i.retired).map((i) => String(i.value)) : [String((f as FactRecord).value)];
const asks = (root: string) => ownerConflicts(root, NOW, { held: true }).length;
const planner = (root: string, attribute: string, value: string, ref: string, as_of = "2026-10-05", extra: Record<string, unknown> = {}) =>
  write(root, { agent: "planner", id: "projects/course-b", attribute, value, as_of, sources: [ref], verification: "verified-by-source", ...extra } as never);
const rows = (root: string) => readDiary(root).filter((r) => r.why === "machine");

test("G964: a fact assistants already had, from machine mail only, is set aside with Undo", () => {
  const root = makeBrain();
  recordCheckedRefs(root, { [BULK]: true, [HUMAN]: true });
  expect(planner(root, "venue_note", "Doors open at the east stairs", BULK).outcome).toBe("committed");
  expect(planner(root, "catering_note", "Soup is served at noon", HUMAN).outcome).toBe("committed");
  expect((page(root).fm.facts!.venue_note as FactRecord).unseen).toBeUndefined();
  recordMachineMail(root, [BULK]);
  expect(setAsideMachineMail(root, false).facts).toBe(1);
  expect(setAsideMachineMail(root, true).facts).toBe(1);
  expect(page(root).fm.facts!.venue_note).toBeUndefined();
  expect(live(page(root).fm.facts!.catering_note)).toEqual(["Soup is served at noon"]);
  const row = rows(root)[0]!;
  expect(row.fact_key).toBe("projects/course-b#venue_note");
  expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
  const back = page(root).fm.facts!.venue_note as FactRecord;
  expect(back.value).toBe("Doors open at the east stairs");
  expect(back.unseen).toBeUndefined();
  // The owner's Undo holds: never set aside again.
  expect(setAsideMachineMail(root, true).facts).toBe(0);
});

test("G964: a held fact the owner read and let out stays, and so does the owner's own", () => {
  const root = makeBrain();
  expect(planner(root, "venue_note", "Doors open at the east stairs", BULK, "2026-10-05", { sensitivity: "private" }).outcome).toBe("committed");
  expect((page(root).fm.facts!.venue_note as FactRecord).unseen).toBe(true);
  expect(markSeen(root, "projects/course-b#venue_note").outcome).toBe("seen");
  expect(write(root, { agent: "owner", id: "projects/course-b", attribute: "catering_note", value: "Soup is served at noon", as_of: "2026-10-05", sources: [BULK], verification: "verified-by-source" } as never, { owner: true } as never).outcome).toBe("committed");
  recordMachineMail(root, [BULK]);
  expect(setAsideMachineMail(root, true).facts).toBe(0);
  expect(page(root).fm.facts!.venue_note).toBeDefined();
});

test("G964: one of several next steps from machine mail only ends, the others stay, Undo brings it back", () => {
  const root = makeBrain();
  recordCheckedRefs(root, { [BULK]: true, [HUMAN]: true });
  expect(planner(root, "next_step", "Collect the lanyards from the copy room", HUMAN, "2026-10-04").outcome).toBe("committed");
  expect(planner(root, "next_step", "Redeem the welcome offer before Friday", "gcal:evt-offer@cal.example", "2026-10-06", { verification: "self-reported" }).outcome).toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toHaveLength(2);
  // The hub saw the second one's only source as a machine's: a mail ref for it.
  const p = page(root);
  const item = (p.fm.facts!.next_step as { items: FactRecord[] }).items.find((i) => String(i.value).startsWith("Redeem"))!;
  item.sources = [BULK]; item.verification = "verified-by-source";
  const { saveNote } = require("../src/brain"); const { commitPaths } = require("../src/git");
  saveNote(root, p); expect(commitPaths(root, [p.path], "a step filed from a bulk mail, before", "planner")).toBeFalsy();
  recordMachineMail(root, [BULK]);
  expect(setAsideMachineMail(root, true).facts).toBe(1);
  expect(live(page(root).fm.facts!.next_step)).toEqual(["Collect the lanyards from the copy room"]);
  const row = rows(root)[0]!;
  expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
  expect(live(page(root).fm.facts!.next_step)).toHaveLength(2);
});

test("G964: a question one of whose sides came only from machine mail closes as the other side, with Undo", () => {
  for (const machineFirst of [false, true]) {
    const root = makeBrain();
    recordCheckedRefs(root, { [BULK]: true, [HUMAN]: true });
    const first = machineFirst ? BULK : HUMAN, second = machineFirst ? HUMAN : BULK;
    const said = (ref: string) => ref === BULK ? "Hall C by the loading dock" : "The glass room on level two";
    expect(planner(root, "location", said(first), first).outcome).toBe("committed");
    expect(planner(root, "location", said(second), second).outcome).toBe("disputed");
    expect(asks(root)).toBe(1);
    recordMachineMail(root, [BULK]);
    expect(setAsideMachineMail(root, false).facts).toBe(1);
    expect(setAsideMachineMail(root, true).facts).toBe(1);
    expect(asks(root)).toBe(0);
    const rec = page(root).fm.facts!.location as FactRecord & { contested?: string };
    expect(rec.value).toBe(said(HUMAN));
    expect(rec.contested).toBeUndefined();
    expect(loadBrain(root).filter((n) => n.fm.type === "dispute" && ["open", "escalated"].includes(String(n.fm.status)))).toHaveLength(0);
    const row = rows(root)[0]!;
    expect(row.fact_key).toBe("projects/course-b#location");
    expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
    expect(asks(root)).toBe(1);
    // Undone once: the question is the owner's now, never closed again.
    expect(setAsideMachineMail(root, true).facts).toBe(0);
    expect(asks(root)).toBe(1);
  }
});

test("G964: a question between two people's mails is left alone; a held side stays held", () => {
  const root = makeBrain();
  recordCheckedRefs(root, { [HUMAN]: true, [HUMAN2]: true, [BULK]: true, [BULK2]: true });
  expect(planner(root, "location", "The glass room on level two", HUMAN).outcome).toBe("committed");
  expect(planner(root, "location", "Hall C by the loading dock", HUMAN2).outcome).toBe("disputed");
  recordMachineMail(root, [BULK]);
  expect(setAsideMachineMail(root, true).facts).toBe(0);
  expect(asks(root)).toBe(1);
  // A held (private) value that wins its question is still held from every assistant.
  const two = makeBrain();
  recordCheckedRefs(two, { [HUMAN]: true, [BULK]: true });
  expect(planner(two, "location", "The glass room on level two", HUMAN, "2026-10-05", { sensitivity: "private" }).outcome).toBe("committed");
  const held = (page(two).fm.facts!.location as FactRecord).unseen;
  planner(two, "location", "Hall C by the loading dock", BULK, "2026-10-05", { sensitivity: "private" });
  recordMachineMail(two, [BULK]);
  setAsideMachineMail(two, true);
  const rec = page(two).fm.facts!.location as FactRecord;
  expect(rec.value).toBe("The glass room on level two");
  expect(rec.sensitivity).toBe("private");
  expect(rec.unseen).toBe(held);
});
