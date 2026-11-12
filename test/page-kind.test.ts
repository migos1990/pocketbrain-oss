// SPDX-License-Identifier: AGPL-3.0-only
// Owner's phone, 2026-11-12, his Memory page: "Your personal projects include Cogeco … survey
// contest, … Flight to Montréal (AC 7978), Flight to Montreal (TS 739), … appointment at … |
// Rockland", while a trip page already said "out Dec 12, back Jan 2". A mail or calendar item's
// title had become a project. Now (G787, src/page-kind.ts): a flight, stay or booking is part of
// the trip whose dates hold it; an appointment, a game or a provider's mail starts no project or
// decision page; the owner's page lists none of them as his projects; and an area reads as its org
// writes it ("Your NCA projects"). Every name below is made up.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, type Note } from "../src/brain";
import { loadRules } from "../src/rules";
import { upkeep, undoRun } from "../src/upkeep";
import { renderTouchedPages, areaWord } from "../src/wiki";
import { checkCandidate } from "../src/capture";
import { titlePiece, datesIn, tripPlan } from "../src/page-kind";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@x`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@x` });
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root, env: env("steward") }); Bun.spawnSync(["git", "commit", "-qm", "steward: pages"], { cwd: root, env: env("steward") }); };
const fact = (attr: string, value: string, ref = "gcal:f0000000000001") => `  ${attr}: { value: ${JSON.stringify(value)}, as_of: 2026-10-05, sources: ["${ref}"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }\n`;
function page(root: string, id: string, title: string, o: { type?: string; facts?: string; body?: string; area?: string; sensitivity?: string; extra?: string } = {}) {
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: ${o.type ?? "project"}\ntitle: ${JSON.stringify(title)}\narea: ${o.area ?? "personal"}\nsensitivity: ${o.sensitivity ?? "personal"}\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\n${o.extra ?? ""}${o.facts ? `facts:\n${o.facts}` : ""}---\n${o.body ?? ""}`);
}
const parentOf = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!.fm.parent;

test("G787 a title says what it is: flights and stays, one-off events, a provider's mail; projects and trips are none of them", () => {
  for (const t of ["Montreal to Halifax (XY 7978)", "Flight to Halifax (XY 7978)", "Flight to Montréal (QX 739)", "Vol vers Lyon", "Airbnb reservation, Cap Rouge", "Cabin: Moss family check-in (Oct 12, 2026)", "2026-11-23 Room booking QZ88"])
    expect([t, titlePiece(t)]).toEqual([t, "travel"]);
  for (const t of ["Dana Ruiz appointment at Physio Plus | Lakeview", "Cup final - Under 18 | Owls vs Hawks", "Rendez-vous chez le dentiste", "Book launch (Nov 3, 2026)"])
    expect([t, titlePiece(t)]).toEqual([t, "event"]);
  for (const t of ["Northwind Internet Inc. survey contest", "Concours Northwind", "Your order #4412 has shipped", "Avis de renouvellement"])
    expect([t, titlePiece(t)]).toEqual([t, "errand"]);
  for (const t of ["Kitchen renovation", "Customer engagement strategy", "Final projects", "Choir winter concert", "Order the cedar boards", "Course B, Fall 2026", "Island family trip, December 2026", "Coast trip (Oct 5, 2026)", "Muse Connector Platform", "Volunteer board role", "Ship billing into Q4 2026", "Move the launch to Q4 2026", "Photo shoot for the V2 site", "Involve the A1 team"])
    expect([t, titlePiece(t)]).toEqual([t, undefined]);
});

test("G787 dates without a year run on past New Year: out Dec 12, back Jan 2", () => {
  const d = (s: string) => datesIn(s, 2026).map((x) => new Date(x.from).toISOString().slice(0, 10));
  expect(d("Island family trip, December 2026. Out Sat Dec 12, back Jan 2.")).toEqual(["2026-12-01", "2026-12-12", "2027-01-02"]);
  expect(d("le 12 décembre 2026, retour 2 janvier")).toEqual(["2026-12-12", "2027-01-02"]);
  expect(d("due 2026-12-12")).toEqual(["2026-12-12"]);
  expect(d("no date here, room 12")).toEqual([]);
  // Given the page's own day, a date with no year is the nearest one.
  expect(datesIn("board on Jan 2", "2026-10-01").map((x) => new Date(x.from).toISOString().slice(0, 10))).toEqual(["2027-01-02"]);
});

function tripBrain(extraPolicy = "") {
  const root = makeBrain();
  if (extraPolicy) { const p = join(root, "rules", "policy.yaml"); writeFileSync(p, readFileSync(p, "utf8") + extraPolicy); }
  page(root, "projects/island-trip", "Island family trip, December 2026", { body: "Out Sat Dec 12, back Jan 2, nonstop, family of three.\n" });
  page(root, "projects/flight-out", "Flight to Pointe Bleue (QX 738)", { facts: fact("due", "2026-12-12") });
  page(root, "projects/flight-back", "Flight to Montreal (QX 739)", { facts: fact("next_step", "board at 14:10 on Jan 2") }); // no year: next January
  page(root, "projects/stay", "Airbnb reservation, Anse Verte", { facts: fact("next_step", "check in Dec 13 after 4 pm", "gmail:f0000000000002") });
  page(root, "projects/flight-oct", "Flight to Halifax (XY 100)", { facts: fact("due", "2026-10-20") }); // no trip holds it
  page(root, "projects/flight-nodate", "Flight to Halifax (XY 101)"); // says no day
  commit(root);
  return root;
}

test("G787 a flight or stay inside a trip's dates goes under the trip each night, on from the first run, and Undo takes it back", () => {
  const root = tripBrain();
  const r = upkeep(root, { now: "2026-11-12" });
  for (const id of ["projects/flight-out", "projects/flight-back", "projects/stay"]) expect([id, parentOf(root, id)]).toEqual([id, "projects/island-trip"]);
  expect(parentOf(root, "projects/flight-oct")).toBeUndefined();
  expect(parentOf(root, "projects/flight-nodate")).toBeUndefined();
  const f = r.findings.filter((x) => x.rule === "trip-part");
  expect(f).toHaveLength(3);
  for (const x of f) expect(x.detail).not.toMatch(/Island|Flight|QX/);
  expect(undoRun(root, r.run)).not.toMatch(/conflict|no auto-fix/);
  expect(parentOf(root, "projects/stay")).toBeUndefined();
});

test("G787 off (`wiki trips off`): a count under no page's id, nothing set", () => {
  const root = tripBrain("trips: false\n");
  const r = upkeep(root, { now: "2026-11-12" });
  expect(parentOf(root, "projects/flight-out")).toBeUndefined();
  const f = r.findings.find((x) => x.rule === "trip-would-set")!;
  expect(f.key).toBe("trip-would-set");
  expect(f.detail).toContain("3 flight or booking pages are part of a trip");
});

test("G787 two trips that both hold the day, a piece the owner spoke for, or a trip a reader of the piece can't see: nothing set", () => {
  const root = makeBrain();
  page(root, "projects/trip-a", "Ski trip, February 2027");
  page(root, "projects/trip-b", "Work travel, February 2027");
  page(root, "projects/flight", "Flight to Denver (XY 5)", { facts: fact("due", "2027-02-10") });
  page(root, "projects/trip-c", "Coast trip, March 2027");
  page(root, "projects/flight-owner", "Flight to Coast (XY 6)", { facts: `  due: { value: "2027-03-02", as_of: 2026-10-05, sources: ["owner:2026-10-05/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-05 }\n` });
  commit(root);
  const notes = loadBrain(root);
  expect(tripPlan(notes, () => false)).toEqual([]);
  // A reader of the flight that can't see the trip: no parent the reader would learn of.
  page(root, "projects/trip-d", "Lake trip, April 2027");
  page(root, "projects/flight-d", "Flight to Lake (XY 7)", { facts: fact("due", "2027-04-03") });
  commit(root);
  const all = loadBrain(root);
  expect(tripPlan(all, () => false).map((p) => p.id)).toEqual(["projects/flight-d"]);
  expect(tripPlan(all, () => false, (child, parent) => parent !== "projects/trip-d")).toEqual([]);
  // A fact hidden from some reader of the page never dates it.
  expect(tripPlan(all, (k) => k === "projects/flight-d#due")).toEqual([]);
});

test("G787 a provider's mail, an appointment or a booking starts no project or decision page; a flight may, for its trip", () => {
  const root = makeBrain();
  const rules = loadRules(root);
  const notes = loadBrain(root);
  const text = "Northwind Internet Inc. survey contest: answer by 2026-11-30 to win. Your appointment at Physio Plus | Lakeview is on 2026-11-20. Room booking QZ88 confirmed for 2026-11-23. Flight to Halifax (XY 7978) departs 2026-12-12.";
  const c = (type: string, entity: string, attribute: string, value: string, quote: string) => checkCandidate({ entity, type, attribute, value, quote }, text, notes, rules);
  const survey = c("project", "Northwind Internet Inc. survey contest", "next_step", "answer by 2026-11-30", "answer by 2026-11-30 to win");
  expect(survey.status).toBe("unsupported");
  expect(survey.why).toContain("a provider's mail is not a project of yours");
  expect(c("project", "Appointment at Physio Plus | Lakeview", "next_step", "2026-11-20", "is on 2026-11-20").status).toBe("unsupported");
  const booking = c("decision", "2026-11-23 Room booking QZ88", "outcome", "confirmed", "Room booking QZ88 confirmed");
  expect(booking.status).toBe("unsupported");
  expect(booking.why).toContain("a flight, stay or booking is not a decision of yours");
  expect(c("project", "Flight to Halifax (XY 7978)", "next_step", "departs 2026-12-12", "departs 2026-12-12").status).toBe("new-note");
  expect(c("project", "Kitchen renovation", "next_step", "departs 2026-12-12", "departs 2026-12-12").status).toBe("new-note");
});

function ownerBrain() {
  const root = makeBrain();
  mkdirSync(join(root, "orgs"), { recursive: true });
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  page(root, "people/robin-vale", "Robin Vale", { type: "person", facts: fact("city", "Halifax", "gmail:f000000000000009") });
  page(root, "projects/island-trip", "Island family trip, December 2026", { facts: fact("next_step", "pack", "gmail:f000000000000010"), body: "Out Dec 12, back Jan 2.\n" });
  page(root, "projects/flight-out", "Flight to Pointe Bleue (QX 738)", { facts: fact("due", "2026-12-12") });
  page(root, "projects/survey", "Northwind Internet Inc. survey contest", { facts: fact("next_step", "answer the survey", "gmail:f000000000000011") });
  page(root, "projects/physio", "Dana Ruiz appointment at Physio Plus | Lakeview", { facts: fact("next_step", "bring the referral", "gmail:f000000000000012") });
  page(root, "projects/game", "Cup final | Owls vs Hawks", { facts: fact("next_step", "buy tickets", "gmail:f000000000000013") });
  page(root, "projects/shed", "Garden shed", { facts: fact("next_step", "order the cedar boards", "gmail:f000000000000014") });
  // His own word on it: what he says it is, whatever its title.
  page(root, "projects/kept", "Tasting webinar series", { facts: `  next_step: { value: "book the room", as_of: 2026-10-05, sources: ["owner:2026-10-05/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-05 }\n` });
  page(root, "orgs/north-college", "NCL North College Lakeside", { type: "org", area: "ncl", facts: fact("city", "Halifax", "gmail:f000000000000015") });
  page(root, "projects/course", "Course B", { area: "ncl", facts: fact("status", "planning", "gmail:f000000000000016") });
  page(root, "orgs/option-verte", "Option Verte", { type: "org", area: "ov", facts: fact("city", "Halifax", "gmail:f000000000000017") });
  page(root, "projects/board", "Option Verte board role", { area: "ov", facts: fact("status", "active", "gmail:f000000000000018") });
  commit(root);
  return root;
}
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();

test("G787 the owner's page lists his projects, never a flight, booking, appointment, game or provider's mail, and names areas as their org writes them", () => {
  const root = ownerBrain();
  upkeep(root, { now: "2026-11-12" });
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  const me = body(root, "people/robin-vale");
  expect(me).toContain("[[projects/island-trip|Island family trip, December 2026]]");
  expect(me).toContain("[[projects/shed|Garden shed]]");
  expect(me).toContain("[[projects/kept|Tasting webinar series]]");
  for (const t of ["Flight to Pointe", "survey contest", "Physio Plus", "Owls vs Hawks"]) expect([t, me.includes(t)]).toEqual([t, false]);
  expect(me).toMatch(/Your NCL projects: \[\[projects\/course\|Course B\]\]/);
  expect(me).toMatch(/Your OV projects: \[\[projects\/board\|Option Verte board role\]\]/);
  expect(me).not.toMatch(/Your (?:ncl|ov) /);
  // The flight is on the trip's page instead, cited by its own facts.
  expect(parentOf(root, "projects/flight-out")).toBe("projects/island-trip");
  expect(body(root, "projects/island-trip")).toMatch(/On this trip: \[\[projects\/flight-out\|Flight to Pointe Bleue \(QX 738\)\]\]\.\[\^p-see-flight-out\]/);
});

test("G787 an area word takes its org's casing or initials, and stays as it is with no such org", () => {
  const org = (title: string, aliases: string[] = []) => ({ fm: { id: `orgs/${title}`, type: "org", title, aliases }, body: "", path: "" }) as unknown as Note;
  expect(areaWord("nca", [org("NCA Lakeside")])).toBe("NCA");
  expect(areaWord("gv", [org("Green Valley")])).toBe("GV");
  expect(areaWord("acme", [org("Acme")])).toBe("Acme");
  expect(areaWord("work", [org("Acme")])).toBe("work");
  expect(areaWord("personal", [])).toBe("personal");
});
