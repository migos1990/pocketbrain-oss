// SPDX-License-Identifier: AGPL-3.0-only
// One thing to do per next step (G952). The owner's Home, 2026-11-16: one side of a conflict was a
// next step holding two unrelated to-dos, written as one value by an assistant from three mails.
// A next step is one thing to do, so a writer's own write that holds several sentences is handed
// back with the fix. Read by structure only (sentence ends outside brackets, a real sentence on
// each side), never by what a word means. The owner's own word, a value the owner accepts, and a
// value the hub files are taken as given: only the writer at its own door can send it again.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { thingsToDo } from "../src/normalize";
import { loadBrain, type FactRecord } from "../src/brain";
import { setFact } from "../src/dashboard/edit";

const base = { agent: "planner", id: "projects/course-a", attribute: "next_step", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const };
const TWO = "Order 12 litres of blue paint for the shed door before the Jun 4, 2027 sale (two coats). Ask Gus at the hardware desk whether the old brushes can be swapped (the receipt is lost; he said maybe).";

test("sentences are counted by structure: ends outside brackets, with a sentence on each side", () => {
  expect(thingsToDo(TWO)).toBe(2);
  expect(thingsToDo("Book the exam hall")).toBe(1);
  expect(thingsToDo("Book the exam hall.")).toBe(1);
  // An abbreviation or an initial is not a sentence end: too few words before or after it.
  expect(thingsToDo("Call Dr. Roy about the roof")).toBe(1);
  expect(thingsToDo("Send the draft to J. Smith on Friday")).toBe(1);
  // A longer title or short form before a name is no end either (code review of PR 214).
  expect(thingsToDo("Send the syllabus to Prof. Tremblay before Friday")).toBe(1);
  expect(thingsToDo("Write back to Mrs. Lake about the visit")).toBe(1);
  expect(thingsToDo("Send the signed form to Acme Corp. Montreal by Friday")).toBe(1);
  expect(thingsToDo("Envoyer le plan à Mme. Roy avant vendredi")).toBe(1);
  // A sentence end inside brackets is part of the one thing.
  expect(thingsToDo("Ask the bakery about the cake (Oven two is down. Ana has their number)")).toBe(1);
  // No capital after it: one sentence going on.
  expect(thingsToDo("Send v2.1 of the plan. then nothing")).toBe(1);
  expect(thingsToDo("Réserver la salle d'examen. Écrire aux étudiants du cours.")).toBe(2);
  expect(thingsToDo("Book the hall! Write to the students? Send the list to Ana.")).toBe(3);
  expect(thingsToDo(42)).toBe(1);
  // What it does not catch (kept as rows so the limit is known): a sentence ending in a short
  // word, and two things joined without a sentence end.
  expect(thingsToDo("Send it. Call me after the class.")).toBe(1);
  expect(thingsToDo("Book the exam hall and write to the students")).toBe(1);
  // What it hands back although it is one thing: a second sentence that only explains the first.
  expect(thingsToDo("Call the caterer about Friday. They close at five.")).toBe(2);
});

test("a writer's own next step holding two things to do is handed back with the fix, and nothing is written", () => {
  const root = makeBrain();
  const r = write(root, { ...base, value: TWO } as never);
  expect(r.outcome).toBe("refused");
  expect(r.fails!.map((f) => [f.check, f.outcome])).toEqual([["one_step", "refuse"]]);
  expect(r.fails![0]!.fix).toBe("a next step is one thing to do: send the next one alone, in one sentence");
  // The reply names nothing from the brain: only the count the writer sent.
  expect(r.message).toBe("one_step: the next step holds 2 things to do. Fix: a next step is one thing to do: send the next one alone, in one sentence");
  expect(write(root, { ...base, value: "Paint the shed door blue" } as never).outcome).toBe("committed");
});

test("only next steps, only the writer's own write: other attributes, the owner's word and a value the owner accepts are taken as given", () => {
  const root = makeBrain();
  expect(write(root, { ...base, attribute: "status", value: "The hall is booked. The list went out to the students." } as never).fails ?? []).toEqual([]);
  setFact(root, "projects/course-a", "next_step", TWO);
  expect((loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord).value).toBe(TWO);
  const root2 = makeBrain();
  const accepted = write(root2, { ...base, value: TWO } as never, { acceptedBy: "owner" });
  expect(accepted.fails ?? []).toEqual([]);
});
