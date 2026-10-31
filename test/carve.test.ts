// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor, explain, renderPreview } from "../src/carve";
import { buildView } from "../src/view";

function setup(agent: string, slices?: string[]) {
  const root = makeBrain();
  const notes = loadBrain(root);
  const rules = loadRules(root);
  const res = carve(notes, rules, grantFor(rules, agent, slices));
  return { root, notes, rules, res };
}

test("helper gets work and basic contacts, never money", () => {
  const { res } = setup("helper");
  const ids = [...res.visible.keys()].sort();
  expect(ids).toEqual(["people/jane-roy", "projects/course-a", "projects/course-b"]);
  expect(res.excluded.find((e) => e.id === "money/main-bank")?.reason).toContain("not shared");
  expect(res.excluded.find((e) => e.id === "decisions/2026-09-01-pick-bank")?.reason).toContain("ceiling");
  expect(res.notShared).toEqual(["money"]);
});

test("finance-tagged contacts stay out of contacts-basic", () => {
  const { res } = setup("helper");
  expect(res.visible.has("people/paul-advisor")).toBe(false);
});

test("fact-level carving: area grant shows everything, contacts-basic only org and role", () => {
  const { res: planner } = setup("planner");
  expect(planner.hiddenFacts.find((h) => h.key === "people/jane-roy#phones")).toBeUndefined(); // work area grants all of Jane
  const { res: other } = setup("helper", ["contacts-basic"]);
  expect(other.hiddenFacts.find((h) => h.key === "people/jane-roy#phones")?.reason).toBe("attribute not in slice");
  expect(other.visible.get("people/jane-roy")?.body).toBe(false);
});

test("preview flags prose that names carved values and links to carved notes", () => {
  const { notes, res } = setup("helper");
  const kinds = res.flags.map((f) => `${f.id} ${f.kind}`);
  expect(kinds).toContain("projects/course-b carved-value-in-view");
  expect(kinds).toContain("projects/course-a links-to-excluded");
  expect(renderPreview(notes, res)).toContain('mentions "Maple Trust Bank"');
});

test("the built view redacts links, announces money and contains no bank facts", () => {
  const { root, notes, rules, res } = setup("helper");
  const { file } = buildView(notes, rules, res, root);
  const md = readFileSync(file, "utf8");
  expect(md).toContain("Not shared with you: money");
  expect(md).toContain("[[redacted]]");
  expect(md).not.toContain("money/main-bank");
  expect(md).not.toContain("Cards > Replace");
  const manifest = JSON.parse(readFileSync(join(root, "views", "helper.manifest.json"), "utf8"));
  expect(manifest.notes).not.toContain("money/main-bank");
});

test("steward with slice all sees money", () => {
  const { res } = setup("steward");
  expect(res.visible.has("money/main-bank")).toBe(true);
});

test("--why explains in and out", () => {
  const { notes, rules } = setup("helper");
  const g = grantFor(rules, "helper");
  expect(explain(notes, rules, g, "money/main-bank")[0]).toContain("OUT");
  expect(explain(notes, rules, g, "people/jane-roy")[0]).toContain("IN for helper, via area:work, contacts-basic");
});

test("exclude by single fact", () => {
  const { notes, rules } = setup("planner");
  const g = grantFor(rules, "planner");
  g.exclude.push("people/jane-roy#phones");
  const res = carve(notes, rules, g);
  expect(res.hiddenFacts.map((h) => h.key)).toContain("people/jane-roy#phones");
});

// G176 (add-like slice audit M2): an area that appears after an agent, named after it, used to
// hand the agent every note in it as "own". Own is now only what the agent wrote there, and its
// capability notes under agents/<agent>/.
test("an area named after an agent later doesn't hand it the area (G176)", () => {
  const root = makeBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^areas:\n/m, "areas:\n  helper: { owner: steward }\n"));
  const f = join(root, "projects", "course-b.md");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^area: \w+$/m, "area: helper"));
  mkdirSync(join(root, "agents", "helper"), { recursive: true });
  writeFileSync(join(root, "agents", "helper", "notes.md"), "---\nid: agents/helper/notes\ntype: capability\ntitle: Helper notes\narea: helper\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: helper\n---\nWhat helper keeps.\n");
  writeFileSync(join(root, "projects", "helper-own.md"), "---\nid: projects/helper-own\ntype: project\ntitle: Helper's list\narea: helper\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: helper\n---\nHelper wrote this.\n");
  const rules = loadRules(root);
  const res = carve(loadBrain(root), rules, grantFor(rules, "helper", ["contacts-basic"]));
  expect(res.visible.has("projects/course-b")).toBe(false);
  expect(res.excluded.find((e) => e.id === "projects/course-b")?.reason).toContain("no slice selects it");
  expect(res.visible.get("agents/helper/notes")?.slices).toEqual(["own"]);
  expect(res.visible.get("projects/helper-own")?.slices).toEqual(["own"]);
});

test("a list fact is hidden whole when any item's share_with leaves the agent out (G208)", () => {
  const { notes, rules } = setup("planner");
  const jane = notes.find((n) => n.fm.id === "people/jane-roy")!;
  const rec = (value: string, share_with?: string[]) => ({ value, as_of: "2026-10-01", sources: ["gmail:f000000000000001"], verification: "verified-by-source", by: "planner", recorded: "2026-10-01", ...(share_with ? { share_with } : {}) });
  jane.fm.facts!.phones = { items: [rec("+15145550100", ["planner"]), rec("+15145550199", ["steward"])] } as never;
  const hidden = (agent: string) => carve(notes, rules, grantFor(rules, agent)).hiddenFacts.some((h) => h.key === "people/jane-roy#phones");
  expect(hidden("planner")).toBe(true);
  expect(hidden("steward")).toBe(true);
  jane.fm.facts!.phones = { items: [rec("+15145550100", ["planner", "steward"]), rec("+15145550199", ["steward", "planner"])] } as never;
  expect(hidden("planner")).toBe(false);
});

test("only a purposeful exclusion carves values: an area whose name reads like a reason doesn't (backlog 181)", () => {
  const root = makeBrain();
  const note = (id: string, area: string, value: string) => require("node:fs").writeFileSync(join(root, `${id}.md`),
    `---\nid: ${id}\ntype: project\ntitle: ${id}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  partner: { value: ${value}, as_of: 2026-10-01, sources: ["url:https://example.org"], verification: verified-by-source }\n---\n`);
  for (const area of ["above-board", "excluded-trips", "not shared"]) note(`projects/p-${area.replace(" ", "-")}`, area, `Zephyr ${area.replace(/\W/g, "")} Holdings`);
  const res = carve(loadBrain(root), loadRules(root), grantFor(loadRules(root), "planner"));
  expect(res.carvedValues.filter((v) => v.startsWith("Zephyr"))).toEqual([]);
  // A purposeful exclusion still carves: Robin's bank is money, a type planner isn't given.
  expect(res.carvedValues).toContain("Maple Trust Bank");
});
