// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-10-31: his father's page (same surname as his) said "Nothing written here
// yet" and linked nowhere, and a mail's "M. <surname>" (him) was a person page of its own.
// G546: a person page with the owner's surname gets one inferred fact, "may be family", linking
// the owner's page, filed by upkeep with a diary line and Undo, never twice; nothing asks.
// G547: "M." and "Monsieur" are titles like "Mr"; a titled surname on the owner's page (the name a
// merge leaves there) is the owner whatever title of the same kind a source uses, never one of the
// other kind ("Mme").
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote } from "../src/brain";
import { loadRules } from "../src/rules";
import { upkeep } from "../src/upkeep";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { personKey, resolveEntity, sameTitled, write } from "../src/write";
import { ownerOf } from "../src/capture";
import { familyPages } from "../src/family";
import { inboundLinks } from "../scripts/north-star";

const person = (root: string, slug: string, title: string, facts = "", aliases = "", area = "personal") => writeFileSync(join(root, "people", `${slug}.md`), `---\nid: people/${slug}\ntype: person\ntitle: ${title}\n${aliases ? `aliases: [${aliases}]\n` : ""}area: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-10-28\nupdated: 2026-10-28\nby: steward\nfacts:\n${facts || "  {}"}\n---\n`);
const said = (attr: string, v: string, n: number) => `  ${attr}: { value: "${v}", as_of: 2026-10-28, sources: ["gmail:f00000000000004${n}"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`;
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: pages"], { cwd: root }); };

// `on`: the owner turned it on (`pocketbrain wiki family on`); `father`: Alain Lake's page exists.
function brain(o: { on?: boolean; father?: string; area?: string } = {}): string {
  const root = makeBrain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin, aliases: [Robin Lake] }") + (o.on === false ? "" : "family_links: true\n"));
  person(root, "robin-lake", "Robin Lake", said("role", "Teacher", 1), "M. Lake", o.area);
  if (o.father !== "") person(root, "alain-lake", "Alain Lake", o.father ?? said("city", "Lyon", 2), "", o.area);
  person(root, "nora-lake", "Nora Lake", said("relationship", "Neighbour", 3));
  person(root, "mme-lake", "Mme Lake", said("city", "Paris", 4));
  person(root, "kim-lakeman", "Kim Lakeman", said("city", "Nice", 5));
  commit(root);
  return root;
}
const page = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!;

test("a page with the owner's surname gets 'may be family', linking the owner's page both ways", async () => {
  const root = brain();
  expect(familyPages(loadRules(root), loadBrain(root)).map((p) => p.id)).toEqual(["people/alain-lake"]);
  upkeep(root);
  const f = page(root, "people/alain-lake").fm.facts!.family as { value: string; confidence?: string; sources: string[] };
  expect(f.value).toBe("[[people/robin-lake]]");
  expect(f.confidence).toBe("inferred");
  expect(f.sources.map(String)).toEqual(["unverified"]);
  // Nobody else: a page that already says how you know them, a title and the surname alone, another surname.
  for (const id of ["people/nora-lake", "people/mme-lake", "people/kim-lakeman", "people/robin-lake", "people/jane-roy"]) expect(page(root, id).fm.facts?.family).toBeUndefined();
  const rows = readDiary(root).filter((r) => r.why === "family");
  expect(rows.map((r) => [r.kind, r.fact_key])).toEqual([["new", "people/alain-lake#family"]]);
  expect(Bun.spawnSync(["git", "log", "-1", "--format=%an%x00%B", "--grep=^Kind: family"], { cwd: root }).stdout.toString()).toMatch(/^hub\0[\s\S]*^Why: \S/m);
  // The page text links the owner's page, and the owner's page links back.
  const notes = loadBrain(root);
  expect(page(root, "people/alain-lake").body).toMatch(/\[\[people\/robin-lake\|/);
  const inbound = inboundLinks(notes);
  expect(inbound.get("people/robin-lake") ?? 0).toBeGreaterThan(0);
  expect(inbound.get("people/alain-lake") ?? 0).toBeGreaterThan(0);
  const { homeView } = await import("../src/dashboard/home");
  const v = homeView(root, loadRules(root), notes, new Date(), { all: true });
  expect(v.since.map((l) => l.what)).toContain("Alain Lake may be family: same surname as you");
  // Asks nothing.
  expect(v.waiting.map((w) => w.what).join(" ")).not.toMatch(/Alain/);
});

test("its Undo takes it out, and upkeep never files it again", () => {
  const root = brain();
  upkeep(root);
  const row = readDiary(root).find((r) => r.why === "family")!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(page(root, "people/alain-lake").fm.facts?.family).toBeUndefined();
  upkeep(root);
  expect(page(root, "people/alain-lake").fm.facts?.family).toBeUndefined();
  expect(readDiary(root).filter((r) => r.why === "family")).toHaveLength(1);
});

test("'Monsieur' and 'Madame' are titles, like 'Mr'; 'M.' is a title only beside another title", () => {
  expect(personKey("Monsieur Lake")).toBe("lake");
  expect(personKey("Madame Lake")).toBe("lake");
  // "M. Dupont" may be Marc Dupont: alone it keeps its letter (slice audit 2026-10-25).
  expect(personKey("M. Lake")).toBe("m lake");
  expect(sameTitled("M. Lake", "Monsieur Lake")).toBe(true);
  expect(sameTitled("M. Lake", "Mr. Lake")).toBe(true);
  expect(sameTitled("M. Lake", "Mme Lake")).toBe(false);
  expect(sameTitled("M Lake", "Mr Lake")).toBe(false);
});

test("a titled surname on the owner's page is the owner, under any title of the same kind, never the other kind", () => {
  const root = brain({ father: "" });
  rmSync(join(root, "people", "nora-lake.md")); // no one else has the surname
  const rules = loadRules(root), notes = loadBrain(root);
  for (const t of ["M. Lake", "Mr Lake", "Mr. Lake", "Monsieur Lake", "M. Robin Lake"]) {
    expect(ownerOf(rules, notes, t)?.page).toBe("people/robin-lake");
    expect(resolveEntity(notes, "person", t).id).toBe("people/robin-lake");
  }
  for (const t of ["Mme Lake", "Madame Lake", "Mrs Lake"]) {
    expect(ownerOf(rules, notes, t)).toBeUndefined();
    expect(resolveEntity(notes, "person", t).id).not.toBe("people/robin-lake");
  }
});

// Builder's slice audit of b532242 (F1, high): the family fact took the sources of every record on
// the page, a fact shared with one assistant and a fact held unseen among them, so every reader of
// the page saw those refs. Only records every reader sees feed it; a hidden one doesn't stop it (F2).
test("the family fact cites only what every reader of the page sees", async () => {
  const hidden = said("city", "Lyon", 2)
    + `  diagnosis: { value: "Sekrit", as_of: 2026-10-28, sources: ["url:https://clinic.example/alain-oncology"], verification: verified-by-source, by: steward, recorded: 2026-10-28, share_with: [steward] }\n`
    + `  lawyer: { value: "Bob", as_of: 2026-10-28, sources: ["gmail:f0000000000000aa"], verification: verified-by-source, by: steward, recorded: 2026-10-28, unseen: true }\n`
    + `  relationship: { value: "Uncle", as_of: 2026-10-28, sources: ["gmail:f000000000000045"], verification: verified-by-source, by: steward, recorded: 2026-10-28, share_with: [steward] }\n`;
  const root = brain({ father: hidden, area: "work" });
  const { linkFamily } = await import("../src/family");
  expect(linkFamily(root).filed).toEqual(["people/alain-lake"]);
  const f = page(root, "people/alain-lake").fm.facts!.family as { sources: string[] };
  expect(f.sources.map(String)).toEqual(["unverified"]);
  const core = await import("../src/core");
  for (const agent of ["planner", "helper"]) {
    const read = JSON.stringify(core.readNote(root, agent, "people/alain-lake")) + core.contextPack(root, agent, "Alain Lake") + JSON.stringify(core.whatsNew(root, agent));
    expect(read).not.toMatch(/oncology|f0000000000000aa|f000000000000045/);
  }
});

// The link names the owner's page: never on a page read by an assistant that can't read the owner's.
test("no family link where a reader of the page can't read the owner's page", async () => {
  const root = brain({ area: "work" });
  const p = join(root, "people", "robin-lake.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("area: work", "area: personal").replace("sensitivity: personal", "sensitivity: private"));
  commit(root);
  const { linkFamily } = await import("../src/family");
  expect(linkFamily(root).filed).toEqual([]);
});

// F3: a new nightly writer starts off; off, upkeep counts the pages and names none; on, each fact
// it files has its line in log/writes.jsonl.
test("off until the owner turns it on; then every fact it files is in the write log", () => {
  const off = brain({ on: false });
  const r = upkeep(off);
  expect(page(off, "people/alain-lake").fm.facts?.family).toBeUndefined();
  const f = r.findings.find((x) => x.rule === "family-links")!;
  expect(f.detail).toMatch(/^1 person page has your surname/);
  expect(f.detail).not.toMatch(/Alain|alain/);
  const on = brain();
  upkeep(on);
  const log = readFileSync(join(on, "log", "writes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(log.filter((l) => l.kind === "family").map((l) => [l.agent, l.key, l.outcome])).toEqual([["hub", "people/alain-lake#family", "committed"]]);
});

// F4: the owner's "M. Lake" is not their father's "Monsieur Lake": a titled surname alone is the
// owner only while no one else's page has that surname. Written exactly as the owner's alias, it is.
test("a titled surname alone is not the owner while someone else's page has that surname", () => {
  const root = brain();
  const rules = loadRules(root), notes = loadBrain(root);
  for (const t of ["Monsieur Lake", "Mr Lake", "Mr. Lake"]) {
    expect(ownerOf(rules, notes, t)).toBeUndefined();
    expect(resolveEntity(notes, "person", t).id).not.toBe("people/robin-lake");
  }
  expect(ownerOf(rules, notes, "M. Lake")?.page).toBe("people/robin-lake");
  expect(ownerOf(rules, notes, "M. Robin Lake")?.page).toBe("people/robin-lake");
});

// Builder's slice audit of b1619f30 (F1, F2): a fact one assistant's exclude by name hides, or a
// slice's exclude_attributes, fed its refs to every reader of the page. The carve decides now: a
// fact any reader of the page has carved away neither feeds the link nor stops it.
test("a fact an exclude by name or a slice hides from a reader never feeds or stops the link", async () => {
  const facts = said("org", "Acme", 2)
    + `  diagnosis: { value: Sekrit, as_of: 2026-10-28, sources: ["url:https://clinic.example/byname-oncology"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`
    + `  therapy: { value: Sekrit2, as_of: 2026-10-28, sources: ["url:https://clinic.example/slice-psychiatry"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`
    + `  relationship: { value: Uncle, as_of: 2026-10-28, sources: ["gmail:f000000000000045"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`;
  const root = brain({ father: facts, area: "work" });
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8")
    .replace("exclude_types: [money] }", `exclude_types: [money], exclude: ["people/alain-lake#diagnosis", "people/alain-lake#relationship"] }`)
    .replace("helper: { tier: trial, slices: [area:work, contacts-basic], exclude_types: [money] }", "helper: { tier: trial, slices: [worknohealth], exclude_types: [money] }"));
  const sl = join(root, "rules", "slices.yaml");
  writeFileSync(sl, readFileSync(sl, "utf8").replace("slices:\n", "slices:\n  worknohealth:\n    areas: [work]\n    exclude_attributes: [therapy, relationship]\n    max_sensitivity: personal\n"));
  commit(root);
  const { linkFamily } = await import("../src/family");
  expect(linkFamily(root).filed).toEqual(["people/alain-lake"]);
  const f = page(root, "people/alain-lake").fm.facts!.family as { sources: string[] };
  expect(f.sources.map(String)).toEqual(["unverified"]);
});

// F5, accepted: an assistant's page with the owner's surname ("Eve Lake") turns a titled surname
// alone ("Monsieur Lake") from the owner into an ambiguity. It fails safe: the write waits, no
// page is made and nothing lands on the owner's page.
test("a page with the owner's surname makes a titled surname alone wait, never a new page", () => {
  const root = brain({ father: "" });
  rmSync(join(root, "people", "nora-lake.md"));
  person(root, "eve-lake", "Eve Lake", said("city", "Nice", 6));
  commit(root);
  const pages = loadBrain(root).length;
  expect(ownerOf(loadRules(root), loadBrain(root), "Monsieur Lake")).toBeUndefined();
  write(root, { agent: "steward", type: "person", title: "Monsieur Lake", attribute: "appointment", value: "Cardiology, Tuesday", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" } as never);
  expect(loadBrain(root).length).toBe(pages);
  expect(page(root, "people/robin-lake").fm.facts?.appointment).toBeUndefined();
});

// Builder's slice audit of da6497e0 (F6): refs copied once outlived a later tightening of the fact
// they came from. The family fact copies no ref, so a tightening holds at once, whatever the cells.
test("a source fact tightened after the link is gone from every other reader at once", async () => {
  const facts = said("org", "Acme", 2) + `  diagnosis: { value: Sekrit, as_of: 2026-10-28, sources: ["url:https://clinic.example/alain-oncology"], verification: verified-by-source, by: steward, recorded: 2026-10-28 }\n`;
  const root = brain({ father: facts, area: "work" });
  const { linkFamily } = await import("../src/family");
  expect(linkFamily(root).filed).toEqual(["people/alain-lake"]);
  // The owner tightens the diagnosis to one assistant.
  const n = page(root, "people/alain-lake");
  (n.fm.facts!.diagnosis as { share_with?: string[] }).share_with = ["steward"];
  saveNote(root, n);
  commit(root);
  const core = await import("../src/core");
  const was = process.env.PB_CELLS;
  try {
    for (const cells of ["0", "1"]) {
      process.env.PB_CELLS = cells;
      for (const agent of ["planner", "helper"]) expect(JSON.stringify(core.readNote(root, agent, "people/alain-lake")) + core.contextPack(root, agent, "Alain Lake"), `${agent} cells ${cells}`).not.toMatch(/oncology/);
    }
  } finally { if (was === undefined) delete process.env.PB_CELLS; else process.env.PB_CELLS = was; }
});

// An assistant whose view can't be built (a slice the rules don't define) is not left out of the
// count: no page is linked at all (fails closed).
test("an assistant whose view can't be built stops every link", async () => {
  const root = brain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace(/^agents:\n/m, "agents:\n  ghost: { tier: trial, slices: [no-such-slice] }\n"));
  commit(root);
  const { linkFamily } = await import("../src/family");
  expect(linkFamily(root).filed).toEqual([]);
});
