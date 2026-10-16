// SPDX-License-Identifier: AGPL-3.0-only
// The synthetic French and English retrieval golden set (evals/fixtures/retrieval) runs on every
// `bun test`: no carve leak, no drop under the committed baseline, and the held-out score against
// the 85% "add semantic search" gate is always measured, never n/a.
import { test, expect } from "bun:test";
import { synthRetrievalCases } from "../evals/cases/retrieval";

const cases = synthRetrievalCases();
const run = async (id: string) => cases.find((c) => c.id === id)!.run();

test("carve questions return nothing the asking agent may not see", async () => {
  expect((await run("ret-synth-no-forbidden")).pass).toBe(true);
  expect((await run("ret-synth-context-clean")).pass).toBe(true);
}, 60_000);

test("recall@5 holds the committed baseline", async () => {
  const r = await run("ret-synth-baseline");
  expect(r.detail).toBeDefined();
  expect(r.pass).toBe(true);
}, 60_000);

test("the blind gate is measured in the cloud, word map off and on, not skipped", async () => {
  for (const id of ["ret-synth-unseen", "ret-synth-unseen-lexicon"]) {
    const r = await run(id);
    expect(r.pass).not.toBe("n/a");
    expect(typeof r.metrics?.recall5).toBe("number");
  }
});

test("the French-English word map never costs a same-words question", async () => {
  expect((await run("ret-synth-lexicon-same-words")).pass).toBe(true);
});
