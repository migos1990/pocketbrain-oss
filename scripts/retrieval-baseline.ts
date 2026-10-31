// SPDX-License-Identifier: AGPL-3.0-only
// Rewrite the synthetic retrieval set's baseline (evals/fixtures/retrieval/baseline.json) after a
// wanted change to ranking or to the set. CI's ret-synth-baseline fails when recall@5 drops under it.
// Misses are listed for every kind but the blind ones (blind2 to blind4), whose questions stay unread
// by whoever tunes search.
//   bun scripts/retrieval-baseline.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { synthScores, SYNTH_DIR } from "../evals/cases/retrieval";

const s = synthScores();
const round = (x: number) => Math.floor(x * 1000) / 1000;
const recall5: Record<string, Record<string, number>> = {}, misses: Record<string, Record<string, string[]>> = {};
for (const [m, kinds] of Object.entries(s)) {
  recall5[m] = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, round(v.rate)]));
  misses[m] = Object.fromEntries(Object.entries(kinds).filter(([k]) => !k.startsWith("blind")).map(([k, v]) => [k, v.misses]));
}
const out = { note: "recall@5 on questions.yaml through core.search, word map off (plain) and on (lexicon); written by bun scripts/retrieval-baseline.ts", recall5, misses };
writeFileSync(join(SYNTH_DIR, "baseline.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(recall5, null, 2));
