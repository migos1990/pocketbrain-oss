// SPDX-License-Identifier: AGPL-3.0-only
// The extraction prompt asks for dates as YYYY-MM-DD, so "next week" or "on Tuesday" never appear
// in the text as written: whole-word grounding (G36) dropped every relative date. A relative word
// now grounds a date within a year of today, and "50 000" grounds 50000. The G36 refusals stay.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { checkCandidate } from "../src/capture";
import { loadRules } from "../src/rules";
import { loadBrain } from "../src/brain";

const root = makeBrain();
const rules = loadRules(root), notes = loadBrain(root);
const status = (text: string, value: string, quote: string) =>
  checkCandidate({ entity: "Course A", type: "project", attribute: "next_step", value, quote }, text, notes, rules).status;

test("a relative date in the text grounds a near date, never a far one", () => {
  expect(status("Course A exam moved to next week.", "2026-10-15", "exam moved to next week")).not.toBe("ungrounded");
  expect(status("Course A : examen reporté à mardi prochain.", "2026-10-13", "examen reporté à mardi prochain")).not.toBe("ungrounded");
  expect(status("Course A exam moved to next week.", "2031-12-25", "exam moved to next week")).toBe("ungrounded");
  expect(status("Course A exam moved.", "2026-10-15", "exam moved")).toBe("ungrounded");
});

test("numbers written with thousands separators ground the bare number, and only that number", () => {
  expect(status("Course A budget: 50 000 $.", "budget 50000", "budget: 50 000")).not.toBe("ungrounded");
  expect(status("Course A: the lab budget is $50,000 this year.", "budget 50000", "The lab budget is")).not.toBe("ungrounded");
  expect(status("Course A: the lab budget is $50,000 this year.", "budget 5000", "The lab budget is")).toBe("ungrounded");
});
