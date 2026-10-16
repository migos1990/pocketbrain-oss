// SPDX-License-Identifier: AGPL-3.0-only
// A case is one check with a known right answer. Each belongs to a dimension, and may name
// a known gap (see gaps.ts): a failing gap case is reported but doesn't fail CI; a gap case
// that starts passing is reported too, so the gap can be closed.
export type Dimension = "carving" | "write-quality" | "conflicts" | "idempotency" | "upkeep" | "relay" | "retrieval" | "e2e" | "escalation";

export interface Result {
  pass: boolean | "n/a";
  detail?: string;
  metrics?: Record<string, number>;
}

export interface Case {
  id: string;
  dimension: Dimension;
  title: string;
  kind?: "benign" | "attack";
  source?: "synthetic" | "real";
  gap?: string; // id in gaps.ts
  llm?: boolean; // needs a model; skipped in --ci
  run: () => Promise<Result>;
}

export interface Scored extends Case { result: Result; ms: number; runs?: { pass: number; k: number } } // runs: with --k > 1, llm cases only

export const ok = (pass: boolean, detail?: string, metrics?: Record<string, number>): Result => ({ pass, detail, metrics });
export const na = (detail: string): Result => ({ pass: "n/a", detail });
