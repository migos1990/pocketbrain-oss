// SPDX-License-Identifier: AGPL-3.0-only
// Audit v12 (wiki, first change): on 71 of the demo's 102 pages the paragraph a person wrote, the one
// saying why someone matters, sat under the hub's template block as "Earlier notes". A person's
// opening stays on top and the hub's block follows it under "From its facts" (G682); text the writer
// already moved down goes back up when it is word for word what someone wrote at the top (G683); a
// source id written into that text as "(gmail:<id>)" becomes one clean reference (G684).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages, MADE } from "../src/wiki";

const env = (name: string) => ({ ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local` });
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: env(name) }).stdout.toString().trim();
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const SINCE = "2000-01-01T00:00:00Z";
const HEAD = (facts: string) => `---\nid: projects/atlas\ntype: project\ntitle: Atlas launch\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n${facts ? `facts:\n${facts}` : ""}---\n`;
const STATUS = `  status: { value: in beta, as_of: 2026-10-05, sources: ["gmail:f0000000000000a1"], verification: verified-by-source, by: planner, recorded: 2026-10-05 }\n`;
const SEED = "The Atlas launch is the big one this fall: ten beta customers and a public launch on 3 November.";
const page = (root: string) => join(root, "projects", "atlas.md");

test("G682 a person's opening stays on top; the hub's block follows under From its facts, once", () => {
  const root = makeBrain();
  writeFileSync(page(root), `${HEAD(STATUS)}${SEED}\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: atlas");
  renderTouchedPages(root, SINCE);
  const b = body(root, "projects/atlas");
  expect(b).toStartWith(`${SEED}\n\n## From its facts\nAtlas launch is in beta.[^pf-status]\n\n${MADE}`);
  expect(b).not.toContain("## Earlier notes");
  // A second run writes nothing; a changed fact rewrites only the hub's block.
  const head = sh(root, "hub", "rev-parse", "HEAD");
  renderTouchedPages(root, SINCE);
  expect(sh(root, "hub", "rev-parse", "HEAD")).toBe(head);
  writeFileSync(page(root), readFileSync(page(root), "utf8").replace("value: in beta", "value: launched"));
  sh(root, "planner", "commit", "-qam", "planner: launched");
  renderTouchedPages(root, SINCE);
  const after = body(root, "projects/atlas");
  expect(after).toStartWith(`${SEED}\n\n## From its facts\nAtlas launch is launched.`);
  expect(after.split("## From its facts").length).toBe(2);
});

test("G682 a page whose last fact is gone keeps the person's text and loses the hub's block", () => {
  const root = makeBrain();
  writeFileSync(page(root), `${HEAD(STATUS)}${SEED}\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: atlas");
  renderTouchedPages(root, SINCE);
  writeFileSync(page(root), `${HEAD("")}${body(root, "projects/atlas")}\n`);
  sh(root, "planner", "commit", "-qam", "planner: no facts");
  renderTouchedPages(root, SINCE);
  const b = body(root, "projects/atlas");
  expect(b).toStartWith(SEED);
  expect(b).not.toContain("From its facts");
  expect(b).not.toContain(MADE);
  expect(b).not.toContain("pf-status");
});

test("G683 text the writer moved under Earlier notes goes back on top when it is word for word what someone wrote", () => {
  const root = makeBrain();
  writeFileSync(page(root), `${HEAD(STATUS)}${SEED}\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: atlas");
  // As the writer left it before this rule: its block on top, the person's text demoted.
  writeFileSync(page(root), `${HEAD(STATUS)}Atlas launch is in beta.[^pf-status]\n\n${MADE}\n\n## Earlier notes\n${SEED}\n\n[^pf-status]: Email, 2026-10-05 (gmail:f0000000000000a1)\n`);
  sh(root, "hub", "commit", "-qam", "hub: page text for 1 page\n\nKind: page-writer");
  renderTouchedPages(root, SINCE);
  const b = body(root, "projects/atlas");
  expect(b).toStartWith(`${SEED}\n\n## From its facts\nAtlas launch is in beta.`);
  expect(b).not.toContain("## Earlier notes");
});

test("G683 Earlier notes that are not word for word someone's opening stay where they are", () => {
  const root = makeBrain();
  writeFileSync(page(root), `${HEAD(STATUS)}${SEED}\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: atlas");
  writeFileSync(page(root), `${HEAD(STATUS)}Atlas launch is in beta.[^pf-status]\n\n${MADE}\n\n## Earlier notes\n${SEED} Grace collects feedback on Fridays.\n\n[^pf-status]: Email, 2026-10-05 (gmail:f0000000000000a1)\n`);
  sh(root, "hub", "commit", "-qam", "hub: page text for 1 page\n\nKind: page-writer");
  renderTouchedPages(root, SINCE);
  const b = body(root, "projects/atlas");
  expect(b).toStartWith("Atlas launch is in beta.");
  expect(b).toContain(`## Earlier notes\n${SEED} Grace collects`);
});

test("G684 a source id written as (gmail:<id>) becomes one reference, never a garbled one", () => {
  const root = makeBrain();
  writeFileSync(page(root), `${HEAD(STATUS)}Beta feedback comes in every Friday (gmail:1a0b2c3d4e5f6a7b).\n`);
  sh(root, "planner", "add", "-A"); sh(root, "planner", "commit", "-qm", "planner: atlas");
  renderTouchedPages(root, SINCE);
  const b = body(root, "projects/atlas");
  expect(b).toStartWith("Beta feedback comes in every Friday[^e-2c3d4e5f6a7b].");
  expect(b).toMatch(/^\[\^e-2c3d4e5f6a7b\]: Email \(gmail:1a0b2c3d4e5f6a7b\)$/m);
  expect(b).not.toMatch(/gmail:[a-z]{1,4}\)/);
});
