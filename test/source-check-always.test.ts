// SPDX-License-Identifier: AGPL-3.0-only
// The cited-message check is always on (outside review 2026-10-25): before, it ran only when
// log/refs-checked.jsonl existed, which only a hand command made, so on the real brain a made-up
// Gmail id labelled verified-by-source replaced a live fact. Now a mail or calendar ref the hub
// never read can't replace a value until it has read it, and the hub records what it reads.
import { test, expect } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain } from "../src/brain";
import { checkedRefs } from "../src/louis";
import { fetchOne } from "../src/pull";

const fake = { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Cancel the course", as_of: "2026-10-07", sources: ["gmail:feedfacefeedface"], verification: "verified-by-source" as const };
const live = (root: string) => JSON.stringify(loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step);

test("with no checked-refs file, an invented mail id can't replace a live fact", () => {
  const root = makeBrain();
  rmSync(join(root, "log/refs-checked.jsonl"));
  const r = write(root, fake);
  expect(r.outcome).not.toBe("committed");
  expect(r.fails?.map((f) => f.check)).toContain("source_exists");
  expect(live(root)).toContain("Grade the midterm");
  expect(live(root)).not.toContain("Cancel the course");
});

test("checkedRefs is a map even with no file: nothing checked yet", () => {
  const root = makeBrain();
  rmSync(join(root, "log/refs-checked.jsonl"));
  expect(checkedRefs(root)).toBeInstanceOf(Map);
  expect(checkedRefs(root).size).toBe(0);
});

test("a ref the hub read goes through; one it found missing is refused", async () => {
  const root = makeBrain();
  rmSync(join(root, "log/refs-checked.jsonl"));
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  mail:\n    kind: gmail\n    fixture: fx.json\n");
  writeFileSync(join(root, "fx.json"), JSON.stringify([{ id: "abcabcabcabcabca", threadId: "t", internalDate: String(Date.parse("2026-10-07")), payload: { headers: [{ name: "Subject", value: "x" }] }, labelIds: ["INBOX"], text: "Next step: book room 12" }]));
  expect(typeof (await fetchOne(root, "gmail:abcabcabcabcabca"))).toBe("object");
  expect(typeof (await fetchOne(root, "gmail:0000000000000bad"))).toBe("string");
  const seen = checkedRefs(root);
  expect(seen.get("gmail:abcabcabcabcabca")).toBe(true);
  expect(seen.get("gmail:0000000000000bad")).toBe(false);
  expect(write(root, { ...fake, value: "Book room 12", sources: ["gmail:abcabcabcabcabca"] }).outcome).toBe("committed");
  expect(write(root, { ...fake, value: "Book room 13", sources: ["gmail:0000000000000bad"] }).outcome).toBe("refused");
  expect(readFileSync(join(root, "log/refs-checked.jsonl"), "utf8")).not.toContain("room");
});

// "Fresh" meant repeated, not checked: any same-value write moved last_confirmed (outside review).
// Now only a write that brings new evidence does; repeating what is already cited doesn't.
test("an assistant repeating a value in its own word leaves last_confirmed alone", () => {
  const root = makeBrain();
  const rec = () => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as { last_confirmed?: string; sources: unknown[] };
  const before = rec().last_confirmed;
  const same = { id: "projects/course-a", attribute: "next_step", value: "Grade the midterm", as_of: "2026-10-01" };
  expect(write(root, { ...same, agent: "planner", sources: ["agent:planner"], verification: "self-reported" }).outcome).toBe("committed");
  expect(rec().last_confirmed).toBe(before);
  // New evidence the hub read does move it.
  expect(write(root, { ...same, agent: "planner", sources: ["gmail:f00000000000000a"], verification: "verified-by-source" }).outcome).toBe("committed");
  expect(rec().last_confirmed).toBeDefined();
  expect(rec().last_confirmed).not.toBe(before);
});

// Slice audit 2026-10-25: the check recorded the ref as the caller wrote it, and the version after
// @ was ignored when reading, so any made-up version of a real event came back "read".
test("a calendar ref with a made-up version is not recorded as read", async () => {
  const root = makeBrain();
  rmSync(join(root, "log/refs-checked.jsonl"));
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  cal:\n    kind: gcal\n    fixture: c.json\n");
  writeFileSync(join(root, "c.json"), JSON.stringify([{ id: "evt1", etag: '"e1"', summary: "x", start: { dateTime: "2026-10-20T10:00:00Z" }, description: "Book room 12", updated: "2026-10-07T00:00:00Z", calendar: "primary" }]));
  const it = await fetchOne(root, "gcal:evt1@forged");
  expect(typeof it).toBe("object");
  const real = `gcal:evt1@${(it as { version: string }).version}`;
  expect(real).not.toBe("gcal:evt1@forged");
  await fetchOne(root, real);
  const seen = checkedRefs(root);
  expect(seen.get("gcal:evt1@forged")).not.toBe(true);
  expect(seen.get(real)).toBe(true);
  expect(write(root, { ...fake, value: "Book room 12", sources: ["gcal:evt1@forged"] }).outcome).not.toBe("committed");
});

// G418 covered only refs the hub can check: an invented chat ref still made a fact look fresh.
test("a same-value write citing a ref the hub never read leaves last_confirmed alone", () => {
  const root = makeBrain();
  const rec = () => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as { last_confirmed?: string };
  const before = rec().last_confirmed;
  const same = { id: "projects/course-a", attribute: "next_step", value: "Grade the midterm", as_of: "2026-10-01", agent: "planner", verification: "verified-by-source" as const };
  write(root, { ...same, sources: ["slack:C0FAKE/1700000000.000100"] });
  expect(rec().last_confirmed).toBe(before);
  write(root, { ...same, sources: ["gmail:0000000000000bad"] });
  expect(rec().last_confirmed).toBe(before);
});

test("a pull records what it read, so its own facts pass the check", async () => {
  const root = makeBrain();
  rmSync(join(root, "log/refs-checked.jsonl"));
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  cal:\n    kind: gcal\n    fixture: c.json\n");
  writeFileSync(join(root, "c.json"), JSON.stringify([{ id: "evt2", etag: '"e2"', summary: "x", start: { dateTime: "2026-10-20T10:00:00Z" }, description: "Book room 14", updated: "2026-10-07T00:00:00Z", calendar: "primary" }]));
  const { pullSource } = await import("../src/pull");
  const { makeModel } = await import("../src/model");
  await pullSource(root, "cal", { model: makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [] }) }) });
  const read = [...checkedRefs(root)].filter(([r, ok]) => r.startsWith("gcal:evt2@") && ok);
  expect(read.length).toBe(1);
});

// Slice audit 2026-10-25 (second pass): a vague owner-looking ref (imsg:<range>, louis:<words>)
// is never checked against the owner's registry, so it made a repeated value look fresh.
test("an owner-looking ref that isn't a registered owner message leaves last_confirmed alone", () => {
  const root = makeBrain();
  const rec = () => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as { last_confirmed?: string };
  const before = rec().last_confirmed;
  const same = { id: "projects/course-a", attribute: "next_step", value: "Grade the midterm", as_of: "2026-10-01", agent: "planner", verification: "self-reported" as const };
  for (const ref of ["imsg:2026-10-01..2026-10-02", "louis:said-so"]) {
    write(root, { ...same, sources: [ref] });
    expect(rec().last_confirmed).toBe(before);
  }
});
