// SPDX-License-Identifier: AGPL-3.0-only
// The owner's choice (2026-10-27, "yess keep"): when a pulled fact files, the words it was drawn
// from are kept, outside git, at most 200 characters, and shown only on the owner's own page when
// they tap a reference. Assistants never get the words; a fact that was refused keeps none.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { decideProposal } from "../src/write";
import { keptQuotes, sweepKeptQuotes, QUOTE_MAX } from "../src/quotes";
import { renderTouchedPages } from "../src/wiki";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";
import { readNote } from "../src/core";
import { loadBrain, type FactRecord } from "../src/brain";

const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const event = (id: string, line: string) => ({ id, etag: `"${id}"`, summary: "Planning", start: { dateTime: "2026-10-20T10:00:00Z" }, description: line, updated: "2026-10-05T09:00:00Z", calendar: "primary" });
const NOW = new Date();
const LINE = "Course B (project) next_step: Grade the essays";
const ROLE = "Jane Roy (person) role: Program dean";

async function filed(file = "all", lines = `${LINE}\n${ROLE}`) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), `health: { url: null }\nauto_decide: { file: ${file} }\n`);
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { cal: { kind: "gcal", fixture: "c.json" } } }));
  writeFileSync(join(root, "c.json"), JSON.stringify([event("e1", lines)]));
  Bun.spawnSync(["git", "add", "rules"], { cwd: root }); Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "rules"], { cwd: root });
  await pullSource(root, "cal", { model });
  return root;
}
const refOf = (root: string) => String(((loadBrain(root).find((n) => n.fm.id === "projects/course-b")!.fm.facts!.next_step as FactRecord).sources ?? [])[0]);

test("a filed fact keeps its source's words outside git, and the owner's page shows them under the reference", async () => {
  const root = await filed();
  runAuto(root, NOW);
  const ref = refOf(root);
  // One event gave two facts: each one's words are kept under that event.
  expect(keptQuotes(root, ref).sort()).toEqual([LINE, ROLE].sort());
  // Nothing git holds has the words: no file, no commit, no proposal.
  const all = Bun.spawnSync(["git", "log", "--all", "-p", "--format=%B"], { cwd: root }).stdout.toString();
  expect(all.includes(LINE)).toBe(false);
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  const s = loadState(root, NOW);
  const html = ownerPage(s, "t", s.notes.find((n) => n.fm.id === "projects/course-b")!, []);
  expect(html).toMatch(/<details class="quote"><summary>[^<]+<\/summary><blockquote>Course B \(project\) next_step: Grade the essays<\/blockquote><\/details>/);
  // An assistant reading the page gets the facts and text, never the words.
  expect(JSON.stringify(readNote(root, "planner", "projects/course-b"))).not.toContain(LINE);
});

test("a rejected proposal keeps no words, and a source no fact cites any more loses its words on the sweep", async () => {
  const root = await filed("none");
  const file = readdirSync(join(root, "inbox")).find((f) => f.endsWith(".yaml"))!;
  const ref = String(YAML.parse(readFileSync(join(root, "inbox", file), "utf8")).request.sources[0]);
  decideProposal(root, file, "reject");
  expect(keptQuotes(root, ref)).toEqual([]);
  expect(sweepKeptQuotes(root)).toBe(0);
  // Both sides of the event's facts are cited (Jane Roy's role as a conflict's side): its words stay.
  const both = await filed();
  runAuto(both, NOW);
  expect(sweepKeptQuotes(both)).toBe(0);
  expect(keptQuotes(both, refOf(both))).toHaveLength(2);
  const kept = await filed("all", LINE);
  runAuto(kept, NOW);
  const r2 = refOf(kept);
  expect(keptQuotes(kept, r2)).toEqual([LINE]);
  expect(sweepKeptQuotes(kept)).toBe(0);
  expect(keptQuotes(kept, r2)).toEqual([LINE]);
  // The fact taken out of the page entirely (a hand edit): the words go with it.
  const p = join(kept, "projects", "course-b.md");
  const t = readFileSync(p, "utf8");
  writeFileSync(p, t.replace(/\n  next_step:[^\n]*(\n    [^\n]*)*/, "").replace(/\nhistory:[\s\S]*?(?=\n---)/, ""));
  expect(sweepKeptQuotes(kept)).toBe(1);
  expect(keptQuotes(kept, r2)).toEqual([]);
  expect(QUOTE_MAX).toBe(200);
});

// Audit v5, midday: quotes kept inside .git sat outside the backup, which carries the brain's
// untracked files, never .git's own. They live in the brain folder now, ignored by git and
// owner-only, and an older hub's are moved there once.
test("kept quotes live in the brain folder where the backup carries them, never in a commit", async () => {
  const { statSync, existsSync, mkdirSync, cpSync, rmSync } = await import("node:fs");
  const root = await filed();
  runAuto(root, NOW);
  const d = join(root, ".pb-kept-quotes");
  expect(readdirSync(d).filter((f) => f.endsWith(".quote")).length).toBeGreaterThan(0);
  expect(statSync(d).mode & 0o077).toBe(0);
  expect(existsSync(join(root, ".git", "pb-kept-quotes"))).toBe(false);
  const g = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString();
  expect(g("ls-files", "--others")).toContain(".pb-kept-quotes/");
  expect(g("status", "--porcelain")).not.toContain(".pb-kept-quotes");
  // An older hub's, inside .git: moved on first read.
  const ref = refOf(root);
  const before = keptQuotes(root, ref);
  mkdirSync(join(root, ".git", "pb-kept-quotes"), { recursive: true });
  cpSync(d, join(root, ".git", "pb-kept-quotes"), { recursive: true });
  rmSync(d, { recursive: true, force: true });
  const fresh = Bun.spawnSync(["bun", "-e", `const { keptQuotes } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "quotes.ts"))}); console.log(JSON.stringify(keptQuotes(${JSON.stringify(root)}, ${JSON.stringify(ref)})))`]).stdout.toString().trim();
  expect(JSON.parse(fresh)).toEqual(before);
  expect(existsSync(join(root, ".git", "pb-kept-quotes"))).toBe(false);
  expect(existsSync(join(d, ".gitignore"))).toBe(true);
});
