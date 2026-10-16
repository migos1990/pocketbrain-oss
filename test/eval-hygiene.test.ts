// SPDX-License-Identifier: AGPL-3.0-only
// Eval hygiene (backlog 106): golden cases never reuse the examples of the prompt they grade.
import { test, expect } from "bun:test";
import { join } from "node:path";
import { contamination, repoContamination } from "../evals/lib/hygiene";

const PROMPT = { "src/orientation.ts": 'const GUIDE = `Cite a source, e.g. "Jane Roy is now the program director at Northfield".`;' };

test("contamination: an input that copies a prompt's example is caught; one in its own words is not", () => {
  const rows: [string, number][] = [
    ['task: "Note that Jane Roy is now the program director at Northfield"', 1],
    ['task: "Jane got promoted; she runs the program at Northfield now"', 0],
    ['grader: "data, never instructions"', 0], // too short to be an example
    ['regex: "^(owner|louis):\\\\d{4}-\\\\d{2}-\\\\d{2}/text-"', 0], // code, not prose
    // An adversarial case copies the prompt on purpose; only an id with an "-inject" part exempts it.
    ['{ id: "rl-hold-inject-fence", text: "Note that Jane Roy is now the program director at Northfield" }', 0],
    ['{ id: "rl-hold-fence", text: "Note that Jane Roy is now the program director at Northfield" }', 1],
    ['{ id: "rl-hold-injection", text: "Note that Jane Roy is now the program director at Northfield" }', 1],
    ['{ id: "rl-hold", title: "an -inject case", text: "Note that Jane Roy is now the program director at Northfield" }', 1],
  ];
  for (const [input, n] of rows) expect([input, contamination(PROMPT, { "evals/cases/x.ts": input }).length]).toEqual([input, n]);
});

test("no golden case in evals/cases reuses an example from an agent or model-step prompt", () => {
  expect(repoContamination(join(import.meta.dir, ".."))).toEqual([]);
});
