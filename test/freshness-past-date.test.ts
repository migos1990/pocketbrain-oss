// SPDX-License-Identifier: AGPL-3.0-only
// A plan whose date has passed reads stale, not current (docs/prove-the-loop.md#stale-answers).
import { describe, expect, test } from "bun:test";
import { factFreshness, pastDate } from "../src/freshness";
import { attributeSpec, type Rules } from "../src/rules";

const rules = { checks: { checks: [], types: { project: { attributes: { next_step: { merge: "replace", shelf_life: "14d" } } } } } } as unknown as Rules;
const step = (value: string, as_of = "2026-10-10") => ({ value, as_of, sources: ["agent:claude"] }) as any;
const spec = (a: string) => attributeSpec(rules, "project", a);

describe("past dates", () => {
  test("reads ISO, English and French dates, latest wins", () => {
    expect(pastDate("Submit by 2026-10-15", "2026-10-10", "2026-10-22")).toBe(true);
    expect(pastDate("Submit by 2026-10-15", "2026-10-10", "2026-10-15")).toBe(false);
    expect(pastDate("Grade the midterm by Oct 14", "2026-10-01", "2026-10-22")).toBe(true);
    expect(pastDate("Remise le 14 octobre 2026", "2026-10-01", "2026-10-22")).toBe(true);
    expect(pastDate("Draft by 2026-10-01, final by 2026-11-30", "2026-09-20", "2026-10-22")).toBe(false);
    expect(pastDate("Call Jane next week", "2026-10-01", "2026-10-22")).toBe(false);
    // a yearless date earlier than when it was written is next year's
    expect(pastDate("Renew by Jan 5", "2026-10-01", "2026-10-22")).toBe(false);
    // ...but one just before it was written is that year's, already past
    expect(pastDate("Grade by Oct 5", "2026-10-06", "2026-10-08")).toBe(true);
  });
  test("a next step past its date is stale even when written yesterday", () => {
    expect(factFreshness(step("Exam on 2026-10-15", "2026-10-21"), spec("next_step"), "2026-10-22")).toBe("stale");
    expect(factFreshness(step("Exam on 2026-10-29", "2026-10-21"), spec("next_step"), "2026-10-22")).toBe("current");
  });
  test("a due date that passed is stale; attributes without an end date ignore dates", () => {
    expect(factFreshness(step("2026-10-01"), spec("due"), "2026-10-22")).toBe("stale");
    expect(factFreshness(step("Started on 2026-01-05", "2026-10-20"), spec("role"), "2026-10-22")).toBe("current");
  });
  test("shelf_life until_date opts any attribute in", () => {
    const s = { merge: "set", shelf_life: "until_date" } as any;
    expect(factFreshness(step("Moved to 2026-10-03"), s, "2026-10-22")).toBe("stale");
  });
});
