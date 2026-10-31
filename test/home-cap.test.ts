// SPDX-License-Identifier: AGPL-3.0-only
// The home is one screen plus a scroll (phone UI spec §2.1, Mac check 2026-10-26: a busy week made
// it 39,000px tall at phone width). Earlier days are capped, the rest behind Show more; and a page
// named anywhere in a line, as a bare slug or under any folder, reads as its name.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBrain } from "../src/brain";
import { homeView, EARLIER_DAYS, EARLIER_PER_DAY } from "../src/dashboard/home";
import { loadRules } from "../src/rules";

const row = (at: string, fact_key: string, to: unknown, title = fact_key.split("#")[0]!.split("/").pop()!) =>
  JSON.stringify({ at, fact_key, title, kind: "new", to, source_word: "email", by: "planner", confidence: "stated", rank: 3, sources: 1, sensitivity: "personal", undo_token: `u-${at}-${fact_key}` });

test("earlier days are capped: a few days, a few lines each, the rest behind Show more", () => {
  const root = makeBrain();
  mkdirSync(join(root, "diary"), { recursive: true });
  const lines: string[] = [];
  for (let d = 1; d <= 6; d++) for (let i = 0; i < 12; i++) lines.push(row(`2026-10-0${d}T15:00:0${i % 10}Z`, `people/jane-roy#note_${d}_${i}`, `v${i}`));
  writeFileSync(join(root, "diary", "2026-10.jsonl"), lines.join("\n") + "\n");
  const v = homeView(root, loadRules(root), loadBrain(root), new Date("2026-10-08T15:00:00Z"));
  expect(v.earlier.length).toBe(EARLIER_DAYS);
  for (const d of v.earlier) expect(d.lines.length).toBeLessThanOrEqual(EARLIER_PER_DAY);
  expect(v.earlierFolded).toBe(6 * 12 - EARLIER_DAYS * EARLIER_PER_DAY);
  const all = homeView(root, loadRules(root), loadBrain(root), new Date("2026-10-08T15:00:00Z"), { all: true });
  expect(all.earlier.flatMap((d) => d.lines).length).toBe(6 * 12);
  expect(all.earlierFolded).toBe(0);
});

test("a page named as a bare slug, under any folder, or in the attribute reads as its name", () => {
  const root = makeBrain();
  mkdirSync(join(root, "diary"), { recursive: true });
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "bay-institute.md"), `---\nid: orgs/bay-institute\ntype: org\ntitle: Bay Institute\narea: work\nsensitivity: personal\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  writeFileSync(join(root, "diary", "2026-10.jsonl"), [
    row("2026-10-08T10:00:00Z", "people/jane-roy#employer", "bay-institute"),
    row("2026-10-08T10:01:00Z", "people/jane-roy#next-step", "agents/planner follows up"),
    row("2026-10-08T10:02:00Z", "people/jane-roy#works_with", ["people/paul-advisor", "bay-institute"]),
  ].join("\n") + "\n");
  const v = homeView(root, loadRules(root), loadBrain(root), new Date("2026-10-08T15:00:00Z"), { all: true });
  const text = v.since.map((l) => l.what).join("\n");
  expect(text).toContain("Jane's employer is Bay Institute.");
  expect(text).toContain("Jane's next step is");
  expect(text).toContain("Jane works with Paul Advisor, Bay Institute.");
  expect(text).not.toMatch(/[a-z]+-[a-z]+/);
  expect(text).not.toMatch(/\b[a-z]+\/[a-z]/);
});

test("a slug never shows: a page titled with a slug, a slug inside a sentence, a slug of no page", () => {
  const root = makeBrain();
  mkdirSync(join(root, "diary"), { recursive: true });
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "bay-institute.md"), `---\nid: orgs/bay-institute\ntype: org\ntitle: Bay Institute\narea: work\nsensitivity: personal\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  const lines = [row("2026-10-08T10:02:00Z", "people/gone-person#fee", "1200", "gone-person-old").replace('"personal"', '"private"')];
  writeFileSync(join(root, "diary", "2026-10.jsonl"), [row("2026-10-08T10:00:00Z", "people/jane-roy#role", "coach-tennis"), row("2026-10-08T10:01:00Z", "people/jane-roy#note", "moved to bay-institute last week"), ...lines].join("\n") + "\n");
  const v = homeView(root, loadRules(root), loadBrain(root), new Date("2026-10-08T15:00:00Z"), { all: true });
  const text = v.since.map((l) => l.what).join("\n");
  expect(text).toContain("Jane's role is coach tennis.");
  expect(text).toContain("Jane's note is moved to Bay Institute last week.");
  expect(text).toContain("Something new about Gone person old.");
  expect(text).not.toMatch(/[a-z]+-[a-z]+/);
});
