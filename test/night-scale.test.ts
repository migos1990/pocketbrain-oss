// SPDX-License-Identifier: AGPL-3.0-only
// The night pass at scale (docs/perf.md, "The night pass"): the check that every note can be
// found by its own title asked a full ranking once per note per agent, which grew with the
// square of the brain and didn't finish at 10k notes. foundBy answers the same question from
// the index's postings; these hold it to rank's answer and the check to a loose bound.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { buildIndex, scoringIndex, rank, foundBy } from "../src/retrieve";
import { unsearchable } from "../src/probe";
import { synthBrain } from "../scripts/perf";

test("foundBy, on the full index or the scoring one, says what rank's top list says, for every note's title and other asks, at any cut", () => {
  const root = makeBrain();
  const notes = loadBrain(root), rules = loadRules(root);
  for (const agent of Object.keys(rules.policy.agents)) {
    const res = carve(notes, rules, grantFor(rules, agent));
    const idx = buildIndex(res, rules), lean = scoringIndex(res, rules);
    const asks = [...idx.docs.map((d) => d.title ?? ""), "course", "budget review", "jane", "next step", "nothing-matches-this"];
    for (const q of asks) for (const limit of [1, 3, 50]) for (const synonyms of [false, true]) {
      const top = rank(idx, q, limit, { synonyms }).map((h) => h.id);
      for (const d of idx.docs) for (const i of [idx, lean]) expect(`${agent} ${q} ${limit} ${d.id} ${foundBy(i, q, d.id, limit, { synonyms })}`).toBe(`${agent} ${q} ${limit} ${d.id} ${top.includes(d.id)}`);
    }
    expect(foundBy(idx, "course", "no/such-note", 50)).toBe(false);
  }
});

test("the searchable check over 3,000 notes finishes in seconds, not minutes", () => {
  const root = mkdtempSync(join(tmpdir(), "pb-night-"));
  try {
    const s = synthBrain(root, { notes: 3000, days: 3 });
    const was = process.env.PB_TODAY;
    process.env.PB_TODAY = s.today;
    const t = performance.now();
    const out = unsearchable(root);
    const ms = performance.now() - t;
    process.env.PB_TODAY = was;
    console.log(`unsearchable, 3000 notes: ${Math.round(ms)} ms`);
    // Short titles like "person 1 budget" share every word with hundreds of notes, so a few are
    // truly not found by their title: what's held here is the time, and foundBy's answer above.
    expect(out.length).toBeLessThan(100);
    expect(ms).toBeLessThan(20_000); // loose: only the old square growth fails here
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
