// SPDX-License-Identifier: AGPL-3.0-only
// Pages the capture path made for the owner's first name alone, before G976 stopped it (owner's
// phone, 2026-11-16). G978: the night pass counts them; with `first-name-pages on` it sets each one's
// facts aside with a diary line and Undo, and the page goes with them when no one's words are on it;
// Undo brings it back. Pages with the owner's word, the owner's own page and other names are left
// alone. Invented names and an invented shop; temp brains removed after.
import { test, expect, afterAll } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { setAsideFirstNamePages } from "../src/first-name-pages";
import { upkeep } from "../src/upkeep";
import { setFirstNamePages } from "../src/ownerset";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });
const rec = (value: string, extra = "") => `{ value: ${JSON.stringify(value)}, as_of: 2026-10-24, sources: ["gmail:f0000000000000c1"], verification: verified-by-source, by: hub, recorded: 2026-10-26${extra} }`;
const page = (id: string, title: string, facts: string[], by = "hub") =>
  `---\nid: ${id}\ntype: person\ntitle: ${title}\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-10-26\nupdated: 2026-10-26\nby: ${by}\nfacts:\n${facts.map((f) => `  ${f}`).join("\n")}\n---\n`;

function rig() {
  const root = makeBrain(); roots.push(root);
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Lake }"));
  writeFileSync(join(root, "people", "robin-lake.md"), page("people/robin-lake", "Robin Lake", ["home_city: { value: Halifax, as_of: 2026-10-01, sources: [\"owner:2026-10-01/box\"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }"], "owner"));
  writeFileSync(join(root, "people", "robin.md"), page("people/robin", "Robin", [`org: ${rec("Bramblewood Electronics")}`, `relationship: ${rec("customer of Bramblewood Electronics")}`]));
  // The owner wrote on this one: it stays.
  writeFileSync(join(root, "people", "robin-2.md"), page("people/robin-2", "Robin", [`org: ${rec("Tallgrass Studio", ", verification: confirmed-by-owner")}`.replace("verification: verified-by-source, ", "")]));
  // Another first name: not this rule's.
  writeFileSync(join(root, "people", "kim.md"), page("people/kim", "Kim", [`org: ${rec("Bramblewood Electronics")}`]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "seed");
  return root;
}

test("G978: counted, never changed, until the owner turns it on", () => {
  const root = rig();
  const r = setAsideFirstNamePages(root, false);
  expect(r.pages).toEqual(["people/robin"]);
  expect(r.facts).toBe(2);
  expect(existsSync(join(root, "people", "robin.md"))).toBe(true);
  const run = upkeep(root);
  expect(JSON.stringify(run)).toMatch(/named only by your first name/);
  expect(existsSync(join(root, "people", "robin.md"))).toBe(true);
});

test("G978: with the switch on, the page's facts are set aside with Undo and the page goes; Undo brings it back", () => {
  const root = rig();
  setFirstNamePages(root, "on");
  upkeep(root);
  expect(existsSync(join(root, "people", "robin.md"))).toBe(false);
  expect(existsSync(join(root, "people", "robin-2.md"))).toBe(true);
  expect(existsSync(join(root, "people", "kim.md"))).toBe(true);
  expect(loadBrain(root).find((n) => n.fm.id === "people/robin-lake")!.fm.facts!.home_city).toBeDefined();
  const rows = readDiary(root).filter((r) => r.why === "first-name");
  expect(rows.map((r) => r.fact_key).sort()).toEqual(["people/robin#org", "people/robin#relationship"]);
  expect(sh(root, "git", "log", "--format=%B", "--grep=Kind: first-name-page").stdout.toString()).toMatch(/set aside 1 page named only by the owner.s first name/);
  // Undo of one line brings the page back as it was; the other fact waits on its own Undo.
  const u = undoFact(root, rows.find((r) => r.fact_key.endsWith("#org"))!.undo_token);
  expect(u.outcome).toBe("undone");
  const back = loadBrain(root).find((n) => n.fm.id === "people/robin")!;
  expect(Object.keys(back.fm.facts ?? {})).toEqual(["org"]);
  // Set aside once: the next night leaves the owner's Undo standing.
  upkeep(root);
  expect(existsSync(join(root, "people", "robin.md"))).toBe(true);
});
