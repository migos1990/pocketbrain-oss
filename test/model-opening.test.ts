// SPDX-License-Identifier: AGPL-3.0-only
// The owner, 2026-11-07, typed yes: a model may write a short opening paragraph that ties a page's
// facts together. The Gardener sends it with wiki_sync; the hub takes it only when it rewords the
// page's own cited sentences, names each one it rests on, and says no name, number or word those
// sentences don't (G713). It sits on top of the hub's block, under the owner's own text, and goes
// whole from a reader once any fact behind it is hidden from them (G714). Report-only until the
// owner turns it on.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { renderTouchedPages, openingProblem } from "../src/wiki";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { readNote, gardenerWikiSync, gardenerLast, changesSince } from "../src/core";
import { setWikiOpening, setWikiSync } from "../src/ownerset";
import { buildCell, cellDir } from "../src/cell";
import { readdirSync } from "node:fs";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const SINCE = "2000-01-01T00:00:00Z";
const ORG = "orgs/north-college";
const body = (root: string) => readFileSync(join(root, `${ORG}.md`), "utf8").split(/^---$/m).slice(2).join("---");
const read = (root: string, agent: string) => (readNote(root, agent, ORG) as { body: string }).body;
const fact = (value: string, mail: string) => `{ value: "${value}", as_of: 2026-10-05, sources: ["gmail:${mail}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;
const head = (id: string, type: string, title: string) => `---\nid: ${id}\ntype: ${type}\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;
const OPENING = "You work as a lecturer at North College, alongside your colleagues Ana Diaz and Ben Roy and your student Cara Lee.";
const LABELS = ["p-at-robin-vale", "p-in-robin-vale", "p-at-ana-diaz", "p-in-ana-diaz", "p-at-ben-roy", "p-in-ben-roy", "p-at-cara-lee", "p-in-cara-lee"];

function brain(o: { on?: boolean; own?: string } = {}) {
  const root = makeBrain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  if (o.on) { const p = YAML.parse(readFileSync(policy, "utf8")); p.wiki = { ...(p.wiki ?? {}), opening: true }; writeFileSync(policy, YAML.stringify(p)); }
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, `${ORG}.md`), `${head(ORG, "org", "North College")}---\n${o.own ? `${o.own}\n` : ""}`);
  writeFileSync(join(root, "people", "robin-vale.md"), `${head("people/robin-vale", "person", "Robin Vale")}facts:\n  role: ${fact("lecturer", "f0000000000000b0")}\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b0")}\n---\n`);
  writeFileSync(join(root, "people", "ana-diaz.md"), `${head("people/ana-diaz", "person", "Ana Diaz")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b1")}\n  relationship: ${fact("colleague", "f0000000000000b1")}\n---\n`);
  writeFileSync(join(root, "people", "ben-roy.md"), `${head("people/ben-roy", "person", "Ben Roy")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b2")}\n  relationship: ${fact("colleague", "f0000000000000b2")}\n---\n`);
  writeFileSync(join(root, "people", "cara-lee.md"), `${head("people/cara-lee", "person", "Cara Lee")}facts:\n  org: ${fact("[[orgs/north-college]]", "f0000000000000b3")}\n  relationship: ${fact("student", "f0000000000000b3")}\n---\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: the college");
  renderTouchedPages(root, SINCE);
  return root;
}
const atNight = <T>(f: () => T): T => {
  const was = process.env.PB_NOW;
  process.env.PB_NOW = "2026-10-08T07:30:00Z";
  try { return f(); } finally { if (was === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = was; }
};
const sync = (root: string, text = OPENING, labels = LABELS) => atNight(() => gardenerWikiSync(root, "gardener", { id: ORG, opening: { text, labels } }));

test("G713 report-only: the Gardener's opening is checked and reported, and the page is unchanged", () => {
  const root = brain();
  const before = body(root);
  const r = sync(root) as { applied: boolean; would: string[]; why?: string };
  expect(r.applied).toBe(false);
  expect(r.would.join(" ")).toContain("opening paragraph");
  expect(r.why).toContain("report-only");
  expect(body(root)).toBe(before);
});

test("G713 on: the opening opens the hub's text, cited by the sentences it rests on, and the next rewrite keeps it", () => {
  const root = brain({ on: true });
  expect((sync(root) as { applied: boolean }).applied).toBe(true);
  const b = body(root).trim();
  expect(b.split("\n")[0]).toBe(`${OPENING}${LABELS.map((l) => `[^${l}]`).join("")}`);
  // The fact sentences it rewords are still there, under it.
  expect(b).toContain("You work as a lecturer at North College.");
  expect(b).toContain("work at North College: your colleagues.");
  expect(loadBrain(root).find((n) => n.fm.id === ORG)!.fm.opening).toMatchObject({ text: OPENING, by: "gardener" });
  // A later run of the page writer writes the same page.
  sh(root, "planner", "commit", "-q", "--allow-empty", "-m", "planner: nothing");
  renderTouchedPages(root, SINCE);
  expect(body(root).trim()).toBe(b);
});

test("G713 the owner's own text stays on top; the opening goes under it, first in the hub's block", () => {
  const root = brain({ on: true, own: "My notes on the college." });
  sync(root);
  const b = body(root).trim();
  expect(b.startsWith("My notes on the college.")).toBe(true);
  expect(b).toContain(`## From its facts\n${OPENING}`);
});

test("G713 a word, name or number no cited sentence holds is refused, and so is a sentence the page doesn't have", () => {
  const root = brain({ on: true });
  // "teach" is no word of the sentences it cites: the lead says lecturer, not what he does there.
  expect(() => sync(root, "You teach at North College, alongside your colleagues Ana Diaz and Ben Roy.")).toThrow(/teach/);
  expect(() => sync(root, "You work as a lecturer at North College with your colleague Zoe Park.")).toThrow(/Zoe/);
  expect(() => sync(root, "You work as a lecturer at North College since 2019.")).toThrow(/2019/);
  expect(() => sync(root, OPENING, [...LABELS, "p-at-dan-poe"])).toThrow(/p-at-dan-poe/);
  // It ties facts together: one sentence's labels alone is just that sentence again.
  expect(() => sync(root, "You work as a lecturer at North College.", ["p-at-robin-vale", "p-in-robin-vale"])).toThrow(/two/);
  expect(() => sync(root, "One. Two. Three. Four.")).toThrow(/three sentences/);
  expect(() => sync(root, `${OPENING}[^p-at-ana-diaz]`)).toThrow(/reference/);
  expect(loadBrain(root).find((n) => n.fm.id === ORG)!.fm.opening).toBeUndefined();
});

test("G714 a reader from whom one fact behind the opening is hidden gets none of it; the rest of the page stays", () => {
  const root = brain({ on: true });
  sync(root);
  expect(read(root, "helper")).toContain(OPENING);
  const n = loadBrain(root).find((x) => x.fm.id === "people/cara-lee")!;
  (n.fm.facts!.relationship as FactRecord).sensitivity = "private";
  saveNote(root, n);
  sh(root, "owner", "commit", "-qam", "owner: Cara's tie private");
  const b = read(root, "helper");
  expect(b).not.toContain("alongside");
  expect(b).not.toContain("your student");
  expect(b).toContain("work at North College: your colleagues.");
  // A reader who still sees it keeps it.
  expect(read(root, "planner")).toContain(OPENING);
});

test("G714 once a fact behind it is hidden from some reader, the page writer leaves the opening out", () => {
  const root = brain({ on: true });
  sync(root);
  const n = loadBrain(root).find((x) => x.fm.id === "people/cara-lee")!;
  (n.fm.facts!.relationship as FactRecord).sensitivity = "private";
  saveNote(root, n);
  sh(root, "owner", "commit", "-qam", "owner: Cara's tie private");
  renderTouchedPages(root, SINCE);
  expect(body(root)).not.toContain("alongside");
});

test("G713 the Gardener's work list names a page that says two or more things and has no opening yet", () => {
  const root = brain({ on: true });
  expect(atNight(() => gardenerLast(root, "gardener").openings_due)).toContain(ORG);
  sync(root);
  expect(atNight(() => gardenerLast(root, "gardener").openings_due)).not.toContain(ORG);
});

test("G713 wiki opening on|off is its own switch: it leaves wiki sync as it was", () => {
  const root = brain();
  setWikiSync(root, "on");
  setWikiOpening(root, "on");
  const p = YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8"));
  expect(p.wiki).toEqual({ sync: true, opening: true });
  setWikiSync(root, "off");
  expect(YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).wiki).toEqual({ sync: false, opening: true });
});

test("G714 no agent's cell holds the opening outside the page's text: only the read decides who gets it", () => {
  const root = brain({ on: true });
  sync(root);
  const n = loadBrain(root).find((x) => x.fm.id === "people/cara-lee")!;
  (n.fm.facts!.relationship as FactRecord).sensitivity = "private";
  saveNote(root, n);
  sh(root, "owner", "commit", "-qam", "owner: Cara's tie private");
  for (const agent of ["helper", "planner", "gardener"]) {
    buildCell(root, agent);
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]);
    for (const f of files(cellDir(root, agent))) expect(readFileSync(f, "utf8")).not.toMatch(/^opening:/m);
  }
  expect(atNight(() => gardenerLast(root, "gardener").openings_due)).not.toContain(ORG);
});

// Audit v13 (G760): the check was a bag of words, so a false sentence built from the page's own
// words landed and was served ("…, where you are your manager", "You are not the director…"). Now
// each part of the opening must be said by ONE of the sentences it cites, with the one it is about.
test("G760 a false sentence built from the page's own words is refused; the true rewording still lands", () => {
  const root = brain({ on: true });
  const all = LABELS;
  for (const text of [
    // The lecturer is the owner, not Ana: no one sentence says Ana and lecturer.
    "Ana Diaz works as a lecturer at North College, alongside your colleague Ben Roy.",
    // Negation, from words too short for the old check to look at.
    "You do not work as a lecturer at North College, alongside your colleagues Ana Diaz and Ben Roy.",
    "You work as a lecturer at North College, not alongside your colleagues Ana Diaz and Ben Roy.",
    // Who is whose: "you" and "your student" are two sentences' words.
    "You are your student at North College, alongside your colleagues Ana Diaz and Ben Roy.",
    // What one sentence says of the owner, hung on someone else by an "and".
    "Cara Lee is your student and work as a lecturer at North College, alongside Ana Diaz.",
    // A tie from another sentence, hung on the wrong person.
    "You work as a lecturer at North College, alongside your student Ana Diaz and Ben Roy.",
    // Slice audit: the page's own name said again is no "of whom".
    "Cara Lee works at North College and is your colleague at North College.",
    "Ana Diaz works at North College: your student at North College.",
    // Leaning on who came before holds across a full stop.
    "Ana Diaz works at North College. Also your student.",
    // A name in lower case is still that name: what follows leans on it.
    "ana diaz works at North College: your student.",
    "cara lee works at North College and is your colleague.",
    // A role word with a capital is no name in a list.
    "Ana Diaz works at North College, STUDENT.",
    "Ana Diaz, Student, works at North College.",
    "Ana Diaz works at North College and Student.",
    "Ana Diaz works at North College. Student.",
    "Cara Lee, Colleagues.",
    // A day nobody said.
    "You work as a lecturer at North College, Monday and Friday, alongside your colleagues Ana Diaz and Ben Roy.",
    // A tie in front of the names it isn't theirs.
    "Your student, Ana Diaz and Ben Roy work at North College.",
  ]) expect(() => sync(root, text, all), text).toThrow(/opening: .*(one of the sentences|in none of the sentences)/);
  expect(loadBrain(root).find((n) => n.fm.id === ORG)!.fm.opening).toBeUndefined();
  expect((sync(root) as { applied: boolean }).applied).toBe(true);
  // Reworded another true way.
  expect((sync(root, "Ana Diaz and Ben Roy work at North College, your colleagues, where you work as a lecturer.", ["p-at-robin-vale", "p-in-robin-vale", "p-at-ana-diaz", "p-in-ana-diaz", "p-at-ben-roy", "p-in-ben-roy"]) as { applied: boolean }).applied).toBe(true);
});

// Slice audit: a cited sentence's first word is capitalised whether or not it is a name ("Paid",
// "About"); in lower case it says of whom nothing, so the part still leans on who came before.
test("G760 a cited sentence's opening word in lower case doesn't make a part say of whom", () => {
  const lead = "You work as a lecturer at North College.[^a] Cara Lee works at North College.[^b] About it: tuition and grades.[^c] Paid by the college in full.[^d]";
  for (const text of [
    "Cara Lee works at North College, paid by the college in full.",
    "Cara Lee works at North College, about tuition and grades.",
    "You work as a lecturer at North College, paid by the college in full.",
    "cara works at North College and is paid by the college in full.",
    // The same with its capital kept: still no name.
    "Cara Lee works at North College, Paid by the college in full.",
    "Cara Lee works at North College: your student, Paid in full.",
    "Cara Lee works at North College, About tuition and grades.",
    "Cara Lee works at North College, the college paid in full.",
  ]) expect(openingProblem(text, ["a", "b", "c", "d"], lead, ["North College"], ["North College"]), text).toBeDefined();
});

// Audit v13 (G761): hiding a page the opening names (not a fact behind it) left the opening with
// the hidden person's surname and the hub's label of them; and the opening landed as two commits,
// so reverting the Gardener's left the paragraph in the page.
test("G761 a reader from whom a page the opening names is hidden gets none of the opening", () => {
  const root = brain({ on: true });
  sync(root);
  expect(read(root, "helper")).toContain(OPENING);
  const n = loadBrain(root).find((x) => x.fm.id === "people/cara-lee")!;
  n.fm.sensitivity = "private";
  saveNote(root, n);
  sh(root, "owner", "commit", "-qam", "owner: Cara's page private");
  const b = read(root, "helper");
  expect(b).not.toContain("alongside");
  expect(b).not.toMatch(/cara|\bLee\b/i);
  expect(b).toContain("You work as a lecturer at North College.");
  // planner (up to private) still sees Cara: the opening stays whole for it.
  expect(read(root, "planner")).toContain(OPENING);
});

test("G761 a name the opening says from a sentence that goes takes the whole opening with it", () => {
  const root = brain({ on: true });
  // It cites Ana's labels for the colleagues' sentence, which names Ben too.
  const labels = ["p-at-robin-vale", "p-in-robin-vale", "p-at-ana-diaz", "p-in-ana-diaz"];
  const text = "You work as a lecturer at North College, alongside your colleagues Ana Diaz and Ben Roy.";
  expect((sync(root, text, labels) as { applied: boolean }).applied).toBe(true);
  expect(read(root, "helper")).toContain(text);
  const n = loadBrain(root).find((x) => x.fm.id === "people/ben-roy")!;
  n.fm.sensitivity = "private";
  saveNote(root, n);
  sh(root, "owner", "commit", "-qam", "owner: Ben's page private");
  const b = read(root, "helper");
  expect(b).not.toContain("alongside");
  expect(b).not.toContain("[withheld]");
  expect(b).not.toMatch(/\bBen\b|\bRoy\b/);
  expect(b).toContain("You work as a lecturer at North College.");
  expect(read(root, "planner")).toContain(text);
});

test("G761 the opening lands as one commit: reverting it takes the paragraph out of the page", () => {
  const root = brain({ on: true });
  const before = sh(root, "x", "rev-parse", "HEAD"), was = body(root);
  sync(root);
  expect(sh(root, "x", "rev-list", "--count", `${before}..HEAD`)).toBe("1");
  expect(sh(root, "x", "log", "-1", "--format=%an %s")).toMatch(/^gardener reflect:auto wiki: opening for orgs\/north-college/);
  expect(body(root)).toContain(OPENING);
  sh(root, "owner", "revert", "--no-edit", "HEAD");
  expect(body(root)).toBe(was);
  expect(loadBrain(root).find((x) => x.fm.id === ORG)!.fm.opening).toBeUndefined();
});

test("G761 the Gardener's own opening is no change for it to weigh", () => {
  const root = brain({ on: true });
  sync(root);
  const ch = atNight(() => changesSince(root, "gardener", "2026-10-01T00:00:00Z"));
  expect(ch.changes.filter((c) => c.id === ORG && c.attrs_changed.length === 0)).toEqual([]);
});

test("G761 an opening line a person re-spaced or re-ordered still goes whole", () => {
  const root = brain({ on: true });
  const labels = ["p-at-robin-vale", "p-in-robin-vale", "p-at-ana-diaz", "p-in-ana-diaz"];
  const text = "You work as a lecturer at North College, alongside your colleagues Ana Diaz and Ben Roy.";
  sync(root, text, labels);
  const n = loadBrain(root).find((x) => x.fm.id === ORG)!;
  n.body = n.body.replace(text, text.replace("North College, ", "North College,  ")).replace("[^p-at-robin-vale][^p-in-robin-vale][^p-at-ana-diaz]", "[^p-in-robin-vale][^p-at-robin-vale][^p-at-ana-diaz]");
  saveNote(root, n);
  const ben = loadBrain(root).find((x) => x.fm.id === "people/ben-roy")!;
  ben.fm.sensitivity = "private";
  saveNote(root, ben);
  sh(root, "owner", "commit", "-qam", "owner: a hand edit, and Ben's page private");
  const b = read(root, "helper");
  expect(b).not.toContain("alongside");
  expect(b).not.toContain("[withheld]");
});
