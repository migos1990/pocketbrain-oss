// SPDX-License-Identifier: AGPL-3.0-only
// Red-team probes for "Same person?" (redteam 2026-10-16, gaps G150-G155): what an agent sees after
// the owner's Merge click, and what Undo leaves behind. Each test states the property that should
// hold. RT1-RT3 were leaks; the fix refuses those merges before anything is written.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { samePersonProposals, mergeSamePerson, undoPersonMerge } from "../src/sameperson";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carveParity, mergeNotes } from "../src/merge";
import * as merge from "../src/merge";
import { withTokenRole } from "../src/tokenrole";
import { readNote, remember, listDisputes, ownerDecide } from "../src/core";
import { upkeep } from "../src/upkeep";
import { carve, grantFor } from "../src/carve";
import { FgaClient, startFga, stopFga } from "../src/fga";
import { useCells, cellDir } from "../src/cell";

const rec = (value: string, src: string) =>
  `{ value: "${value}", as_of: 2026-09-01, sources: ["${src}"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }`;
const PHONE = rec("(514) 555-0100", "imsg:phonemsg-77");
function person(root: string, id: string, title: string, o: { area?: string; sensitivity?: string; created?: string; tags?: string[]; facts?: string; phone?: string } = {}) {
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: ${o.area ?? "work"}\nsensitivity: ${o.sensitivity ?? "personal"}\n${o.tags ? `tags: [${o.tags.join(", ")}]\n` : ""}status: active\ncreated: ${o.created ?? "2026-10-03"}\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${o.phone ?? PHONE}] }\n${o.facts ?? ""}---\nA person.\n`);
}
const commit = (root: string) => { Bun.spawnSync(["git", "add", "-A"], { cwd: root }); Bun.spawnSync(["git", "commit", "-qm", "fixture"], { cwd: root }); };
const policy = (root: string, f: (s: string) => string) => { const p = join(root, "rules/policy.yaml"); writeFileSync(p, f(readFileSync(p, "utf8"))); };
const seen = (root: string, agent: string, id: string) => { try { return readNote(root, agent, id); } catch { return undefined; } };
const head = (root: string) => Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
// The merge is refused, nothing is written, and the agent still can't read the hidden fact.
function refused(root: string, id: string) {
  const status = () => Bun.spawnSync(["git", "status", "--porcelain", "--", ".", ":!log"], { cwd: root }).stdout.toString();
  const at = head(root), was = status();
  expect(() => mergeSamePerson(root, id)).toThrow(/can't merge here/);
  expect(head(root)).toBe(at);
  expect(status()).toBe(was);
  expect(loadBrain(root).find((n) => n.fm.id === "people/j-roy")!.fm.status).toBe("active");
}
const DIAG = `  diagnosis: { value: "Type 1 diabetes", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }\n`;

test("RT1 area: a fact from a person note in an area the agent lacks must not reach it through a merge", () => {
  const root = makeBrain();
  // Same person, second note filed in the owner's personal area (planner has area:work + contacts-basic).
  person(root, "people/j-roy", "Jay Roy", { area: "personal", facts: DIAG });
  commit(root);
  expect(seen(root, "planner", "people/j-roy")?.facts.diagnosis).toBeUndefined(); // hidden before
  const [p] = samePersonProposals(root);
  expect(p.keep).toBe("people/jane-roy");
  expect(p.blocked).toContain("different areas (personal, work)");
  refused(root, p.id);
  expect(() => mergeSamePerson(root, p.id, { swap: true })).toThrow(/different areas/);
  const after = seen(root, "planner", "people/jane-roy")!;
  expect(after.facts.diagnosis).toBeUndefined();
  expect(after.aliases).not.toContain("Jay Roy");
});

test("RT2 exclude by name: a note excluded from an agent must not hand it its facts through a merge", () => {
  const root = makeBrain();
  policy(root, (s) => s.replace("exclude_types: [money] }\n  # Keeps", "exclude_types: [money], exclude: [people/j-roy] }\n  # Keeps"));
  person(root, "people/j-roy", "Jay Roy", { facts: DIAG });
  commit(root);
  expect(seen(root, "planner", "people/j-roy")).toBeUndefined();
  const [p] = samePersonProposals(root);
  expect(p.blocked).toContain("planner's exclude");
  refused(root, p.id);
  expect(seen(root, "planner", "people/jane-roy")!.facts.diagnosis).toBeUndefined();
});

test("RT3 fact exclude: an excluded fact key (hiddenFacts) must stay hidden after a merge", () => {
  const root = makeBrain();
  policy(root, (s) => s.replace("exclude_types: [money] }\n  # Keeps", "exclude_types: [money], exclude: [\"people/j-roy#diagnosis\"] }\n  # Keeps"));
  person(root, "people/j-roy", "Jay Roy", { facts: DIAG });
  commit(root);
  expect(seen(root, "planner", "people/j-roy")!.facts.diagnosis).toBeUndefined();
  const [p] = samePersonProposals(root);
  expect(p.blocked).toBeDefined();
  refused(root, p.id);
  expect(seen(root, "planner", "people/jane-roy")!.facts.diagnosis).toBeUndefined();
});

const ANN = rec("+15145550222", "imsg:phonemsg-90");
test("RT4 tags: a private note's tag must not widen an agent's reach into the kept note", () => {
  const root = makeBrain();
  // helper: trial, personal ceiling; a "fam" slice selects notes tagged family.
  const sl = join(root, "rules/slices.yaml");
  writeFileSync(sl, readFileSync(sl, "utf8") + "  fam:\n    tags: [family]\n");
  policy(root, (s) => s.replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [area:work, contacts-basic, fam]"));
  person(root, "people/ann", "Ann Lee", { area: "personal", created: "2026-09-01", facts: `  birthday: { value: "1990-01-01", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }\n`, phone: ANN });
  person(root, "people/ann-2", "Ann L.", { area: "personal", sensitivity: "private", tags: ["family"], phone: ANN });
  commit(root);
  expect(seen(root, "helper", "people/ann")?.facts.birthday).toBeUndefined();
  const [p] = samePersonProposals(root);
  expect(p.keep).toBe("people/ann");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/make their access the same first/);
  expect(seen(root, "helper", "people/ann")?.facts.birthday).toBeUndefined();
});

test("RT5 undo: links upkeep repointed to the kept note go back, so a hidden note stays [[redacted]]", () => {
  const root = makeBrain();
  // Both notes private: helper (personal ceiling) sees neither, so the merge is allowed, and the
  // link stays [[redacted]] for helper even after upkeep repoints it (G205). Both carry the same
  // title, so the merge adds no name: a new alias of a private note would be newly withheld from
  // helper's prose, and that refuses the merge (G247).
  const jr = join(root, "people/jane-roy.md");
  writeFileSync(jr, readFileSync(jr, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  person(root, "people/j-roy", "Jane Roy", { sensitivity: "private", phone: rec("(514) 555-0100", "gmail:f000000000000001") }); // same ref as Jane's, so upkeep's recheck leaves both notes alone
  const c = join(root, "projects/course-a.md");
  writeFileSync(c, readFileSync(c, "utf8").replace("Course logistics.", "Course logistics. TA is [[people/j-roy]]."));
  commit(root);
  const files = ["projects/course-a.md", "people/jane-roy.md", "people/j-roy.md"].map((f) => readFileSync(join(root, f), "utf8"));
  const before = seen(root, "helper", "projects/course-a")!.body;
  expect(before).toContain("TA is [[redacted]]");
  expect(before).not.toContain("people/jane-roy");
  const [p] = samePersonProposals(root);
  mergeSamePerson(root, p.id);
  upkeep(root);
  expect(readFileSync(c, "utf8")).toContain("[[people/jane-roy]]"); // the repoint happened
  // and tells helper nothing (the page writer's own opening for the touched page aside; the text
  // that was there is kept word for word under Earlier notes)
  expect(seen(root, "helper", "projects/course-a")!.body!).toContain(`## Earlier notes\n${before!.trimEnd()}`);
  undoPersonMerge(root, p.id); // allowed: upkeep's repoint is the only later change
  expect(seen(root, "helper", "projects/course-a")!.body).toBe(before);
  expect(readFileSync(c, "utf8")).toContain("[[people/j-roy]]");
  expect(["projects/course-a.md", "people/jane-roy.md", "people/j-roy.md"].map((f) => readFileSync(join(root, f), "utf8"))).toEqual(files);
});

// RT6: an open dispute on a list item (item_key lists) must block the merge like an open dispute on
// a single fact does.
test("RT6 an open list-item dispute on either note blocks the merge", () => {
  const root = makeBrain();
  const ck = join(root, "rules/checks.yaml");
  writeFileSync(ck, readFileSync(ck, "utf8").replace("      last_contact:", "      pets: { merge: set, item_key: name }\n      last_contact:"));
  writeFileSync(join(root, "people/j-roy.md"), `---\nid: people/j-roy\ntype: person\ntitle: J. Roy\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-03\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [{ value: "(514) 555-0100", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }] }\n---\nA person.\n`);
  commit(root);
  const w = (kind: string, src: string) => remember(root, "planner", { id: "people/j-roy", attribute: "pets", value: { name: "Max", kind }, as_of: "2026-09-02", sources: [src] });
  w("dog", "gmail:f000000000000001");
  const r = w("cat", "gmail:f000000000000003");
  expect(r.outcome).toBe("disputed");
  const open = listDisputes(root, "steward");
  expect(open.map((d) => d.fact_key)).toContain("people/j-roy#pets");
  const [p] = samePersonProposals(root);
  expect(p).toBeDefined();
  let refused = false;
  try { mergeSamePerson(root, p.id); } catch { refused = true; }
  const after = listDisputes(root, "steward").find((d) => d.fact_key === "people/j-roy#pets");
  const jroy = loadBrain(root).find((n) => n.fm.id === "people/j-roy")!;
  if (!refused) {
    // The owner answers the dispute: the answer lands on the merged pointer, the kept note keeps both items.
    ownerDecide(root, after!.id, 1);
    const kids = (loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.pets as { items: { dispute?: string; valid_to?: string }[] }).items;
    console.log("RT6 kept kids after owner answer:", JSON.stringify(kids.map((k) => ({ dispute: k.dispute, valid_to: k.valid_to }))));
  }
  // Either the merge is refused, or the open dispute follows the fact onto the kept note.
  expect({ refused, dropStatus: jroy.fm.status, packetPointsAtMergedNote: !!after }).toEqual({ refused: true, dropStatus: "active", packetPointsAtMergedNote: true });
});

// ---------- slice audit of 80cdddf (G168-G171): the merge is decided by a before/after carve ----------
const edit = (root: string, f: string, fn: (s: string) => string) => { const p = join(root, f); writeFileSync(p, fn(readFileSync(p, "utf8"))); };
const NICK = `  nickname: { value: "Bluebird", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }\n`;
const pairWith = (root: string, id: string) => samePersonProposals(root).find((x) => [x.keep, x.drop].includes(id))!;

test("G168 exclude_tags: a private finance-tagged note can't merge into a note an exclude_tags slice shows", () => {
  const root = makeBrain();
  edit(root, "rules/slices.yaml", (s) => s + "  w2:\n    areas: [work]\n    exclude_tags: [finance]\n");
  edit(root, "rules/policy.yaml", (s) => s.replace("planner: { tier: core, aliases: [Planbot], slices: [area:work, contacts-basic]", "planner: { tier: core, aliases: [Planbot], slices: [w2]"));
  person(root, "people/jane-x", "Jane X", { created: "2026-09-01" });
  person(root, "people/jane-y", "Jane Y", { sensitivity: "private", tags: ["finance"], facts: NICK });
  commit(root);
  expect(seen(root, "planner", "people/jane-y")).toBeUndefined();
  const p = pairWith(root, "people/jane-y");
  expect(p.keep).toBe("people/jane-x");
  expect(p.blocked).toMatch(/planner.* see one of these notes but not the other/);
  expect(p.card).toContain("Can't merge here: ");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  expect(seen(root, "planner", "people/jane-x")?.facts.nickname).toBeUndefined();
});

test("G169 selectors: a tags-only or include slice that selects the kept note can't be handed the dropped note's facts", () => {
  const root = makeBrain();
  edit(root, "rules/slices.yaml", (s) => s + "  fam:\n    tags: [family]\n");
  edit(root, "rules/policy.yaml", (s) => s.replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [fam]"));
  const ph = rec("+15145550999", "imsg:phonemsg-90");
  person(root, "people/ann", "Ann Lee", { area: "personal", tags: ["family"], created: "2026-09-01", phone: ph });
  person(root, "people/ann-2", "Ann L.", { area: "personal", facts: NICK, phone: ph });
  commit(root);
  expect(seen(root, "helper", "people/ann-2")).toBeUndefined();
  const p = pairWith(root, "people/ann-2");
  expect(p.blocked).toBe("helper sees one of these notes but not the other (or not all of it); make their access the same first");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/helper sees one of these notes/);
  expect(seen(root, "helper", "people/ann")?.facts.nickname).toBeUndefined();

  // include: [<kept id>] in a slice works the same way.
  const r2 = makeBrain();
  edit(r2, "rules/slices.yaml", (s) => s + "  just-ann:\n    include: [people/ann]\n");
  edit(r2, "rules/policy.yaml", (s) => s.replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [just-ann]"));
  person(r2, "people/ann", "Ann Lee", { area: "personal", created: "2026-09-01", phone: ph });
  person(r2, "people/ann-2", "Ann L.", { area: "personal", facts: NICK, phone: ph });
  commit(r2);
  const q = pairWith(r2, "people/ann-2");
  expect(q.blocked).toContain("helper sees one of these notes");
  expect(q.swap_blocked).toContain("helper sees one of these notes"); // either way: helper sees them differently
});

test("G170 a dispute candidate limited to steward stays hidden from planner after a merge", () => {
  const root = makeBrain();
  const nick = (v: string, sw: string) => `  nickname: ${rec(v, "imsg:phonemsg-77").replace(" }", `, share_with: [${sw}] }`)}\n`;
  person(root, "people/kay", "Kay A", { created: "2026-09-01", facts: nick("Kiki", "planner, steward") });
  person(root, "people/kay-2", "Kay B", { facts: nick("SecretName", "steward") });
  commit(root);
  const p = pairWith(root, "people/kay-2");
  if (!p.blocked) mergeSamePerson(root, p.id);
  expect(JSON.stringify(seen(root, "planner", "people/kay") ?? {})).not.toContain("SecretName");
});

test("G171 a commit that only claims to be upkeep's repoint still blocks the undo", () => {
  const root = makeBrain();
  person(root, "people/j-roy", "Jay Roy", { phone: rec("(514) 555-0100", "gmail:f000000000000001") });
  const c = join(root, "projects/course-a.md");
  writeFileSync(c, readFileSync(c, "utf8").replace("Course logistics.", "Course logistics. TA is [[people/j-roy]]."));
  commit(root);
  const p = pairWith(root, "people/j-roy");
  mergeSamePerson(root, p.id);
  // An agent's commit dressed as upkeep's: the same subject and trailers, a real [[drop]] -> [[keep]]
  // repoint, plus its own change to the kept note. Undo must not swallow it as a repoint.
  writeFileSync(c, readFileSync(c, "utf8").replace("[[people/j-roy]]", "[[people/jane-roy]]"));
  const f = join(root, "people/jane-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("Coordinates", "Coordinates (planner was here)"));
  Bun.spawnSync(["git", "commit", "-qam", "reflect: repoint links in projects/course-a\n\nAgent: reflect\nKind: auto-fix"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "planner", GIT_AUTHOR_EMAIL: "planner@pocketbrain.local" } });
  expect(() => undoPersonMerge(root, p.id)).toThrow(/changed since the merge/);
  expect(readFileSync(f, "utf8")).toContain("planner was here");
});

// ---------- re-audit of the slice-audit fixes (G199, G200) ----------
const PH9 = rec("+15145550999", "imsg:phonemsg-90");
function famHelper(root: string) {
  edit(root, "rules/slices.yaml", (s) => s + "  fam:\n    tags: [family]\n");
  edit(root, "rules/policy.yaml", (s) => s.replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [fam]"));
}
function annBody(root: string, id: string, title: string, o: { tags?: string[]; created?: string; facts?: string; body?: string } = {}) {
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: personal\nsensitivity: personal\n${o.tags ? `tags: [${o.tags.join(", ")}]\n` : ""}status: active\ncreated: ${o.created ?? "2026-10-03"}\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${PH9}] }\n${o.facts ?? ""}---\n${o.body ?? "A person."}\n`);
}

test("G199 a hidden attribute whose value equals one already shown under another attribute still blocks the merge", () => {
  const root = makeBrain(); famHelper(root);
  const f = (a: string) => `  ${a}: ${rec("yes", "imsg:phonemsg-90")}\n`;
  annBody(root, "people/ann", "Ann Lee", { tags: ["family"], created: "2026-09-01", facts: f("vip") });
  annBody(root, "people/ann-2", "Ann Lee", { facts: f("hiv_positive") });
  commit(root);
  const p = pairWith(root, "people/ann-2");
  expect(p.blocked).toContain("helper sees one of these notes but not the other"); // vip shown, hiv_positive's note not
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  expect(seen(root, "helper", "people/ann")?.facts.hiv_positive).toBeUndefined();
});

test("G200 the dropped note's tag can't pull a kept note an agent can't see into its view (body, links, standing)", () => {
  const root = makeBrain(); famHelper(root);
  annBody(root, "people/ann", "Ann Lee", { created: "2026-09-01", body: "KEEPSECRET body text." });
  annBody(root, "people/ann-2", "Ann Lee", { tags: ["family"] });
  commit(root);
  expect(seen(root, "helper", "people/ann")).toBeUndefined();
  const p = pairWith(root, "people/ann-2");
  expect(p.keep).toBe("people/ann");
  expect(p.blocked).toBe("helper sees one of these notes but not the other (or not all of it); make their access the same first");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  expect(JSON.stringify(seen(root, "helper", "people/ann") ?? {})).not.toContain("KEEPSECRET");
});

test("G200 a standing that moves to the kept note on merge counts: an agent that can't read it today must not read it after", () => {
  const root = makeBrain(); famHelper(root);
  // Two notes alike in every fact and name; helper sees only the family-tagged one, and the owner
  // placed the other in standing. Keeping the tagged note would move that standing into helper's view.
  annBody(root, "people/ann", "Ann Lee", { tags: ["family"], created: "2026-09-01" });
  annBody(root, "people/ann-2", "Ann Lee");
  writeFileSync(join(root, "rules", "standing.yaml"), "people:\n  people/ann-2: { tier: inner, note_created: '2026-10-03' }\n");
  commit(root);
  const p = pairWith(root, "people/ann-2");
  expect(p.keep).toBe("people/ann-2"); // the note with standing is kept by default
  expect(p.blocked).toContain("helper sees one of these notes"); // helper sees ann, not ann-2
  expect(p.swap_blocked).toContain("helper sees one of these notes");
  expect(() => mergeSamePerson(root, p.id, { swap: true })).toThrow(/can't merge here/);
  expect(seen(root, "helper", "people/ann")?.standing).toBeUndefined();
});

// ---------- round-3 audit (G204-G206): a merge needs every assistant to see both notes the same way ----------
const JPHONE = `{ value: "(514) 555-0100", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }`;
function clinic(root: string) {
  writeFileSync(join(root, "people/j-roy.md"), `---\nid: people/j-roy\ntype: person\ntitle: Jay Roy\naliases: [Jaybird Nightshade]\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-03\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${JPHONE}] }\n---\nA person.\n`);
  writeFileSync(join(root, "projects/clinic.md"), `---\nid: projects/clinic\ntype: project\ntitle: Clinic\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nSaw Jaybird Nightshade at the oncology clinic. Drove [[people/j-roy]] to chemo.\n`);
  commit(root);
}

test("G204 G205 a private note can't merge into one an agent sees: its alias stays scrubbed and its links stay [[redacted]]", () => {
  const root = makeBrain();
  clinic(root);
  const before = seen(root, "helper", "projects/clinic")!.body!;
  expect(before).not.toContain("Jaybird Nightshade");
  expect(before).toContain("Drove [[redacted]]");
  const p = pairWith(root, "people/j-roy");
  expect(p.blocked).toContain("helper");
  expect(p.blocked).toMatch(/see one of these notes but not the other \(or not all of it\); make their access the same first$/);
  expect(p.swap_blocked).toBeDefined();
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  upkeep(root);
  expect(seen(root, "helper", "projects/clinic")!.body).toBe(before);
});

test("G204 defence in depth: a merged note's held-back alias is still scrubbed from other notes", () => {
  const root = makeBrain();
  clinic(root);
  // As if an earlier merge had held the alias back: j-roy is a pointer into jane-roy.
  const f = join(root, "people/j-roy.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("status: active", "status: merged\nmerged_into: people/jane-roy"));
  commit(root);
  expect(seen(root, "helper", "projects/clinic")!.body).not.toContain("Jaybird Nightshade");
});

test("G206 a merge that would open a dispute needs the resolver to see both notes whole", () => {
  const root = makeBrain();
  const D = (v: string) => `  diagnosis: { value: "${v}", as_of: 2026-09-01, sources: ["imsg:phonemsg-77"], verification: verified-by-source, by: steward, recorded: 2026-10-01 }\n`;
  edit(root, "rules/slices.yaml", (s) => s + "  workx:\n    areas: [work]\n    exclude_attributes: [diagnosis]\n");
  edit(root, "rules/policy.yaml", (s) => s.replace("slices: [area:work, contacts-basic], exclude_types: [money] }\n  # Keeps", "slices: [workx], exclude_types: [money] }\n  # Keeps").replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [workx]").replace("resolver: steward", "resolver: planner"));
  edit(root, "people/jane-roy.md", (s) => s.replace("facts:\n", "facts:\n" + D("Asthma")));
  writeFileSync(join(root, "people/j-roy.md"), `---\nid: people/j-roy\ntype: person\ntitle: Jay Roy\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-03\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${JPHONE}] }\n${D("Type 1 diabetes")}---\nA person.\n`);
  commit(root);
  const p = pairWith(root, "people/j-roy");
  expect(p.blocked).toMatch(/^planner(, planner \(reader token\))? see/);
  expect(p.blocked).toContain("make their access the same first");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  expect(JSON.stringify(listDisputes(root, "planner"))).not.toContain("diabetes");
});

test("ordinary merges still go through: two work notes, or two personal ones, nothing private, the same phone", () => {
  const root = makeBrain();
  person(root, "people/j-roy", "Jay Roy", { phone: rec("(514) 555-0100", "gmail:f000000000000001") });
  commit(root);
  const p = pairWith(root, "people/j-roy");
  expect(p.blocked).toBeUndefined();
  expect(mergeSamePerson(root, p.id)).toContain("merged people/j-roy into people/jane-roy");

  const r2 = makeBrain();
  const ph = rec("+15145550999", "imsg:phonemsg-90");
  person(r2, "people/ann", "Ann Lee", { area: "personal", created: "2026-09-01", phone: ph });
  person(r2, "people/ann-2", "Ann L.", { area: "personal", phone: ph });
  commit(r2);
  const q = pairWith(r2, "people/ann-2");
  expect(q.blocked).toBeUndefined();
  expect(mergeSamePerson(r2, q.id)).toContain("merged people/ann-2 into people/ann");
});

// ---------- round-4 audit (G217-G219) ----------
const samLee = (root: string, id: string, sens: string, extra = "") => writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: Sam Lee\narea: personal\nsensitivity: ${sens}\nstatus: active\ncreated: 2026-10-0${sens === "private" ? 4 : 2}\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${rec("+15145550199", "imsg:x-1")}] }\n${extra}---\nbody\n`);
const zNote = (root: string, body: string) => writeFileSync(join(root, "projects/z-note.md"), `---\nid: projects/z-note\ntype: project\ntitle: Z note\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-03\nupdated: 2026-10-03\nby: planner\n---\n${body}\n`);

test("G217 a merged note's values stay scrubbed for an agent that sees neither note", () => {
  const root = makeBrain();
  policy(root, (s) => s.replaceAll("slices: [area:work, contacts-basic]", "slices: [area:work]"));
  samLee(root, "people/sam-lee", "personal");
  samLee(root, "people/sam-lee-2", "private", `  home_address: ${rec("12 Hidden Lane", "imsg:x-2")}\n`);
  zNote(root, "Courier dropped the box at 12 Hidden Lane.");
  commit(root);
  const body = () => seen(root, "helper", "projects/z-note")!.body!;
  expect(body()).not.toContain("Hidden Lane");
  const p = pairWith(root, "people/sam-lee-2");
  if (!p.blocked) mergeSamePerson(root, p.id);
  expect(body()).not.toContain("Hidden Lane");
});

test("G217 defence in depth: a merged pointer whose target is kept from the agent keeps its values carved", () => {
  const root = makeBrain();
  policy(root, (s) => s.replaceAll("slices: [area:work, contacts-basic]", "slices: [area:work]"));
  samLee(root, "people/sam-lee", "private"); // above helper's ceiling: kept out on purpose
  samLee(root, "people/sam-lee-2", "personal", `  home_address: ${rec("12 Hidden Lane", "imsg:x-2")}\n`);
  edit(root, "people/sam-lee-2.md", (s) => s.replace("status: active", "status: merged\nmerged_into: people/sam-lee"));
  zNote(root, "Courier dropped the box at 12 Hidden Lane.");
  commit(root);
  expect(seen(root, "helper", "projects/z-note")!.body).not.toContain("Hidden Lane");
});

test("G218 a reader token counts as its own viewer: a private note can't merge into one a reader sees", () => {
  const root = makeBrain();
  policy(root, (s) => s.replace(/^\s*helper:.*$/m, ""));
  writeFileSync(join(root, "people/j-roy.md"), `---\nid: people/j-roy\ntype: person\ntitle: Jane Roy\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-03\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${rec("+15145550100", "imsg:x-1")}] }\n---\nprivate body\n`);
  zNote(root, "The clinic referral is for [[people/j-roy]].");
  commit(root);
  const r = () => withTokenRole("planner", "reader", () => JSON.stringify(readNote(root, "planner", "projects/z-note")));
  const before = r();
  expect(before).toContain("[[redacted]]");
  const p = pairWith(root, "people/j-roy");
  expect(p.blocked).toContain("planner (reader token)");
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  upkeep(root);
  expect(r()).toBe(before);
});

test("G219 the slices must leave the same attributes out of both notes", () => {
  const root = makeBrain();
  edit(root, "rules/slices.yaml", (s) => s + "  old-people:\n    types: [people]\n    until: 2026-06-01\n    exclude_attributes: [home_address]\n");
  policy(root, (s) => s.replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [area:work, old-people]"));
  const cy = (id: string, created: string, extra = "") => writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: person\ntitle: Cy D\narea: work\nsensitivity: personal\nstatus: active\ncreated: ${created}\nupdated: 2026-10-03\nby: planner\nfacts:\n  phones: { items: [${rec("+15145550166", "imsg:x-1")}] }\n${extra}---\nbody\n`);
  cy("people/cy-d", "2026-09-01");
  cy("people/cy-d-old", "2026-01-01", `  home_address: ${rec("9 Quiet Rd", "imsg:a")}\n`);
  commit(root);
  const notes = loadBrain(root), rules = loadRules(root);
  const k = notes.find((n) => n.fm.id === "people/cy-d")!, d = notes.find((n) => n.fm.id === "people/cy-d-old")!;
  expect(carveParity(rules, k, d)).toContain("helper");
  expect(carveParity(rules, d, k)).toContain("helper");
});

// ---------- round-5 audit (G226, G227, accurate refusal) ----------
afterEach(() => stopFga());
const fgaYaml = (root: string) => writeFileSync(join(root, "rules/fga.yaml"), "api_url: http://127.0.0.1:9\nstore_id: st1\nrefresh_s: 3600\nmax_age_s: 3600\n");
const fgaFake = (canRead: (agent: string) => string[]) => ({ canRead: async (a: string) => new Set(canRead(a)) }) as unknown as FgaClient;

test("G226 a stale OpenFGA copy refuses the merge instead of reading as 'sees neither'", async () => {
  const root = makeBrain();
  person(root, "people/j-roy", "Jay Roy", { phone: rec("(514) 555-0100", "gmail:f000000000000001") });
  fgaYaml(root);
  commit(root);
  expect(pairWith(root, "people/j-roy").blocked).toBeUndefined(); // FGA off: an ordinary merge
  // OpenFGA down from the start: no agent outside the wall has a fresh entry.
  await startFga(root, new FgaClient({ api_url: "http://127.0.0.1:9", store_id: "st1" }, (async () => { throw new Error("down"); }) as unknown as typeof fetch));
  const p = pairWith(root, "people/j-roy");
  expect(p.blocked).toMatch(/^OpenFGA hasn't confirmed lately what .*helper.* may read/);
  expect(p.swap_blocked).toBe(p.blocked);
  refused(root, p.id);
});

test("G226 a partial OpenFGA copy (a slice policy.yaml grants, not confirmed) refuses too; a full one doesn't", async () => {
  const root = makeBrain();
  person(root, "people/j-roy", "Jay Roy", { phone: rec("(514) 555-0100", "gmail:f000000000000001") });
  fgaYaml(root);
  commit(root);
  const rules = loadRules(root);
  const full = (a: string) => rules.policy.agents[a]?.slices ?? [];
  await startFga(root, fgaFake(full));
  expect(pairWith(root, "people/j-roy").blocked).toBeUndefined();
  stopFga();
  await startFga(root, fgaFake((a) => a === "helper" ? ["area:work"] : full(a)));
  const p = pairWith(root, "people/j-roy");
  expect(p.blocked).toMatch(/^OpenFGA hasn't confirmed lately what helper may read/);
  refused(root, p.id);
});

test("G227 merging two notes an agent never reads leaves its view alone: no [withheld] in its own titles", () => {
  const root = makeBrain();
  policy(root, (s) => s.replace("planner: { tier: core, aliases: [Planbot], slices: [area:work, contacts-basic]", "planner: { tier: core, aliases: [Planbot], slices: [area:work]"));
  person(root, "people/kim", "Kim Diaz", { area: "personal", created: "2026-10-01" });
  person(root, "people/kd", "K. Diaz", { area: "personal" });
  edit(root, "people/kd.md", (s) => s.replace("title: K. Diaz\n", "title: K. Diaz\naliases: [Kimberly Zed]\n"));
  writeFileSync(join(root, "projects/lunch.md"), `---\nid: projects/lunch\ntype: project\ntitle: Lunch with Kimberly Zed\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-02\nupdated: 2026-10-02\nby: planner\n---\nPlan lunch with Kimberly Zed.\n`);
  commit(root);
  const view = () => { const rules = loadRules(root); const res = carve(loadBrain(root), rules, grantFor(rules, "planner")); return { title: res.visible.get("projects/lunch")?.note.fm.title, carved: res.carvedValues.includes("Kimberly Zed") }; };
  const before = view();
  expect(before).toEqual({ title: "Lunch with Kimberly Zed", carved: false });
  const p = samePersonProposals(root).find((x) => x.keep === "people/kim")!;
  expect(p.blocked).toBeUndefined();
  mergeSamePerson(root, p.id);
  expect(loadBrain(root).find((n) => n.fm.id === "people/kd")!.fm.status).toBe("merged");
  expect(view()).toEqual(before);
  expect(JSON.stringify(seen(root, "planner", "projects/lunch"))).toContain("Plan lunch with Kimberly Zed.");
});

// Live, 2026-10-31 (G569): the owner's two pages for himself were refused because one holds a fact
// some assistants can't see, with "the owner can merge these by hand later" and no way to. A fact
// hidden by its own flags (private above a ceiling, share_with) keeps those flags on the merged
// note, and a combined record only tightens (planMerge), so it stays hidden from exactly the
// assistants it was hidden from; the rendered checks (mergeLeaks, brainChanges) still decide.
const hiddenFrom = (root: string, id: string, attr: string) => {
  const rules = loadRules(root), out: string[] = [];
  for (const agent of Object.keys(rules.policy.agents ?? {})) for (const role of [undefined, "reader" as const]) {
    const res = withTokenRole(agent, role, () => carve(loadBrain(root), rules, grantFor(rules, agent), { flags: false }));
    const v = res.visible.get(id);
    if (!v || res.hiddenFacts.some((h) => h.key === `${id}#${attr}`) || !v.note.fm.facts?.[attr]) out.push(`${agent}${role ? " (reader)" : ""}`);
  }
  return out.sort();
};
for (const [kind, flag] of [["private", "sensitivity: private"], ["share_with", "share_with: [steward]"], ["held", "unseen: true"]] as const) {
  test(`G569 a ${kind} fact no longer blocks the pair: it merges and stays hidden from exactly the same assistants`, () => {
    const root = makeBrain();
    person(root, "people/j-roy", "Jay Roy", { facts: `  home: { value: "12 Elm St", as_of: 2026-09-01, sources: ["imsg:phonemsg-78"], verification: verified-by-source, by: planner, recorded: 2026-10-01, ${flag} }\n` });
    commit(root);
    const before = hiddenFrom(root, "people/j-roy", "home");
    expect(before.length).toBeGreaterThan(0);
    const p = pairWith(root, "people/j-roy");
    expect(p.blocked).toBeUndefined();
    mergeSamePerson(root, p.id);
    const keep = p.keep;
    expect(loadBrain(root).find((n) => n.fm.id === p.drop)!.fm.status).toBe("merged");
    expect(hiddenFrom(root, keep, "home")).toEqual(before);
    for (const agent of before.filter((a) => !a.includes("reader"))) expect(JSON.stringify(seen(root, agent, keep) ?? "")).not.toContain("12 Elm St");
  });
}

// ---------- round-6 audit (G246, G247) ----------
const JR = rec("+15145550100", "gmail:f000000000000001"); // Jane's own phone and ref: upkeep's recheck leaves it alone
const fmOf = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!.fm;

test("G246 a chained merge (A into B, then B into C) keeps A's names shown on C: no [withheld], no tripwire on the agent's own write", () => {
  const root = makeBrain();
  person(root, "people/jay-roy", "Jay Roy", { created: "2026-10-05", phone: JR });
  edit(root, "people/jay-roy.md", (s) => s.replace("title: Jay Roy\n", "title: Jay Roy\naliases: [Jaybird Roy]\n"));
  commit(root);
  mergeSamePerson(root, pairWith(root, "people/jay-roy").id);
  person(root, "people/j-roy-c", "J. Roy", { created: "2026-09-01", phone: JR });
  commit(root);
  const p2 = pairWith(root, "people/j-roy-c");
  expect([p2.keep, p2.drop]).toEqual(["people/j-roy-c", "people/jane-roy"]);
  expect(p2.blocked).toBeUndefined();
  mergeSamePerson(root, p2.id);
  // The earlier pointer now points at the note that stays, in the same commit.
  expect(fmOf(root, "people/jay-roy").merged_into).toBe("people/j-roy-c");
  const rules = loadRules(root);
  const res = carve(loadBrain(root), rules, grantFor(rules, "planner"), { flags: false });
  expect(res.visible.get("people/j-roy-c")!.note.fm.aliases).toContain("Jaybird Roy");
  expect(res.carvedValues).not.toContain("Jaybird Roy");
  const w = remember(root, "planner", { id: "projects/course-a", attribute: "next_step", value: "Call Jaybird Roy", as_of: "2026-10-03", sources: ["gmail:f000000000000001"] });
  expect(w.outcome).not.toBe("refused");
});

test("G246 undo of the second merge in a chain puts the earlier pointer back on the note it merged into", () => {
  const root = makeBrain();
  person(root, "people/jay-roy", "Jay Roy", { created: "2026-10-05", phone: JR });
  commit(root);
  mergeSamePerson(root, pairWith(root, "people/jay-roy").id);
  person(root, "people/j-roy-c", "J. Roy", { created: "2026-09-01", phone: JR });
  commit(root);
  const p2 = pairWith(root, "people/j-roy-c");
  mergeSamePerson(root, p2.id);
  expect(fmOf(root, "people/jay-roy").merged_into).toBe("people/j-roy-c");
  expect(undoPersonMerge(root, p2.id)).toContain("undid the merge of people/jane-roy into people/j-roy-c");
  expect(fmOf(root, "people/jay-roy").merged_into).toBe("people/jane-roy");
  expect(fmOf(root, "people/jane-roy").status).toBe("active");
});

test("G246 a hand-edited pointer in a chain blocks the undo like any later change", () => {
  const root = makeBrain();
  person(root, "people/jay-roy", "Jay Roy", { created: "2026-10-05", phone: JR });
  commit(root);
  mergeSamePerson(root, pairWith(root, "people/jay-roy").id);
  person(root, "people/j-roy-c", "J. Roy", { created: "2026-09-01", phone: JR });
  commit(root);
  const p2 = pairWith(root, "people/j-roy-c");
  mergeSamePerson(root, p2.id);
  edit(root, "people/jay-roy.md", (s) => s.trimEnd() + "\nA hand note.\n");
  commit(root);
  expect(() => undoPersonMerge(root, p2.id)).toThrow(/changed since the merge/);
});

test("G247 a merge never newly withholds a name or value an agent reads in other notes today", () => {
  const root = makeBrain();
  // scout reads vip-tagged notes, Jane Roy excluded by name; Jay Roy carries no tag. scout sees neither.
  policy(root, (s) => s.replace("tiers:", "  scout: { tier: core, slices: [vip], exclude: [people/jane-roy] }\ntiers:"));
  edit(root, "rules/slices.yaml", (s) => s + "  vip:\n    tags: [vip]\n");
  edit(root, "people/jane-roy.md", (s) => s.replace("area: work\n", "area: work\ntags: [vip]\n"));
  person(root, "people/jay-roy", "Jay Roy", { created: "2026-10-05", phone: JR, facts: `  email: ${rec("jroy@example.org", "gmail:f000000000000009")}\n` });
  writeFileSync(join(root, "projects/vip-list.md"), `---\nid: projects/vip-list\ntype: project\ntitle: VIP list\narea: work\nsensitivity: personal\ntags: [vip]\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nInvite Jay Roy (jroy@example.org).\n`);
  commit(root);
  const body = () => seen(root, "scout", "projects/vip-list")!.body;
  expect(body()).toBe("Invite Jay Roy (jroy@example.org).\n");
  const p = pairWith(root, "people/jay-roy");
  expect(p.keep).toBe("people/jane-roy");
  expect(p.blocked).toMatch(/^scout(, scout \(reader token\))? would find names or values of these notes newly \[withheld\] in notes (it reads|they read) today/);
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  expect(mergeNotes(root, "people/jane-roy", "people/jay-roy").ok).toBe(false);
  expect(body()).toBe("Invite Jay Roy (jroy@example.org).\n");
});

// ---------- round-7 audit (G261, G262) ----------
// Jane's org "Café Roy" and Jay's "Cafe Roy" are equal under compareKey, so the merge keeps one
// spelling; a private note's alias "Cafe Roy" would then stop counting as shown to helper.
function cafe(root: string) {
  edit(root, "people/jane-roy.md", (s) => s.replace("  phones:", `  org: ${rec("Café Roy", "gmail:f000000000000001")}\n  phones:`));
  person(root, "people/jay-roy", "Jay Roy", { created: "2026-10-05", phone: JR, facts: `  org: ${rec("Cafe Roy", "gmail:f000000000000002")}\n` });
  writeFileSync(join(root, "projects/cafe-deal.md"), `---\nid: projects/cafe-deal\ntype: project\ntitle: The deal\naliases: [Cafe Roy]\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nPrivate.\n`);
  writeFileSync(join(root, "projects/lunch.md"), `---\nid: projects/lunch\ntype: project\ntitle: Lunch\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nLunch at Cafe Roy on Friday.\n`);
  commit(root);
}

test("G261 a merge that keeps one of two spellings of a shown value is refused when another note holds the other", () => {
  const root = makeBrain();
  cafe(root);
  const body = () => seen(root, "helper", "projects/lunch")!.body;
  expect(body()).toBe("Lunch at Cafe Roy on Friday.\n");
  const p = pairWith(root, "people/jay-roy");
  expect(p.blocked).toContain("helper");
  expect(p.blocked).toContain(`the merge keeps one spelling of "cafe roy", which other notes also hold`);
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  expect(body()).toBe("Lunch at Cafe Roy on Friday.\n");
});

test("G261 backstop: a whole-brain carve before and after names every agent whose withheld set would change, and no other", () => {
  const root = makeBrain();
  cafe(root);
  const notes = loadBrain(root), rules = loadRules(root);
  const n = (id: string) => notes.find((x) => x.fm.id === id)!;
  const r = merge.brainChanges(rules, notes, n("people/jane-roy"), n("people/jay-roy"))!;
  expect(r).toMatch(/^(.*, )?helper(, .*)? would find other notes changed/);
  expect(r).not.toMatch(/(^|, )steward(,| would)/); // steward reads the deal note, so nothing changes for it
  // An ordinary pair changes nothing anywhere.
  const r2 = makeBrain();
  person(r2, "people/jay-roy", "Jay Roy", { created: "2026-10-05", phone: JR });
  commit(r2);
  const notes2 = loadBrain(r2);
  expect(merge.brainChanges(loadRules(r2), notes2, notes2.find((x) => x.fm.id === "people/jane-roy")!, notes2.find((x) => x.fm.id === "people/jay-roy")!)).toBeUndefined();
});

test("G262 a merge whose commit fails puts the earlier pointer back too", () => {
  const root = makeBrain();
  person(root, "people/jay-roy", "Jay Roy", { created: "2026-10-05", phone: JR });
  commit(root);
  mergeSamePerson(root, pairWith(root, "people/jay-roy").id);
  person(root, "people/j-roy-c", "J. Roy", { created: "2026-09-01", phone: JR });
  commit(root);
  const p2 = pairWith(root, "people/j-roy-c");
  expect(p2.blocked).toBeUndefined();
  const hooks = join(root, ".hooks-fail");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(hooks, "pre-commit"), 0o755);
  Bun.spawnSync(["git", "config", "core.hooksPath", hooks], { cwd: root });
  expect(() => mergeSamePerson(root, p2.id)).toThrow();
  expect(Bun.spawnSync(["git", "status", "--porcelain", "--", "people"], { cwd: root }).stdout.toString()).toBe("");
  expect(fmOf(root, "people/jay-roy").merged_into).toBe("people/jane-roy");
  // The plain merge says so too, and leaves nothing behind.
  const r = mergeNotes(root, "people/j-roy-c", "people/jane-roy");
  expect(r).toMatchObject({ ok: false, message: "the merge wasn't saved; nothing changed" });
  expect(Bun.spawnSync(["git", "status", "--porcelain", "--", "people"], { cwd: root }).stdout.toString()).toBe("");
});

// ---------- round-8 audit (G265, G266) ----------
// A private project's alias "Jaylen Fournier Holdings": while helper sees "Jaylen Fournier" as a
// title, those words count as shown and the alias withholds only itself; once the title is only an
// alias of Jane Roy, the word-pair needle withholds helper's whole lunch line.
function holdco(root: string) {
  person(root, "people/jaylen-fournier", "Jaylen Fournier", { created: "2026-10-05", phone: JR });
  writeFileSync(join(root, "projects/holdco.md"), `---\nid: projects/holdco\ntype: project\ntitle: The holdco\naliases: [Jaylen Fournier Holdings]\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nPrivate.\n`);
  writeFileSync(join(root, "projects/lunch.md"), `---\nid: projects/lunch\ntype: project\ntitle: Lunch\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nLunch with Jaylen Fournier on Friday.\n`);
  commit(root);
}

test("G265 a dropped title that would be only an alias can't make another note's line [withheld]: the card says why", () => {
  const root = makeBrain();
  holdco(root);
  const body = () => seen(root, "helper", "projects/lunch")!.body;
  expect(body()).toBe("Lunch with Jaylen Fournier on Friday.\n");
  const p = pairWith(root, "people/jaylen-fournier");
  expect(p.blocked).toContain("helper");
  expect(p.blocked).toContain(`Jaylen Fournier would be only a name on Jane Roy, so "jaylen", "fournier" would no longer count as shown`);
  expect(() => mergeSamePerson(root, p.id)).toThrow(/can't merge here/);
  expect(body()).toBe("Lunch with Jaylen Fournier on Friday.\n");
});

test("G265 backstop: the whole-brain check compares what each agent reads, so it names helper here too", () => {
  const root = makeBrain();
  holdco(root);
  const notes = loadBrain(root), rules = loadRules(root);
  const n = (id: string) => notes.find((x) => x.fm.id === id)!;
  expect(merge.brainChanges(rules, notes, n("people/jane-roy"), n("people/jaylen-fournier"))).toMatch(/(^|, )helper(,| would)/);
});

test("G266 after a merge, a link to the dropped note shows the kept note to an agent that sees it, on the view and in its cell", () => {
  const root = makeBrain();
  policy(root, (s) => s.replace("helper: { tier: trial, slices: [area:work, contacts-basic]", "helper: { tier: trial, slices: [area:work]"));
  person(root, "people/p-77", "Jay Roy", { created: "2026-10-05", phone: JR });
  writeFileSync(join(root, "projects/lunch.md"), `---\nid: projects/lunch\ntype: project\ntitle: Lunch\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nSee [[people/p-77]].\n`);
  commit(root);
  expect(seen(root, "helper", "projects/lunch")!.body).toBe("See [[people/p-77]].\n");
  mergeSamePerson(root, pairWith(root, "people/p-77").id);
  expect(readFileSync(join(root, "projects/lunch.md"), "utf8")).toContain("[[people/p-77]]"); // not repointed yet
  for (const cells of [false, true]) {
    useCells(cells);
    try { expect(seen(root, "helper", "projects/lunch")!.body, `cells ${cells}`).toBe("See [[people/jane-roy]].\n"); } finally { useCells(false); }
  }
  // Once Jane Roy leaves helper's view, the link is [[redacted]] again, also in a cell updated in
  // place (the id shares no word with a carved value, so only the pointer's target reaches the note).
  useCells(true);
  try {
    seen(root, "helper", "projects/lunch");
    edit(root, "people/jane-roy.md", (s) => s.replace("area: work", "area: personal")); // out of helper's slice: the cell updates in place, nothing newly carved
    commit(root);
    expect(seen(root, "helper", "projects/lunch")!.body).toBe("See [[redacted]].\n");
    // The cell file itself never keeps the id of a note out of the slice (invariant 10).
    expect(readFileSync(join(cellDir(root, "helper"), "projects/lunch.md"), "utf8")).not.toContain("people/jane-roy");
  } finally { useCells(false); }
  expect(seen(root, "helper", "projects/lunch")!.body).toBe("See [[redacted]].\n");
});
