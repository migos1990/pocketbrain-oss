// SPDX-License-Identifier: AGPL-3.0-only
// A new page's area (G841). The capture path gave a page made from a mail the area of any page
// that shared one word of its title with the mail: an airline mail and a ride receipt "in Montréal"
// landed in the area of an organisation whose name carries the city, and every assistant reading
// that area then read them (owner's phone, 2026-11-14). An area decides who reads a page, so a new
// page's area now comes from structure only: the source's own area, else a page the text names by
// its whole title or alias when that area hands no assistant more than the default would, else the
// default (the capturing assistant's own area, else personal). Temp brains removed after.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { capture, newPageArea } from "../src/capture";
import { guessedAreas, unguessAreas } from "../src/area-guess";
import { neverWider } from "../src/area-follow";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { makeModel, type ModelRequest } from "../src/model";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const fakeModel = (facts: unknown[]) => makeModel({ provider: "fake", model: "fake-1" }, { fake: (_r: ModelRequest) => JSON.stringify({ facts }) });

const page = (root: string, path: string, id: string, type: string, title: string, area: string) =>
  writeFileSync(join(root, path), `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: owner\nfacts: {}\n---\n`);

function brain(): string {
  const root = makeBrain();
  roots.push(root);
  // A work project whose name carries a city, and an area that only the all-seeing assistants read.
  page(root, "projects/montreal-office-move.md", "projects/montreal-office-move", "project", "Montréal Office Move", "work");
  page(root, "projects/family-reunion.md", "projects/family-reunion", "project", "Family Reunion", "family");
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("  work: { owner: planner }\n", "  work: { owner: planner }\n  family: { owner: steward }\n"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "pages"]);
  return root;
}

test("a receipt that shares one word with a work page's title is filed in personal, not work", async () => {
  const root = brain();
  const r = await capture(root, { kind: "text", text: "Thanks for riding. Your driver Marco Bellini took you from the Plateau, Montréal on Friday." }, fakeModel([
    { entity: "Marco Bellini", type: "person", attribute: "role", value: "driver", quote: "Your driver Marco Bellini" },
  ]));
  expect(r.items[0].status).toBe("new-note");
  const p = YAML.parse(readFileSync(join(root, r.items[0].proposal!), "utf8"));
  expect(p.request.area).toBe("personal");
});

test("a name in the text, a shared word or the capturing assistant's own area never places a page", async () => {
  const root = brain();
  // A whole page name in the text is co-mention, not a link: the page is not filed yet.
  const named = await capture(root, { kind: "text", text: "Your driver Marco Bellini is booked for the Family Reunion." }, fakeModel([
    { entity: "Marco Bellini", type: "person", attribute: "role", value: "driver", quote: "Your driver Marco Bellini" },
  ]));
  expect(YAML.parse(readFileSync(join(root, named.items[0].proposal!), "utf8")).request.area).toBe("personal");
  expect(newPageArea(loadRules(root))).toBe("personal");
  // A brain with no personal area files it in its first area.
  const rules = loadRules(root);
  const { personal: _p, ...rest } = rules.policy.areas!;
  expect(newPageArea({ ...rules, policy: { ...rules.policy, areas: rest } })).toBe("work");
});

// G842: pages the word guess already placed. The night pass counts them until the owner turns the
// move on; then each goes back to the default area with a `moved` diary line whose Undo puts it back.
const captured = (root: string, id: string, title: string, area: string, extra = "") =>
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-02\nupdated: 2026-10-02\nby: steward\nfacts:\n  role:\n    value: driver\n    as_of: 2026-10-02\n    sources: [gmail:f000000000000901]\n    verification: verified-by-source\n    by: steward\n    recorded: 2026-10-02\n---\n${extra}`);

test("a page the capture path put in an area by a word guess is listed, and moves back with Undo once on", () => {
  const root = brain();
  captured(root, "people/marco-bellini", "Marco Bellini", "work");
  // Explained by structure: a work page links it.
  captured(root, "people/lena-ortiz", "Lena Ortiz", "work");
  writeFileSync(join(root, "projects/montreal-office-move.md"), readFileSync(join(root, "projects/montreal-office-move.md"), "utf8") + "Movers: [[people/lena-ortiz]]\n");
  // Made by the owner: never listed.
  page(root, "people/sam-owner-made.md", "people/sam-owner-made", "person", "Sam Made", "work");
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "captured"]);
  expect(guessedAreas(root)).toEqual([{ id: "people/marco-bellini", from: "work", to: "personal" }]);
  const off = unguessAreas(root, false);
  expect(off.moved).toEqual([]);
  expect(loadBrain(root).find((n) => n.fm.id === "people/marco-bellini")!.fm.area).toBe("work");
  const on = unguessAreas(root, true);
  expect(on.moved.map((m) => [m.id, m.from, m.to])).toEqual([["people/marco-bellini", "work", "personal"]]);
  expect(loadBrain(root).find((n) => n.fm.id === "people/marco-bellini")!.fm.area).toBe("personal");
  const row = readDiary(root).find((r) => r.kind === "moved" && r.fact_key === "people/marco-bellini#")!;
  expect(row).toBeTruthy();
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(loadBrain(root).find((n) => n.fm.id === "people/marco-bellini")!.fm.area).toBe("work");
  // Moved back by Undo: someone moved it since it was made, so the night never moves it again.
  expect(guessedAreas(root)).toEqual([]);
});

test("a page whose move would hand an assistant more is never listed", () => {
  const root = brain();
  writeFileSync(join(root, "projects/hall-booking.md"), `---\nid: projects/hall-booking\ntype: project\ntitle: Hall booking\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-02\nupdated: 2026-10-02\nby: steward\nfacts: {}\n---\n`);
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "captured"]);
  // ...work to personal narrows a project (planner and helper read work), so it is listed.
  expect(guessedAreas(root).map((p) => p.id)).toEqual(["projects/hall-booking"]);
  const rules = loadRules(root);
  // The other way (personal to work) would widen, so neverWider refuses it.
  expect(neverWider(rules, "project", "work", "personal")).toBe(false);
  expect(neverWider(rules, "project", "personal", "work")).toBe(true);
});

// Slice audit of G841/G842: the cases a bare stand-in page missed.
test("a page whose move to personal would show it to a tag slice there is never moved", () => {
  const root = brain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("agents:\n", "agents:\n  tagger: { tier: trial, slices: [personal-pub] }\n"));
  const slices = join(root, "rules", "slices.yaml");
  writeFileSync(slices, readFileSync(slices, "utf8") + "  personal-pub:\n    areas: [personal]\n    tags: [pub]\n");
  captured(root, "people/marco-bellini", "Marco Bellini", "work");
  const p = join(root, "people/marco-bellini.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("status: active\n", "status: active\ntags: [pub]\n"));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "captured"]);
  expect(guessedAreas(root)).toEqual([]);
});

test("a page the owner made (an accepted proposal, its area the owner's to edit) is never listed", () => {
  const root = brain();
  captured(root, "people/marco-bellini", "Marco Bellini", "work");
  git(root, ["add", "-A"]);
  Bun.spawnSync(["git", "commit", "-qm", "owner: accepted"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: "owner@pocketbrain.local", GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: "owner@pocketbrain.local" } });
  expect(guessedAreas(root)).toEqual([]);
});

test("an assistant's own capture stays in its own area when personal would show it to more assistants", () => {
  const root = brain();
  const policy = join(root, "rules", "policy.yaml");
  // An assistant that reads personal but not work.
  writeFileSync(policy, readFileSync(policy, "utf8").replace("agents:\n", "agents:\n  homebot: { tier: trial, slices: [area:personal] }\n"));
  const rules = loadRules(root);
  expect(newPageArea(rules, { agent: "planner", type: "project" })).toBe("work");
  // A pulled item is never the capturer's own: not filed yet.
  expect(newPageArea(rules, { agent: "planner", type: "project", pulled: true })).toBe("personal");
});

// Security review, 2026-11-15: the move check compared only whether the page was seen, its
// attribute list and its body. A slice that hides one attribute by name (exclude_attributes, or
// exclude <id>#<attr>) hides it at the fact level, so a move to an area another slice reads in full
// passed the check and served that fact.
test("a page is never moved back where a slice that hid one of its facts no longer hides it", async () => {
  const { moveNeverWider } = await import("../src/area-follow");
  for (const slice of ["{ areas: [work], exclude_attributes: [phone] }", "{ areas: [work], exclude: [people/x-y#phone] }"]) {
    const root = makeBrain();
    roots.push(root);
    const policy = join(root, "rules", "policy.yaml");
    writeFileSync(policy, readFileSync(policy, "utf8").replace("  helper: {", "  narrow: { tier: core, slices: [work-nophone, area:personal] }\n  helper: {"));
    const slices = join(root, "rules", "slices.yaml");
    writeFileSync(slices, readFileSync(slices, "utf8").replace("slices:\n", `slices:\n  work-nophone: ${slice}\n`));
    writeFileSync(join(root, "people/x-y.md"), "---\nid: people/x-y\ntype: person\ntitle: X Y\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-02\nupdated: 2026-10-02\nby: steward\nfacts:\n  phone:\n    value: \"+15145550199\"\n    as_of: 2026-10-02\n    sources: [gmail:f000000000000904]\n    verification: verified-by-source\n    by: steward\n    recorded: 2026-10-02\n---\n");
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "setup"]);
    const n = loadBrain(root).find((x) => x.fm.id === "people/x-y")!;
    expect([slice, moveNeverWider(loadRules(root), n, "personal")]).toEqual([slice, false]);
  }
});
