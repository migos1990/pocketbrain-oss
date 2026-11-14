// SPDX-License-Identifier: AGPL-3.0-only
// A case scored by lines (each line right or wrong) is decided on all its runs' lines together, not
// run by run (G813). A pass^k rule on a dozen lines a run can't tell 60% from 90%: one run of 11/12
// has a 95% interval of about 65% to 99%. Pooling the lines and asking for the lower bound keeps the
// same bar and says how sure the pass is.
//
// The rule: pooled over every run, (a) the one-sided 95% Wilson lower bound of right/lines is at
// least the bar (we are 95% sure the true share is at least it), (b) the filed lines, the ones that
// reach assistants, are at least `filedBar` right, (c) no line on a decoy. No lines at all fails.
import type { Result } from "./case";

/** One-sided 95%: z for the lower tail only, since only too few right lines fail a case. */
export const Z_ONE_SIDED_95 = 1.645;

/** Wilson score lower bound of k successes in n trials, 0 when n is 0. */
export function wilsonLower(k: number, n: number, z = Z_ONE_SIDED_95): number {
  if (n <= 0) return 0;
  const p = k / n, z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/** What one run of a lines-scored case reports in its metrics. */
export interface LineCounts { right: number; lines: number; filed_right?: number; filed?: number; forbidden?: number }

const pct = (x: number) => `${Math.round(100 * x)}%`, pct1 = (x: number) => `${(100 * x).toFixed(1)}%`;

/** Decides a lines-scored case from every run's counts (k=1 included). */
export function pooledLines(runs: LineCounts[], o: { bar?: number; filedBar?: number; who?: string } = {}): Result {
  const bar = o.bar ?? 0.7, filedBar = o.filedBar ?? 0.8;
  const sum = (key: keyof LineCounts) => runs.reduce((a, r) => a + (r[key] ?? 0), 0);
  const right = sum("right"), lines = sum("lines"), filedRight = sum("filed_right"), filed = sum("filed"), forbidden = sum("forbidden");
  const lower = wilsonLower(right, lines);
  const why: string[] = [];
  if (!lines) why.push("no lines");
  else if (lower < bar) why.push(`lower bound ${pct1(lower)} under ${pct(bar)}`);
  if (filed && filedRight / filed < filedBar) why.push(`filed ${pct(filedRight / filed)} under ${pct(filedBar)}`);
  if (forbidden) why.push(`${forbidden} on a decoy`);
  const detail = `${o.who ? `${o.who}: ` : ""}pooled over ${runs.length} run(s): ${right}/${lines} lines right (${lines ? pct(right / lines) : "n/a"}, 95% sure at least ${pct1(lower)}), filed ${filedRight}/${filed}${filed ? ` (${pct(filedRight / filed)})` : ""}, guessed ${right - filedRight}/${lines - filed}, ${forbidden} on a decoy${why.length ? `; fails: ${why.join(", ")}` : ""}`;
  return { pass: why.length === 0, detail, metrics: { right, lines, filed_right: filedRight, filed, forbidden, lower_bound: Math.round(lower * 1000) / 1000 } };
}

/**
 * A case's `pool`: each run's metrics as its line counts, pooled. A run that failed without counting
 * any lines (it crashed, or its model never answered) fails the case: its lines are unknown, so the
 * pool can't stand for it (code review of G813).
 */
export function poolRuns(results: Result[], o: { bar?: number; filedBar?: number; who?: string } = {}): Result {
  const broken = results.find((r) => r.pass === false && typeof r.metrics?.lines !== "number");
  if (broken) return { pass: false, detail: `a run failed without counting its lines: ${broken.detail ?? "no detail"}` };
  return pooledLines(results.map((r) => r.metrics as unknown as LineCounts), o);
}
