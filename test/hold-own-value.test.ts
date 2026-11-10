// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13, 2026-11-09 (G758; a regression from the write hold, G680): an assistant's own money-,
// health- or legal-shaped value is saved held for the owner's eyes, hidden from every carve, its
// writer's included. Saying the same value again then tripped the leak wire ("a value planner was
// never shown"): the owner got a leak alert for an ordinary re-confirmation, and the assistant was
// put on proposals only. A value the writer itself wrote is no leak: the wire leaves it out, and a
// value someone else holds hidden still trips it.
import { test, expect } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { remember } from "../src/core";
import { readJsonl } from "../src/util";
import { git } from "../src/git";
import { loadBrain, type FactRecord } from "../src/brain";
import { writesHeld } from "../src/write-hold";

const alerts = (root: string) => existsSync(join(root, "log/alerts.jsonl")) ? readJsonl<{ check?: string }>(join(root, "log/alerts.jsonl")).filter((a) => a.check === "leak_tripwire").length : 0;
const rec = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)!.fm.facts![attr] as FactRecord;
const fee = (value: string, as_of = "2026-10-05") => ({ id: "projects/course-a", attribute: "fee", value, as_of, sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
const plain = { id: "projects/course-a", attribute: "room", value: "Hall C", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" };

for (const agent of ["planner", "steward"]) {
  test(`G758 ${agent} saying its own held value again is no leak, and it keeps writing`, () => {
    const root = makeBrain();
    const before = alerts(root);
    const first = remember(root, agent, fee("the invoice is 4,250 dollars to Larchmont Catering"));
    expect(first.outcome).toBe("committed");
    expect(rec(root, "projects/course-a", "fee").unseen).toBe(true);
    // The same write again, and the same value at a later date.
    const again = remember(root, agent, fee("the invoice is 4,250 dollars to Larchmont Catering"));
    expect(again.fails?.map((f) => f.check) ?? []).not.toContain("leak_tripwire");
    expect(again.outcome).not.toBe("refused");
    const later = remember(root, agent, fee("the invoice is 4,250 dollars to Larchmont Catering", "2026-10-07"));
    expect(later.outcome).toBe("committed");
    // It may change its own held value too.
    expect(remember(root, agent, fee("the invoice is 4,400 dollars to Larchmont Catering", "2026-10-08")).outcome).toBe("committed");
    expect(alerts(root)).toBe(before);
    expect(writesHeld(root, agent)).toBe(false);
    expect(remember(root, agent, plain).outcome).toBe("committed");
    // Still held for the owner: no assistant is served it.
    expect(rec(root, "projects/course-a", "fee").unseen).toBe(true);
  });
}

test("G758 its own held value said on another page is no leak either", () => {
  const root = makeBrain();
  expect(remember(root, "planner", fee("the invoice is 4,250 dollars to Larchmont Catering")).outcome).toBe("committed");
  const r = remember(root, "planner", { id: "projects/course-a", attribute: "caterer_note", value: "the invoice is 4,250 dollars to Larchmont Catering", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(r.fails?.map((f) => f.check) ?? []).not.toContain("leak_tripwire");
  expect(writesHeld(root, "planner")).toBe(false);
});

test("G758 a held value another assistant wrote still trips the wire, once", () => {
  const root = makeBrain();
  expect(remember(root, "steward", fee("the invoice is 4,250 dollars to Larchmont Catering")).outcome).toBe("committed");
  const before = alerts(root);
  const r = remember(root, "planner", { id: "projects/course-a", attribute: "caterer_note", value: "the invoice is 4,250 dollars to Larchmont Catering", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(r.outcome).toBe("refused");
  expect(r.fails?.[0]?.check).toBe("leak_tripwire");
  expect(alerts(root)).toBe(before + 1);
  expect(writesHeld(root, "planner")).toBe(true);
});

test("G758 a value the writer wrote that the owner then keeps private is not the writer's to say again", () => {
  const root = makeBrain();
  expect(remember(root, "planner", fee("the invoice is 4,250 dollars to Larchmont Catering")).outcome).toBe("committed");
  // The owner makes the page's fact private by hand and opens it: no longer held, now carved by level.
  const f = join(root, "projects", "course-a.md");
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  const r = n.fm.facts!.fee as FactRecord;
  delete r.unseen; r.sensitivity = "secret"; r.verification = "confirmed-by-owner";
  const { saveNote } = require("../src/brain");
  saveNote(root, n);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner: keep the fee to myself"]);
  expect(existsSync(f)).toBe(true);
  const again = remember(root, "planner", { id: "projects/course-a", attribute: "caterer_note", value: "the invoice is 4,250 dollars to Larchmont Catering", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(again.outcome).toBe("refused");
});

// Slice audit of G758 (2026-11-09): the exemption is for a value, never a title. A new page's id
// is built from its title and reaches every reader, so the writer's own held value as a title is
// refused as any carved value in a title is, and no page is made.
test("G758 a writer's own held value is still refused as a new page's title", () => {
  const root = makeBrain();
  expect(remember(root, "planner", fee("the invoice is 4,250 dollars to Larchmont Catering")).outcome).toBe("committed");
  const r = remember(root, "planner", { type: "project", title: "the invoice is 4,250 dollars to Larchmont Catering", area: "work", attribute: "next_step", value: "Book the hall", as_of: "2026-10-06", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(r.outcome).toBe("refused");
  expect(r.fails?.map((f) => f.check)).toEqual(["leak_tripwire"]);
  expect(loadBrain(root).some((n) => /larchmont/i.test(`${n.fm.id} ${n.fm.title}`))).toBe(false);
});
