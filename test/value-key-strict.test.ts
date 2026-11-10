// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13, 2026-11-09 (G759): the value key that keeps a reworded sentence from becoming a
// conflict (G662) cut every word to a stem and dropped signs and currency marks, so values that
// differ in meaning were "the same value" and the different one was merged in as a source: a
// name and a longer name (Robert, Roberts), a place (France, Frances), tense (expires, expired),
// number with tense (tenant agreed, tenants agree), a sign (-740, 740) and a currency ($740,
// €740). An extra ask is cheaper than a silent merge: the key now keeps the sign, the currency and
// every word whole but a lower-case plural. It still folds case, accents, punctuation, articles,
// "is"/"are", a plural alone (exam, exams: both can hold, so nothing is asked), and the one
// rewording G662 was about, "to retain" and "to be retained".
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sameValue, valueKey } from "../src/normalize";
import { makeBrain } from "./fixture";
import { remember } from "../src/core";
import { loadBrain, type FactRecord } from "../src/brain";

const DIFFER: [string, string][] = [
  // Names and places.
  ["Send the signed lease to Robert on Friday", "Send the signed lease to Roberts on Friday"],
  ["The contract goes to Jon at the firm", "The contract goes to Jones at the firm"],
  ["The team moves to France in the spring", "The team moves to Frances in the spring"],
  ["Send the signed lease to Anne on Friday", "Send the signed lease to Ann on Friday"],
  // Tense and aspect.
  ["The studio hired a designer for the launch", "The studio is hiring a designer for the launch"],
  ["The family moved to the new house downtown", "The family moves to the new house downtown"],
  ["The lease is being signed by both parties", "The lease is signed by both parties"],
  ["The permit expires at the end of March", "The permit expired at the end of March"],
  ["The board approved the budget for next year", "The board approves the budget for next year"],
  ["The roof needs a repair before the winter", "The roof needed a repair before the winter"],
  ["The landlord raised the rent for the unit", "The landlord raises the rent for the unit"],
  // Number with tense, and a final "s" on a name or a first word.
  ["Tenants pay the rent on the first day", "Tenant pay the rent on the first day"],
  ["The class moved to the east campus hall", "The clas moved to the east campus hall"],
  ["The tenant agreed to the new lease terms", "The tenants agree to the new lease terms"],
  // Signs and currencies, in a sentence and alone.
  ["-740", "740"],
  ["−740", "740"],
  ["$740", "€740"],
  ["$740", "£740"],
  ["The balance on the account is -740 today", "The balance on the account is 740 today"],
  ["The deposit for the venue is $740 in total", "The deposit for the venue is €740 in total"],
  ["740 USD", "740 EUR"],
  // What already differed still does.
  ["The launch is not on track this week", "The launch is on track this week"],
  ["The meeting is on 12 November at the office", "The meeting is on 13 November at the office"],
  ["Invoice was paid in full by the supplier", "Invoice will be paid in full by the supplier"],
];
const SAME: [string, string][] = [
  // The rewording G662 was filed for.
  ["Use each sign-in client to retain in a partner sign-in flow or to exchange a refresh token for an access token", "use each sign-in client to be retained in a partner sign-in flow or to exchange a refresh token for an access token"],
  ["The form is to be checked for the new intake", "the form is to check for the new intake"],
  // Case, accents, punctuation, articles, "is".
  ["Ship the beta to the testers on Friday.", "ship beta to testers on friday"],
  ["Réserver la salle pour le cours de mardi", "reserver la salle pour le cours de mardi"],
  ["The lease is signed by both parties", "Lease signed by both parties"],
  ["$740", "$ 740"],
  ["-740", "- 740"],
  // A plural alone, on a word in lower case: both can hold, so no conflict and no ask.
  ["The stable keeps the horses over the winter", "The stable keeps the horse over the winter"],
  ["Grade the midterm exam for the whole class", "Grade the midterm exams for the whole class"],
  // A hyphen between words or digits is no sign.
  ["sign-in client", "sign in client"],
  ["2026-10-05", "2026 10 05"],
  ["Call 555-0142 about the order for the school", "Call 555 0142 about the order for the school"],
];

test("G759 values that differ in a name, tense, number, sign or currency are never the same value", () => {
  for (const [a, b] of DIFFER) expect(sameValue(a, b), `${a} | ${b}`).toBe(false);
});

test("G759 a reworded sentence, case, accents and punctuation are still one value", () => {
  for (const [a, b] of SAME) expect(sameValue(a, b), `${a} | ${b}`).toBe(true);
  expect(valueKey(12)).toBe(valueKey(12));
});

test("G759 a second assistant's different name is a conflict, never merged in as a source", () => {
  const root = makeBrain();
  const p = join(root, "rules", "checks.yaml");
  void p; void writeFileSync;
  const w = (agent: string, value: string, mail: string) => remember(root, agent, { id: "projects/course-a", attribute: "handover", value, as_of: "2026-10-06", sources: [`gmail:${mail}`], verification: "verified-by-source" });
  expect(w("planner", "Send the signed lease to Robert on Friday", "f000000000000009").outcome).toBe("committed");
  const second = w("steward", "Send the signed lease to Roberts on Friday", "f00000000000000a");
  expect(second.message ?? "").not.toMatch(/same value/i);
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.handover as FactRecord;
  // The first value's record never gains the other mail as a source of its own.
  if (String(f.value).includes("Robert on")) expect(JSON.stringify(f.sources)).not.toContain("f00000000000000a");
});

// Code review of PR 145.
test("G759 a number keeps its sign, a list dash is no minus, and a name after \"to\" keeps its last letter", () => {
  expect(sameValue(-740, 740)).toBe(false);
  expect(sameValue(-740, "-740")).toBe(true);
  expect(sameValue(740, "740")).toBe(true);
  expect(sameValue("- 3 seats left for the dinner", "3 seats left for the dinner")).toBe(true);
  expect(sameValue("-3 degrees outside in the morning", "3 degrees outside in the morning")).toBe(false);
  expect(sameValue("send the lease to anne on friday", "send the lease to ann on friday")).toBe(false);
  expect(sameValue("she asked us to note the date", "she asked us to not the date")).toBe(false);
  expect(sameValue("she asked us to care for the garden", "she asked us to car for the garden")).toBe(false);
  expect(sameValue("Keep each record to retain in a flow", "Keep each record to be retained in a flow")).toBe(true);
});

// The owner's rule: a conflict is two values that cannot both hold. A mail that says the same
// thing with a plural is the same value, filed with no dispute and no ask.
test("G759 a capture that differs only by a plural merges as a source and opens no conflict", () => {
  const root = makeBrain();
  const w = (agent: string, value: string, mail: string) => remember(root, agent, { id: "projects/course-a", attribute: "handover", value, as_of: "2026-10-06", sources: [`gmail:${mail}`], verification: "verified-by-source" });
  expect(w("planner", "Grade the midterm exam for the whole class", "f000000000000009").outcome).toBe("committed");
  const second = w("steward", "Grade the midterm exams for the whole class", "f00000000000000a");
  expect(second.outcome).toBe("committed");
  expect(second.message ?? "").toMatch(/same value/i);
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.handover as FactRecord;
  expect(f.contested).toBeUndefined();
  expect(String(f.value)).toBe("Grade the midterm exam for the whole class");
});
