// SPDX-License-Identifier: AGPL-3.0-only
// G965: a next step is one of several things to do on a page. A different one that could not
// replace the one held used to ask the owner to pick; now it goes beside it, and nothing asks.
// What may replace still replaces; the same source item saying another step, money, health and
// legal, and a value another agent only relayed keep their old paths.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { ownerConflicts } from "../src/core";
import { loadBrain, isList, type Fact, type FactRecord } from "../src/brain";

const NOW = new Date("2026-10-08T15:00:00Z");
const page = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-b")!;
const open = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute" && ["open", "escalated"].includes(String(n.fm.status)));
const live = (f: Fact | undefined) => !f ? [] : isList(f) ? f.items.filter((i) => !i.valid_to && !i.retired).map((i) => String(i.value)) : "candidates" in (f as object) ? ["(in conflict)"] : [String((f as FactRecord).value)];
const read = (root: string, ...refs: string[]) => { const { recordCheckedRefs } = require("../src/louis"); recordCheckedRefs(root, Object.fromEntries(refs.map((r) => [r, true]))); };
const asks = (root: string) => ownerConflicts(root, NOW, { held: true }).length;

const OWNER = "Print the seating chart for the workshop";
const MAIL = "Return the room key to the front desk";
const EVENT = "Bring spare markers to the planning session";

const owner = (root: string, value: string, as_of = "2026-10-06", attribute = "next_step") => {
  const r = write(root, { agent: "owner", id: "projects/course-b", attribute, value, as_of, sources: [`owner:${as_of}/say`], verification: "confirmed-by-owner" } as never, { owner: true } as never);
  expect(r.outcome).toBe("committed");
};
const planner = (root: string, value: string, as_of: string, ref: string, verification = "self-reported", attribute = "next_step") =>
  write(root, { agent: "planner", id: "projects/course-b", attribute, value, as_of, sources: [ref], verification } as never);

test("G965: a different next step from a mail goes beside the owner's, and nothing asks", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000a1");
  owner(root, OWNER);
  const r = planner(root, MAIL, "2026-10-07", "gmail:f0000000000000a1", "verified-by-source");
  expect(r.outcome).toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toEqual([MAIL, OWNER]);
  expect(open(root)).toHaveLength(0);
  expect(asks(root)).toBe(0);
});

test("G965: a weaker, later word beside a checked mail's step is kept beside it, newest first", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000a2");
  expect(planner(root, MAIL, "2026-10-02", "gmail:f0000000000000a2", "verified-by-source").outcome).toBe("committed");
  expect(planner(root, EVENT, "2026-10-07", "gcal:evt-planning@cal.example").outcome).toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toEqual([EVENT, MAIL]);
  expect(asks(root)).toBe(0);
});

test("G965: a newer step from as strong a source still replaces the one it follows", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000a3", "gmail:f0000000000000a4");
  planner(root, MAIL, "2026-10-02", "gmail:f0000000000000a3", "verified-by-source");
  expect(planner(root, EVENT, "2026-10-07", "gmail:f0000000000000a4", "verified-by-source").outcome).toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toEqual([EVENT]);
});

test("G965: in a list, a newer step replaces the one it may follow and the owner's stays", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000a5", "gmail:f0000000000000a6");
  owner(root, OWNER);
  planner(root, MAIL, "2026-10-07", "gmail:f0000000000000a5", "verified-by-source");
  expect(planner(root, EVENT, "2026-10-08", "gmail:f0000000000000a6", "verified-by-source").outcome).toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toEqual([EVENT, OWNER]);
  expect(asks(root)).toBe(0);
});

test("G965: the owner's own typed next step stands alone, as before", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000a7");
  owner(root, OWNER);
  planner(root, MAIL, "2026-10-07", "gmail:f0000000000000a7", "verified-by-source");
  owner(root, "Order lunch for the review day", "2026-10-08");
  expect(live(page(root).fm.facts!.next_step)).toEqual(["Order lunch for the review day"]);
});

test("G965: an assistant's own word against the owner's stays history, in a list too", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000a8");
  owner(root, OWNER);
  expect(planner(root, EVENT, "2026-10-07", "agent:planner").outcome).toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toEqual([OWNER]);
  planner(root, MAIL, "2026-10-07", "gmail:f0000000000000a8", "verified-by-source");
  planner(root, "Water the plants in the lab", "2026-10-08", "agent:planner");
  expect(live(page(root).fm.facts!.next_step)).toEqual([MAIL, OWNER]);
  expect(asks(root)).toBe(0);
});

test("G965: what still asks: the same item saying another step, a money-shaped step, another kind of fact", () => {
  // The same mail giving a different step is that one step in doubt.
  let root = makeBrain();
  owner(root, OWNER);
  // The owner's word cites no item, so a second root: two words of one mail.
  root = makeBrain();
  read(root, "gmail:f0000000000000a9");
  planner(root, MAIL, "2026-10-07", "gmail:f0000000000000a9", "verified-by-source");
  expect(planner(root, EVENT, "2026-10-07", "gmail:f0000000000000a9", "verified-by-source").outcome).toBe("disputed");
  expect(asks(root)).toBe(1);
  // Money keeps asking (invariant 6).
  root = makeBrain();
  read(root, "gmail:f0000000000000b1");
  owner(root, OWNER);
  expect(planner(root, "Pay the invoice of $4,200 to the caterer", "2026-10-07", "gmail:f0000000000000b1", "verified-by-source").outcome).not.toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toEqual([OWNER]);
  // A one-value fact is untouched by the rule.
  root = makeBrain();
  read(root, "gmail:f0000000000000b2");
  owner(root, "Room 4 on the second floor", "2026-10-06", "location");
  expect(planner(root, "The annex behind the library", "2026-10-07", "gmail:f0000000000000b2", "verified-by-source", "location").outcome).toBe("disputed");
});

test("G965: a step another agent only relayed still waits in the inbox", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000b5");
  planner(root, EVENT, "2026-10-02", "gmail:f0000000000000b5", "verified-by-source");
  expect(planner(root, MAIL, "2026-10-07", "agent-relay:helper/m1").outcome).toBe("inbox");
  expect(live(page(root).fm.facts!.next_step)).toEqual([EVENT]);
  // In a list too.
  planner(root, "Collect the name badges from the print shop", "2026-10-07", "gcal:evt-badges@cal.example");
  expect(live(page(root).fm.facts!.next_step)).toHaveLength(2);
  expect(planner(root, MAIL, "2026-10-08", "agent-relay:helper/m2").outcome).toBe("inbox");
  expect(live(page(root).fm.facts!.next_step)).toHaveLength(2);
});

test("G965: the night pass closes an old pick-one question on two next steps as both kept, with Undo", () => {
  const { upkeep } = require("../src/upkeep");
  const { readDiary } = require("../src/diary");
  const { undoFact } = require("../src/undo");
  const { saveNote } = require("../src/brain");
  const { commitPaths } = require("../src/git");
  const root = makeBrain();
  read(root, "gmail:f0000000000000b3");
  planner(root, MAIL, "2026-10-02", "gmail:f0000000000000b3", "verified-by-source");
  planner(root, EVENT, "2026-10-07", "gcal:evt-planning@cal.example");
  // As a hub before this rule left it: the live step with a conflict packet beside it.
  const p = page(root);
  const items = (p.fm.facts!.next_step as { items: FactRecord[] }).items;
  const mail = items.find((i) => i.value === MAIL)!, event = items.find((i) => i.value === EVENT)!;
  p.fm.facts!.next_step = { ...mail, contested: "c-0001" } as never;
  saveNote(root, p);
  saveNote(root, { path: "disputes/c-0001.md", body: "Two next steps.\n", fm: { id: "disputes/c-0001", type: "dispute", title: "projects/course-b#next_step", area: "work", sensitivity: "personal", status: "open", created: "2026-10-07", updated: "2026-10-07", by: "planner", fact_key: "projects/course-b#next_step", step: 6, candidates: [mail, event] } } as never);
  expect(commitPaths(root, ["projects/course-b.md", "disputes/c-0001.md"], "an old conflict", "louis")).toBeFalsy();
  expect(asks(root)).toBe(1);
  const r = upkeep(root, { now: "2026-10-08" });
  expect(r.findings.filter((x: { rule: string }) => x.rule === "both-dates-closed").map((x: { key: string }) => x.key)).toEqual(["projects/course-b#next_step"]);
  expect(asks(root)).toBe(0);
  expect(live(page(root).fm.facts!.next_step)).toEqual([EVENT, MAIL]);
  const row = readDiary(root).find((x: { why?: string }) => x.why === "both-steps")!;
  expect(row.to).toBe(EVENT);
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(live(page(root).fm.facts!.next_step)).toEqual([MAIL]);
});

test("G965: a waiting proposal of another next step is no pick-one question on the home", () => {
  const { inboxConflicts } = require("../src/settle-inbox");
  const { mkdirSync, writeFileSync } = require("node:fs");
  const { join } = require("node:path");
  const YAML = require("yaml");
  const root = makeBrain();
  owner(root, OWNER);
  owner(root, "Room 4 on the second floor", "2026-10-06", "location");
  mkdirSync(join(root, "inbox"), { recursive: true });
  const card = (n: string, attribute: string, value: string) => writeFileSync(join(root, "inbox", `2026-10-07-planner-${n}.yaml`), YAML.stringify({ proposed: "2026-10-07", by: "planner", reason: "held", checks: [], request: { agent: "planner", id: "projects/course-b", attribute, value, as_of: "2026-10-07", sources: ["gmail:f0000000000000b4"], verification: "self-reported" } }));
  card("s1", "next_step", MAIL);
  card("s2", "location", "The annex behind the library");
  expect(inboxConflicts(root).map((c: { attr: string }) => c.attr)).toEqual(["location"]);
});

test("G965: the same words about another day is one step in doubt, so it still asks", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000c1", "gmail:f0000000000000c2");
  planner(root, "Hand in the venue form on 14 October", "2026-10-07", "gmail:f0000000000000c1", "verified-by-source");
  expect(planner(root, "Hand in the venue form on 21 October", "2026-10-07", "gmail:f0000000000000c2", "verified-by-source").outcome).toBe("disputed");
  expect(asks(root)).toBe(1);
});

// Code review of PR 224: a day written as 2026-10-14 is a day too, and a newer step never ends an
// item an open question is about.
test("G965: the same words about another day written in digits still asks", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000c3", "gmail:f0000000000000c4");
  planner(root, "Collect the badge order by 2026-10-14", "2026-10-07", "gmail:f0000000000000c3", "verified-by-source");
  expect(planner(root, "Collect the badge order by 2026-10-21", "2026-10-07", "gmail:f0000000000000c4", "verified-by-source").outcome).toBe("disputed");
  expect(asks(root)).toBe(1);
});

test("G965: a newer step leaves the item an open question is about, and goes beside it", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000a9", "gmail:f0000000000000d1");
  owner(root, OWNER);
  planner(root, MAIL, "2026-10-07", "gmail:f0000000000000a9", "verified-by-source");
  expect(planner(root, EVENT, "2026-10-07", "gmail:f0000000000000a9", "verified-by-source").outcome).toBe("disputed");
  expect(planner(root, "Water the lobby plants before the tour", "2026-10-08", "gmail:f0000000000000d1", "verified-by-source").outcome).toBe("committed");
  expect(live(page(root).fm.facts!.next_step)).toContain(MAIL);
  expect(live(page(root).fm.facts!.next_step)).toHaveLength(3);
  expect(asks(root)).toBe(1);
});

// Slice audit of this branch (G972): 200 different steps all went live on one page.
test("G972: a page holds at most STEPS_MAX next steps from assistants; a further one waits as a proposal", () => {
  const { STEPS_MAX } = require("../src/write");
  const root = makeBrain();
  const things = ["chairs", "cables", "badges", "posters", "folders", "lamps", "kettles", "ladders", "pencils", "tablecloths", "clipboards", "speakers", "easels", "banners"];
  const out = things.map((t, i) => planner(root, `Count the ${t} in the store room`, "2026-10-07", `gcal:evt-count-${i}@cal.example`).outcome);
  expect(out.slice(0, STEPS_MAX).every((o) => o === "committed")).toBe(true);
  expect(out.slice(STEPS_MAX)).toEqual(["inbox", "inbox"]);
  expect(live(page(root).fm.facts!.next_step)).toHaveLength(STEPS_MAX);
  expect(asks(root)).toBe(0);
  // The owner's own typed step is never capped.
  owner(root, "Lock the store room", "2026-10-08");
  expect(live(page(root).fm.facts!.next_step)).toEqual(["Lock the store room"]);
});

// Slice audit (G973): a writer outside its areas (contest) no longer has its different step held
// for the Gardener; it sits beside, by the owner's yes. It still never ends or edits what is there.
test("G973: an outside-area writer's different step sits beside and changes no item already there", () => {
  const root = makeBrain();
  read(root, "gmail:f0000000000000d1");
  planner(root, MAIL, "2026-10-07", "gmail:f0000000000000d1", "verified-by-source");
  const before = JSON.stringify(page(root).fm.facts!.next_step);
  const r = write(root, { agent: "planner", id: "projects/course-b", attribute: "next_step", value: EVENT, as_of: "2026-10-02", sources: ["gcal:evt-planning@cal.example"], verification: "self-reported" } as never, { contest: true });
  expect(r.outcome).toBe("committed");
  const items = (page(root).fm.facts!.next_step as { items: FactRecord[] }).items;
  expect(JSON.stringify(items.find((i) => i.value === MAIL))).toBe(before);
  expect(live(page(root).fm.facts!.next_step)).toEqual([MAIL, EVENT]);
});
