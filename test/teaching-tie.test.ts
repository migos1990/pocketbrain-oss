// SPDX-License-Identifier: AGPL-3.0-only
// The owner, 2026-11-07, on his school's org page: "it should have understood by then that I teach
// there … and this is a class number." A course code that recurs in the titles of pages filed from
// two or more mails, with people at one school behind the same mails, becomes one ask in the
// owner's words: "You seem to teach PROD 20410 at North College. Right?" (G711). Nothing is filed
// before his tap. Yes files the course page and his own word that he teaches it, never touching his
// employer; the school's page then opens with it (G712). No is remembered and never asked again.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";
import { loadBrain } from "../src/brain";
import { findTeaching, raiseTeachAsks, answerTeach, teachAsks, TEACH_DIR } from "../src/teaching";
import { upkeep } from "../src/upkeep";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const SINCE = "2000-01-01T00:00:00Z";
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---");
const fact = (value: string, mail: string) => `{ value: "${value}", as_of: 2026-10-05, sources: ["gmail:${mail}"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }`;
const head = (id: string, type: string, title: string) => `---\nid: ${id}\ntype: ${type}\ntitle: "${title}"\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n`;
const M1 = "f0000000000000d1", M2 = "f0000000000000d2";

function brain(o: { people?: number } = {}) {
  const root = makeBrain();
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "north-college.md"), `${head("orgs/north-college", "org", "North College")}---\n`);
  writeFileSync(join(root, "orgs", "harbour-soft.md"), `${head("orgs/harbour-soft", "org", "Harbour Soft")}---\n`);
  writeFileSync(join(root, "people", "robin-vale.md"), `${head("people/robin-vale", "person", "Robin Vale")}facts:\n  org: ${fact("[[orgs/harbour-soft]]", "f0000000000000d0")}\n---\n`);
  writeFileSync(join(root, "projects", "prod-20410-intra.md"), `${head("projects/prod-20410-intra", "project", "PROD 20410: intra exam due by Oct 9")}facts:\n  next_step: ${fact("grade the intra by 2026-10-09", M1)}\n---\n`);
  writeFileSync(join(root, "projects", "prod-20410-session.md"), `${head("projects/prod-20410-session", "project", "PROD 20410: Oct 6 session moved")}facts:\n  next_step: ${fact("teach on Sunday 2026-10-11", M2)}\n---\n`);
  const names = ["Ana Diaz", "Ben Roy", "Cara Lee", "Dan Poe"].slice(0, o.people ?? 4);
  names.forEach((name, i) => {
    const id = `people/${name.toLowerCase().replace(" ", "-")}`;
    writeFileSync(join(root, `${id}.md`), `${head(id, "person", name)}facts:\n  org: ${fact("[[orgs/north-college]]", i % 2 ? M2 : M1)}\n---\n`);
  });
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: the course mails");
  renderTouchedPages(root, SINCE);
  return root;
}

test("G711 a course code in pages from two mails, with people at one school behind them, is one ask and nothing filed", () => {
  const root = brain();
  const head0 = sh(root, "hub", "rev-parse", "HEAD");
  const found = findTeaching(root);
  expect(found.map((x) => [x.code, x.org])).toEqual([["PROD 20410", "orgs/north-college"]]);
  raiseTeachAsks(root);
  const asks = teachAsks(root);
  expect(asks.length).toBe(1);
  expect(asks[0]).toMatchObject({ code: "PROD 20410", org: "orgs/north-college", status: "waiting" });
  expect(asks[0]!.question).toBe("You seem to teach PROD 20410 at North College. Right?");
  // The ask file lives in the inbox, outside the pages; no page changed.
  expect(existsSync(join(root, TEACH_DIR))).toBe(true);
  expect(sh(root, "hub", "diff", "--stat", head0, "--", "people", "orgs", "projects")).toBe("");
  expect(existsSync(join(root, "projects", "prod-20410.md"))).toBe(false);
  // Asked once: a second pass raises nothing new.
  raiseTeachAsks(root);
  expect(teachAsks(root).length).toBe(1);
});

test("G711 too few people at the school, or one mail only, asks nothing", () => {
  expect(findTeaching(brain({ people: 1 }))).toEqual([]);
});

test("G712 Yes files the course page and his word that he teaches it; the school's page opens with it", () => {
  const root = brain();
  raiseTeachAsks(root);
  answerTeach(root, "PROD 20410", "teaches");
  const notes = loadBrain(root);
  const course = notes.find((n) => n.fm.id === "projects/prod-20410")!;
  expect(course.fm.title).toBe("PROD 20410");
  expect(String((course.fm.facts!.org as { value: string }).value)).toBe("[[orgs/north-college]]");
  const me = notes.find((n) => n.fm.id === "people/robin-vale")!;
  expect(JSON.stringify(me.fm.facts!.teaches)).toContain("projects/prod-20410");
  // His employer is untouched, and nothing is in conflict.
  expect(String((me.fm.facts!.org as { value: string }).value)).toBe("[[orgs/harbour-soft]]");
  expect(existsSync(join(root, "disputes"))).toBe(false);
  expect(teachAsks(root)[0]!.status).toBe("teaches");
  expect(body(root, "orgs/north-college").trim().startsWith("You teach [[projects/prod-20410|PROD 20410]] here.")).toBe(true);
  expect(body(root, "people/robin-vale")).toContain("You teach [[projects/prod-20410|PROD 20410]] at [[orgs/north-college|North College]].");
  // The course page says it to him and gathers the pages about it.
  const c = body(root, "projects/prod-20410");
  expect(c).toContain("You teach PROD 20410 at [[orgs/north-college|North College]].");
  expect(c).toContain("About it: [[projects/prod-20410-intra|PROD 20410: intra exam due by Oct 9]] and [[projects/prod-20410-session|PROD 20410: Oct 6 session moved]].");
  expect(c).not.toContain("See also [[people/robin-vale");
});

test("G711 No is remembered and the code is never asked again", () => {
  const root = brain();
  raiseTeachAsks(root);
  answerTeach(root, "PROD 20410", "no");
  raiseTeachAsks(root);
  const asks = teachAsks(root);
  expect(asks.map((a) => a.status)).toEqual(["no"]);
  expect(YAML.parse(readFileSync(join(root, TEACH_DIR, "prod-20410.yaml"), "utf8")).status).toBe("no");
  expect(existsSync(join(root, "projects", "prod-20410.md"))).toBe(false);
});

test("G711 report-only: a dry pass finds the class and files no question", () => {
  const root = brain();
  const at = sh(root, "hub", "rev-parse", "HEAD");
  expect(raiseTeachAsks(root, { apply: false }).map((x) => x.code)).toEqual(["PROD 20410"]);
  expect(teachAsks(root)).toEqual([]);
  expect(sh(root, "hub", "rev-parse", "HEAD")).toBe(at);
});

test("G711 the night pass only counts the class until the owner turns the question on", () => {
  const root = brain();
  const off = upkeep(root, { now: "2026-10-08" }).findings.find((f) => f.rule === "teach-would-ask");
  expect(off?.detail).toContain("1 class you may teach, from 4 people at 1 school");
  expect(teachAsks(root)).toEqual([]);
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8") + "\nteach: { ask: true }\n");
  sh(root, "louis", "commit", "-qam", "owner: ask about classes");
  expect(upkeep(root, { now: "2026-10-08" }).findings.some((f) => f.rule === "teach-asked")).toBe(true);
  expect(teachAsks(root).map((a) => a.code)).toEqual(["PROD 20410"]);
});
