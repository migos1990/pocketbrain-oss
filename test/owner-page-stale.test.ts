// SPDX-License-Identifier: AGPL-3.0-only
// Mac, 2026-11-02, after G624 went live: the owner's own page still read "How you know …", because
// the night writer only rewrites pages with a commit in its window, and his page had none. His page
// is written every run; an unchanged one costs nothing, since the writer skips text that comes out
// the same (G627).
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { renderTouchedPages } from "../src/wiki";

const OLD = "2026-10-01T12:00:00Z";
const sh = (root: string, name: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@pocketbrain.local`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@pocketbrain.local`, GIT_AUTHOR_DATE: OLD, GIT_COMMITTER_DATE: OLD } });
const body = (root: string, id: string) => readFileSync(join(root, `${id}.md`), "utf8").split(/^---$/m).slice(2).join("---").trim();
const fact = (attr: string, value: string, ref: string) => `  ${attr}: { value: ${value}, as_of: 2026-09-05, sources: ["${ref}"], verification: verified-by-source, by: planner, recorded: 2026-09-05 }\n`;

test("G627 the owner's page is rewritten even when nothing touched it inside the writer's window", () => {
  const root = makeBrain();
  const pol = join(root, "rules", "policy.yaml");
  writeFileSync(pol, readFileSync(pol, "utf8").replace("owner: { name: Robin }", "owner: { name: Robin Vale }"));
  const page = join(root, "people", "robin-vale.md");
  // His page as the writer left it before G624, a month ago: a lead that says how he knows himself.
  writeFileSync(page, `---\nid: people/robin-vale\ntype: person\ntitle: Robin Vale\narea: personal\nsensitivity: personal\nstatus: active\ncreated: 2026-09-01\nupdated: 2026-09-05\nby: planner\nfacts:\n${fact("city", "Halifax", "gmail:f000000000000009")}${fact("relationship", "customer of Best Buy Canada", "gmail:f00000000000000b")}---\n`);
  sh(root, "planner", "add", "-A");
  sh(root, "planner", "commit", "-qm", "planner: his page");
  writeFileSync(page, readFileSync(page, "utf8") + "Robin Vale's city is Halifax.[^pf-city] How you know Robin Vale: customer of Best Buy Canada.[^pf-relationship]\n\n(Written by the hub from this page's facts.)\n\n[^pf-city]: Email, 2026-09-05 (gmail:f000000000000009)\n[^pf-relationship]: Email, 2026-09-05 (gmail:f00000000000000b)\n");
  sh(root, "hub", "add", "-A");
  sh(root, "hub", "commit", "-qm", "hub: page text for 1 page");
  const w = renderTouchedPages(root, new Date(Date.now() - 26 * 3_600_000).toISOString());
  expect(w.written).toContain("people/robin-vale");
  const robin = body(root, "people/robin-vale");
  expect(robin).toContain("Halifax");
  expect(robin).not.toContain("How you know");
  expect(robin).not.toContain("Best Buy");
  // Run again: nothing changed, so nothing is written.
  expect(renderTouchedPages(root, new Date(Date.now() - 26 * 3_600_000).toISOString()).written).toEqual([]);
});
