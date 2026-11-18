// SPDX-License-Identifier: AGPL-3.0-only
// G988 (the Home property test, 2026-11-17): on a mail source that reads machine mail
// (skip_bulk: false), a no-reply sender's value filed like a person's, and beside a person's
// different value it became a question on the home with the machine's value as a side. A value
// that came only from machine mail is no side in a question, whichever came first (the owner's
// typed yes, 2026-11-16): against a held value it is set aside with Undo, and a held one gives way
// to a person's, kept in history, with Undo.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto, undoAuto } from "../src/filing";
import { ownerConflicts } from "../src/core";
import { recordCheckedRefs, recordMachineMail } from "../src/louis";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { git } from "../src/git";

const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const DAY = "2026-10-07";
const PERSON_SAYS = "treasurer of the rowing club", ROBOT_SAYS = "gold tier member";
const mail = (id: string, from: string, says: string) => ({ id, threadId: id, internalDate: String(Date.parse(`${DAY}T10:00:00Z`)), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: from }, { name: "To", value: "me@example.org" }, { name: "Subject", value: "Ilse Brandt" }] }, text: `Ilse Brandt (person) role: ${says}` });
const PERSON = mail("eeeeeeeeeeeeee01", "Odile Marchetti <odile@studio.example>", PERSON_SAYS);
const ROBOT = mail("eeeeeeeeeeeeee02", "Depot <no-reply@depot.example>", ROBOT_SAYS);

function brain(held: { value: string; id: string }, incoming: unknown) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json", skip_bulk: false } } }));
  writeFileSync(join(root, "people", "ilse-brandt.md"), `---\nid: people/ilse-brandt\ntype: person\ntitle: Ilse Brandt\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: capture\nfacts:\n  role: { value: "${held.value}", as_of: ${DAY}, sources: ["gmail:${held.id}"], verification: verified-by-source, by: capture, recorded: ${DAY} }\n---\n`);
  writeFileSync(join(root, "m.json"), JSON.stringify([incoming]));
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "owner: setup"]);
  recordCheckedRefs(root, { [`gmail:${held.id}`]: true });
  return root;
}
const fact = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/ilse-brandt")!.fm.facts!.role as FactRecord;
const open = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute" && ["open", "escalated"].includes(String(n.fm.status)));
const asks = (root: string) => ownerConflicts(root, new Date(), { held: true }).length;

test("G988: a no-reply mail's different value beside a person's is set aside, never a question", async () => {
  const root = brain({ value: PERSON_SAYS, id: PERSON.id }, ROBOT);
  await pullSource(root, "mail", { model });
  const rows = runAuto(root, new Date());
  expect(rows.map((x) => x.picked)).toEqual(["set it aside"]);
  expect(rows[0]!.why).toContain("mail a machine sent");
  expect(fact(root).value).toBe(PERSON_SAYS);
  expect(open(root)).toHaveLength(0);
  expect(asks(root)).toBe(0);
  // Undo brings the proposal back, and then it waits for the owner: never set aside twice.
  expect(undoAuto(root, rows[0]!.key)).not.toBe("already undone");
  expect(runAuto(root, new Date())).toEqual([]);
});

test("G988: a person's different value takes over from one that came only from a no-reply mail", async () => {
  const root = brain({ value: ROBOT_SAYS, id: ROBOT.id }, PERSON);
  recordMachineMail(root, [`gmail:${ROBOT.id}`]);
  await pullSource(root, "mail", { model });
  runAuto(root, new Date());
  expect(fact(root).value).toBe(PERSON_SAYS);
  expect(fact(root).contested).toBeUndefined();
  expect(open(root)).toHaveLength(0);
  expect(asks(root)).toBe(0);
  const row = readDiary(root).find((r) => r.fact_key === "people/ilse-brandt#role" && r.why === "machine")!;
  expect(row.undo_token).toBeDefined();
  // Undo opens the question again, and it is the owner's from then on.
  expect(undoFact(root, row.undo_token!).outcome).toBe("undone");
  expect(asks(root)).toBe(1);
});

test("G988: two people's mails that disagree still ask", async () => {
  const other = mail("eeeeeeeeeeeeee03", "Bram Solheim <bram@studio.example>", "coach of the junior crew");
  const root = brain({ value: PERSON_SAYS, id: PERSON.id }, other);
  await pullSource(root, "mail", { model });
  runAuto(root, new Date());
  expect(open(root)).toHaveLength(1);
});
