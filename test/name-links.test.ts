// SPDX-License-Identifier: AGPL-3.0-only
// Names become links (memory-graph.md item 2, docs/wiki.md "Names become links"): upkeep links a
// name that fits exactly one note, keeps the words as written, and never links a name that fits
// two notes, a page some reader of this note can't see, the owner's own name, or text inside code,
// a heading or an existing link. Each note's links are one revertable reflect commit.
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { upkeep, undoRun } from "../src/upkeep";
import { loadBrain } from "../src/brain";
import { setLinkNames } from "../src/ownerset";
import { namePlan } from "../src/mentions";
import { loadRules } from "../src/rules";
import { gardenerUpkeep } from "../src/core";

const B = "projects/course-b";
const body = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!.body;
const commit = (root: string) => Bun.spawnSync(["git", "commit", "-qam", "setup"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
function withText(text: string, id = B, on = true) {
  const root = makeBrain();
  const p = join(root, `${id}.md`);
  writeFileSync(p, readFileSync(p, "utf8").replace(/\n*$/, `\n${text}\n`));
  commit(root);
  if (on) setLinkNames(root, "on");
  return root;
}

test("a name that fits one note becomes a link, the words as written, once", () => {
  const root = withText("Ask jane roy about the Course A midterm. Jane Roy said yes.");
  const r = upkeep(root, { now: "2026-10-08" });
  const b = body(root, B);
  expect(b).toContain("Ask [[people/jane-roy|jane roy]] about the [[projects/course-a|Course A]] midterm. Jane Roy said yes.");
  expect(r.findings.filter((f) => f.rule === "link-mention").map((f) => [f.key, f.detail])).toEqual([[B, "linked 2 names in the text to the one note each names"]]);
  const log = Bun.spawnSync(["git", "log", "-3", "--format=%B"], { cwd: root }).stdout.toString();
  expect(log).toContain("reflect: link names in projects/course-b");
  expect(log).toContain("Kind: auto-fix");
  // A second run has nothing left to link.
  expect(upkeep(root, { now: "2026-10-08" }).findings.filter((f) => f.rule === "link-mention")).toEqual([]);
});

test("off until the owner turns it on: nothing written, no findings; preview shows the owner what it would link", () => {
  const root = withText("Ask Jane Roy.", B, false);
  const r = upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("Ask Jane Roy.");
  expect(r.findings.filter((f) => /^(link-mention|name-)/.test(f.rule))).toEqual([]);
  expect(namePlan(loadBrain(root), loadRules(root)).find((p) => p.from === B)!.link).toEqual([{ from: B, to: "people/jane-roy", name: "Jane Roy" }]);
  expect(setLinkNames(root, "on")).toContain("link_names on");
  upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("Ask [[people/jane-roy|Jane Roy]].");
});

test("a name that fits two notes is a review line, never a link", () => {
  const root = withText("Lunch with Jane Roy.");
  const twin = join(root, "people/jane-roy-2.md");
  writeFileSync(twin, readFileSync(join(root, "people/jane-roy.md"), "utf8").replace("id: people/jane-roy", "id: people/jane-roy-2").replace("Coordinates [[projects/course-a]].", ""));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); commit(root);
  const r = upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("Lunch with Jane Roy.");
  const f = r.findings.find((x) => x.rule === "name-ambiguous" && x.key === B)!;
  expect(f.detail).toBe("a name in the text fits more than one note; link the right one by hand");
  // The Gardener gets findings on notes it sees: a review line names no other note and no name.
  expect(f.detail).not.toContain("jane");
});

test("a page some reader of this note can't see is never linked: the name stays, a review line says why", () => {
  // The planner reads Course B's text but can't see money/main-bank.
  const root = withText("Paid from the Main bank account.");
  const r = upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("Paid from the Main bank account.");
  const f = r.findings.find((x) => x.rule === "name-unlinked" && x.key === B)!;
  expect(f.detail).toContain("some assistants who see this note can't see");
  expect(f.detail).not.toMatch(/main|bank/i);
});

test("code, headings, existing links, the owner's name and short one-word names stay as they are", () => {
  const root = withText("## Jane Roy\n`Course A` and [[people/jane-roy|Jane]].\n[^1]: Course A email\nRobin asked Jane.");
  upkeep(root, { now: "2026-10-08" });
  const b = body(root, B);
  expect(b).toContain("## Jane Roy\n`Course A` and [[people/jane-roy|Jane]].\n[^1]: Course A email\nRobin asked Jane.");
  expect(b).not.toContain("[[projects/course-a");
});

test("undo --run takes the links back and keeps them from coming back", () => {
  const root = withText("Ask Jane Roy.");
  const r = upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("[[people/jane-roy|Jane Roy]]");
  undoRun(root, r.run);
  expect(body(root, B)).toContain("Ask Jane Roy.");
  upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("Ask Jane Roy.");
});

// Cases from the slice audit (pocketbrain-app-reviews/auto-links-slice-audit.md).
test("what the Gardener gets back names no name, note or value, even an alias carved from it or a text it can't read", async () => {
  const root = withText("Ask Course coordinator Roy and Jane Roy.");
  const p = join(root, "people/jane-roy.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("aliases: [Jane]", "aliases: [Jane, Course coordinator Roy]").replace("role: { value: Course coordinator,", "role: { share_with: [steward], value: Course coordinator,"));
  commit(root);
  const g = await gardenerUpkeep(root, "gardener");
  const mine = g.findings.filter((f) => /^(link-mention|name-)/.test(f.rule));
  expect(mine.length).toBeGreaterThan(0);
  for (const f of mine) expect(f.detail).not.toMatch(/coordinator|jane|roy|people\//i);
});

test("a character that folds to a different length before a name leaves the rest of the text as written", () => {
  const root = withText("𝐀sk Jane Roy now.");
  upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("𝐀sk [[people/jane-roy|Jane Roy]] now.");
});

test("a merged note's names never link, so a same-person undo can't leave a link at the wrong person", () => {
  const root = withText("Lunch with Jaybird Roysmith.");
  writeFileSync(join(root, "people/jay.md"), readFileSync(join(root, "people/jane-roy.md"), "utf8").replace("id: people/jane-roy", "id: people/jay").replace("title: Jane Roy", "title: Jaybird Roysmith").replace("status: active", "status: merged\nmerged_into: people/jane-roy").replace("Coordinates [[projects/course-a]].", ""));
  const p = join(root, "people/jane-roy.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("aliases: [Jane]", "aliases: [Jane, Jaybird Roysmith]"));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root }); commit(root);
  upkeep(root, { now: "2026-10-08" });
  expect(body(root, B)).toContain("Lunch with Jaybird Roysmith.");
});
