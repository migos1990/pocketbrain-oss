// SPDX-License-Identifier: AGPL-3.0-only
// Saved baselines and the paired compare (`--save-baseline`, `--compare`, `--compare-files`).
// Each case is paired with itself by id, so a prompt edit that turns one pass into a fail shows
// even when the totals hold. Rule: a regression is a pass->fail of a case that is not an open gap.
// With k >= 3 runs on both sides (llm cases), a regression needs the pass count to drop by 2 or
// more of k (scaled to the current k); a drop of 1 is listed as flaky, not failed. n/a never flips.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { SRC } from "./pb";

export interface Runs { pass: number; k: number }
export interface RunCase { id: string; pass: boolean | "n/a"; gap?: string; llm?: boolean; detail?: string; metrics?: Record<string, number>; runs?: Runs }
export interface RunMeta { name?: string; at?: string; app_commit?: string; driver?: string; model?: { agent: string; judge: string }; prompt_hash?: string }
export interface Baseline extends RunMeta { name: string; cases: RunCase[] }
export interface Flip { id: string; from: boolean | "n/a"; to: boolean | "n/a"; detail?: string; gap?: string }
export interface Rate { id: string; base: Runs; cur: Runs; delta: number }
export interface Comparison { paired: number; regressions: Flip[]; improvements: Flip[]; gapFlips: Flip[]; flaky: Rate[]; rates: Rate[]; added: string[]; missing: string[]; ok: boolean }

const DIR = join(import.meta.dir, "..", "baselines");
export function baselinePath(name: string): string {
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) throw new Error(`baseline name must be a plain word: ${name}`);
  return join(DIR, `${name}.json`);
}

// Scored cases (or results.json cases) to the small committed form: no run function, no timings.
export function toBaseline(name: string, summary: { app_commit: string; driver: string; at: string }, scored: { id: string; gap?: string; llm?: boolean; result: { pass: boolean | "n/a"; detail?: string; metrics?: Record<string, number> }; runs?: Runs }[], prompt_hash: string, model?: { agent: string; judge: string }): Baseline {
  return { name, at: summary.at, app_commit: summary.app_commit, driver: summary.driver, ...(model ? { model } : {}), prompt_hash, cases: scored.map(flat) };
}
function flat(s: any): RunCase {
  const r = s.result ?? s;
  const c: RunCase = { id: s.id, pass: r.pass };
  if (s.gap) c.gap = s.gap;
  if (s.llm) c.llm = true;
  if (r.detail) c.detail = String(r.detail).slice(0, 300);
  if (r.metrics && Object.keys(r.metrics).length) c.metrics = r.metrics;
  if (s.runs) c.runs = s.runs;
  return c;
}

export function saveBaseline(b: Baseline): string {
  mkdirSync(DIR, { recursive: true });
  const p = baselinePath(b.name);
  writeFileSync(p, JSON.stringify(b, null, 1) + "\n");
  return p;
}

// A saved baseline or a run's results.json ({ summary, cases }).
export function loadRun(path: string): { meta: RunMeta; cases: RunCase[] } {
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (j.summary) return { meta: { ...j.summary, name: path }, cases: j.cases.map(flat) };
  const { cases, ...meta } = j;
  return { meta, cases: cases.map(flat) };
}
export const loadBaseline = (name: string) => { const p = baselinePath(name); if (!existsSync(p)) throw new Error(`no baseline ${name}: save one with --save-baseline ${name}`); return loadRun(p); };

export function compare(base: RunCase[], cur: RunCase[]): Comparison {
  const b = new Map(base.map((c) => [c.id, c]));
  const ids = new Set(cur.map((c) => c.id));
  const out: Comparison = { paired: 0, regressions: [], improvements: [], gapFlips: [], flaky: [], rates: [], added: cur.filter((c) => !b.has(c.id)).map((c) => c.id), missing: base.filter((c) => !ids.has(c.id)).map((c) => c.id), ok: true };
  for (const c of cur) {
    const o = b.get(c.id);
    if (!o) continue;
    out.paired++;
    const flip: Flip = { id: c.id, from: o.pass, to: c.pass, detail: c.detail, gap: c.gap };
    let worse = o.pass === true && c.pass === false, better = o.pass === false && c.pass === true;
    if (o.runs && c.runs && o.runs.k > 1 && c.runs.k > 1) {
      const delta = c.runs.pass / c.runs.k - o.runs.pass / o.runs.k;
      const rate = { id: c.id, base: o.runs, cur: c.runs, delta };
      if (delta) out.rates.push(rate);
      if (o.runs.k >= 3 && c.runs.k >= 3) {
        const drop = -delta * c.runs.k;
        worse = drop >= 2 - 1e-9; better = drop <= -2 + 1e-9;
        if (!worse && !better && delta < 0) out.flaky.push(rate);
      }
    }
    if (worse) (c.gap ? out.gapFlips : out.regressions).push(flip);
    else if (better) out.improvements.push(flip);
  }
  out.ok = out.regressions.length === 0;
  return out;
}

export function render(r: Comparison, base: RunMeta, cur: RunMeta): string {
  const L: string[] = [];
  const name = base.name ?? "baseline";
  L.push(`Paired ${r.paired} case(s) against baseline ${name} (app ${base.app_commit ?? "?"}, ${base.at?.slice(0, 10) ?? "?"}, ${base.driver ?? "?"}).`);
  L.push(base.prompt_hash && cur.prompt_hash && base.prompt_hash !== cur.prompt_hash ? `prompt changed since baseline (${base.prompt_hash} -> ${cur.prompt_hash})` : `same prompt as baseline (${cur.prompt_hash ?? base.prompt_hash ?? "?"})`);
  const fl = (f: Flip) => `  ${f.id}${f.gap ? ` [${f.gap}]` : ""}${f.detail ? `: ${f.detail.slice(0, 160)}` : ""}`;
  const rt = (x: Rate) => `  ${x.id}: ${x.base.pass}/${x.base.k} -> ${x.cur.pass}/${x.cur.k} (${x.delta > 0 ? "+" : ""}${Math.round(x.delta * 100)} pts)`;
  if (r.regressions.length) L.push("Regressions (pass -> fail):", ...r.regressions.map(fl));
  if (r.improvements.length) L.push("Improvements (fail -> pass):", ...r.improvements.map(fl));
  if (r.gapFlips.length) L.push("Open gaps now failing (not counted):", ...r.gapFlips.map(fl));
  if (r.flaky.length) L.push("Down 1 of k (flaky, not counted):", ...r.flaky.map(rt));
  if (r.rates.length) L.push("Pass-rate changes (paired, per case):", ...r.rates.map(rt));
  if (r.added.length) L.push(`New cases: ${r.added.join(", ")}`);
  if (r.missing.length) L.push(`Missing from this run: ${r.missing.join(", ")}`);
  L.push(r.ok ? `no regression vs baseline ${name}${r.improvements.length ? ` (${r.improvements.length} improvement(s))` : ""}` : `${r.regressions.length} regression${r.regressions.length > 1 ? "s" : ""} vs baseline ${name}: ${r.regressions.map((f) => f.id).join(", ")}`);
  return L.join("\n");
}

// Which agent-facing text a run was taken on: every agent's orientation (MCP contract and full
// guide) and the standing instruction, built for the synthetic eval brain the agents run on.
export async function promptHash(root = join(import.meta.dir, "..", "fixtures", "synthetic")): Promise<string> {
  const mod = async (f: string) => existsSync(join(SRC, f)) ? await import(join(SRC, f)) : undefined;
  const [rulesM, brainM, carveM, orientM] = await Promise.all(["rules.ts", "brain.ts", "carve.ts", "orientation.ts"].map(mod));
  if (!rulesM || !brainM || !carveM || !orientM) return "none";
  const prev = process.env.PB_TODAY;
  process.env.PB_TODAY = "2026-10-08";
  try {
    const rules = rulesM.loadRules(root), notes = brainM.loadBrain(root);
    const parts = Object.keys(rules.policy.agents).sort().map((a) => { const o = orientM.orientation(rules, carveM.carve(notes, rules, carveM.grantFor(rules, a)), a, "mcp"); return `## ${a}\n${o.contract}\n${o.text}`; });
    if (orientM.standingInstruction) parts.push(orientM.standingInstruction(rules, "mcp"), orientM.standingInstruction(rules, "api"));
    return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
  } finally { if (prev === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = prev; }
}
