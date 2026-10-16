// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { buildIndex, rank, pack, terms } from "../src/retrieve";
import { capture, parseEmail } from "../src/capture";
import { decideProposal } from "../src/write";
import { makeModel, type ModelRequest } from "../src/model";

const indexFor = (root: string, agent: string) => {
  const notes = loadBrain(root), rules = loadRules(root);
  return buildIndex(carve(notes, rules, grantFor(rules, agent)), rules);
};

test("terms fold accents, drop stop words and share a stem across forms", () => {
  expect(terms("Évaluation des modèles")).toEqual(terms("evaluation modele"));
  expect(terms("what is the moderation")).toEqual(terms("moderate"));
});

test("ranking finds by title, fact and synonym, best first", () => {
  const idx = indexFor(makeBrain(), "steward");
  expect(rank(idx, "Jane Roy")[0].id).toBe("people/jane-roy");
  expect(rank(idx, "who grades the midterm")[0].id).toBe("projects/course-a");
  expect(rank(idx, "examen")[0].id).toBe("projects/course-a"); // exam = midterm = examen
});

test("hidden notes are never indexed, and can't move another note's score", () => {
  const root = makeBrain();
  const planner = indexFor(root, "planner");
  expect(rank(planner, "Main bank").map((h) => h.id)).not.toContain("money/main-bank");
  expect(rank(planner, "Paul Advisor")).toEqual([]); // finance-tagged contact is outside contacts-basic
  // the carved bank name never reaches planner's index, not even through course-b's prose
  expect(pack(planner, "Maple Trust").text).not.toContain("Maple");
  expect(planner.df.has(terms("Maple")[0])).toBe(false);
});

test("context pack sends matching paragraphs of long notes, not the whole note", () => {
  const idx = indexFor(makeBrain(), "steward");
  const p = pack(idx, "Course A logistics");
  expect(p.ids[0]).toBe("projects/course-a");
  expect(p.text).toContain("Grade the midterm");
});

// A capture model stand-in: it returns whatever facts the test hands it.
const fakeModel = (facts: unknown[]) => makeModel({ provider: "fake", model: "fake-1" }, { fake: (_r: ModelRequest) => JSON.stringify({ facts }) });

test("capture: stores the text, proposes only new facts, and accepting writes them as Robin's word", async () => {
  const root = makeBrain();
  const text = "Jane Roy is now the program director. Also Jane's role, still: program director. Course A next step: book the exam room.";
  const r = await capture(root, { kind: "text", text }, fakeModel([
    { entity: "Jane Roy", type: "person", attribute: "role", value: "Program director", quote: "Jane Roy is now the program director" },
    { entity: "Jane Roy", type: "person", attribute: "role", value: "Program director", quote: "Jane's role, still: program director" },
    { entity: "Course A", type: "project", attribute: "next_step", value: "Book the exam room", quote: "next step: book the exam room" },
    { entity: "Jane Roy", type: "person", attribute: "emails", value: "jane@example.com", quote: "Jane Roy is now the program director" },
  ]));
  expect(existsSync(join(root, r.file))).toBe(true);
  const by = Object.fromEntries(r.items.map((i) => [`${i.candidate.attribute}:${i.candidate.value}`, i]));
  expect(by["role:Program director"].status).toBe("changes");
  expect(by["role:Program director"].current).toBe("Course coordinator");
  expect(by["next_step:Book the exam room"].status).toBe("changes");
  expect(by["emails:jane@example.com"].status).toBe("ungrounded"); // the model made it up
  expect(r.items.filter((i) => i.proposal).length).toBe(2); // the repeated role is one proposal

  const p = YAML.parse(readFileSync(join(root, by["role:Program director"].proposal!), "utf8"));
  expect(p.request.sources[0]).toMatch(/^owner:\d{4}-\d{2}-\d{2}\/capture\//);
  const w = decideProposal(root, by["role:Program director"].proposal!, "accept");
  expect(w.outcome).toBe("committed");
  const jane = loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
  expect(JSON.stringify(jane.fm.facts!.role)).toContain("Program director");
});

test("capture: a value the brain already holds is known, and the same capture twice is a no-op", async () => {
  const root = makeBrain();
  const m = fakeModel([{ entity: "Jane", type: "person", attribute: "role", value: "course coordinator", quote: "Jane is the course coordinator" }]);
  const r1 = await capture(root, { kind: "voice", text: "Jane is the course coordinator." }, m);
  expect(r1.items[0].status).toBe("known");
  expect(r1.items[0].target).toBe("people/jane-roy"); // resolved through the alias
  const r2 = await capture(root, { kind: "voice", text: "jane is the course coordinator" }, m);
  expect(r2.duplicate).toBe(true);
});

test("capture: secrets are removed before storage, a new person becomes a new-note proposal, an email is a document source", async () => {
  const root = makeBrain();
  const raw = "From: Sam <sam@example.com>\nSubject: intro\nDate: Thu, 08 Oct 2026 10:00:00 -0400\n\nMeet Marie Tremblay, she is the new registrar. My password: hunter22";
  const r = await capture(root, parseEmail(raw), fakeModel([
    { entity: "Marie Tremblay", type: "person", attribute: "role", value: "Registrar", quote: "she is the new registrar" },
  ]));
  expect(r.removed).toContain("a password or PIN");
  expect(readFileSync(join(root, r.file), "utf8")).not.toContain("hunter22");
  expect(r.items[0].status).toBe("new-note");
  const p = YAML.parse(readFileSync(join(root, r.items[0].proposal!), "utf8"));
  // A forwarded email is a document (doc: ref). It used to say source_type email, which the
  // source check refuses on accept because email means a gmail: ref.
  expect(p.request).toMatchObject({ title: "Marie Tremblay", type: "person", source_type: "document" });
  expect(p.request.sources[0]).toMatch(/^doc:capture\//);
  expect(readdirSync(join(root, "inbox")).some((f) => f.includes("-capture-"))).toBe(true);
  const acc = decideProposal(root, r.items[0].proposal!, "accept");
  expect(acc.outcome).toBe("committed"); // a new person gets an area, so accepting works
  expect(loadBrain(root).some((n) => n.fm.title === "Marie Tremblay")).toBe(true);
});

test("capture: the model sees note titles at or below its ceiling only", async () => {
  const root = makeBrain();
  let seen = "";
  const m = makeModel({ provider: "fake", model: "fake-1", max_sensitivity: "personal" }, { fake: (r) => { seen = r.prompt; return '{"facts":[]}'; } });
  await capture(root, { kind: "text", text: "Pick a bank with Jane Roy, Main bank review" }, m);
  expect(seen).toContain("Jane Roy");
  const names = seen.split("Existing names that may match:")[1].split("Captured text:")[0];
  expect(names).toContain("Jane Roy");
  expect(names).not.toContain("Main bank"); // money and the decision are private
  expect(names).not.toContain("Pick a bank");
});

// G220: a note's age came from every raw fact date, so a hidden fact's recent as_of or a write to
// it (which moves `updated`) changed the rank an agent saw. The age reads visible facts only.
test("a hidden fact's date, and the update it causes, don't move a note's rank for an agent that can't see it", () => {
  const withHidden = (date: string) => {
    const root = makeBrain();
    const f = join(root, "projects/course-a.md");
    const t = readFileSync(f, "utf8")
      .replace("updated: 2026-10-01", `updated: ${date}`)
      .replace("\n---\nCourse", `\n  review_plan: { value: Reorder the quiz, as_of: ${date}, last_confirmed: ${date}, share_with: [steward], sources: ["gmail:f000000000000003"], verification: verified-by-source, by: steward, recorded: ${date} }\n---\nCourse`);
    writeFileSync(f, t);
    return root;
  };
  const score = (root: string, agent: string) => rank(indexFor(root, agent), "Course A logistics").find((h) => h.id === "projects/course-a")!.score;
  const fresh = withHidden("2026-10-07"), old = withHidden("2020-01-01");
  expect(score(fresh, "planner")).toBe(score(old, "planner"));
  expect(score(fresh, "helper")).toBe(score(old, "helper"));
  expect(score(fresh, "steward")).not.toBe(score(old, "steward")); // the agent that sees the fact still gets its date
});
