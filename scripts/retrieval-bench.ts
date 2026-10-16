// SPDX-License-Identifier: AGPL-3.0-only
// Scores retrieval on the golden questions in $PB_BRAIN/evals/retrieval.yaml
// (retrieval-capture.md section 2). Runs on a throwaway copy because core.ts logs reads.
//
//   bun scripts/retrieval-bench.ts --brain <path> [--json out.json] [--extra <ranker.ts>]
//
// Prints one table per ranker: hit@1, recall@5, MRR, answer-in-context, context size, and
// any forbidden note that came back. Reports name question ids, never note values.
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import * as core from "../src/core";
import { buildIndex, rank, pack } from "../src/retrieve";

interface Q { id: string; kind: string; q: string; as?: string; want: string[]; answer?: string; forbid?: string[] }
interface Run { ids: string[]; context: string }
export type Ranker = (agent: string, q: string) => Run;

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const src = arg("--brain") ?? process.env.PB_BRAIN;
if (!src) throw new Error("--brain or PB_BRAIN required");
const root = mkdtempSync(join(tmpdir(), "pb-ret-"));
cpSync(src, root, { recursive: true });
const golden: Q[] = YAML.parse(readFileSync(join(src, "evals", "retrieval.yaml"), "utf8")).questions;

const notes = loadBrain(root);
const rules = loadRules(root);
const indexes = new Map<string, ReturnType<typeof buildIndex>>();
const idx = (agent: string) => {
  if (!indexes.has(agent)) indexes.set(agent, buildIndex(carve(notes, rules, grantFor(rules, agent)), rules));
  return indexes.get(agent)!;
};

const rankers: Record<string, Ranker> = {
  "substring (today)": (a, q) => ({ ids: core.search(root, a, q, 20).map((h) => h.id), context: core.contextPack(root, a, q) }),
  "bm25": (a, q) => ({ ids: rank(idx(a), q, 20, { synonyms: false }).map((h) => h.id), context: pack(idx(a), q, { synonyms: false }).text }),
  "bm25 + synonyms": (a, q) => ({ ids: rank(idx(a), q, 20).map((h) => h.id), context: pack(idx(a), q).text }),
};
const extra = arg("--extra");
if (extra) Object.assign(rankers, await (await import(extra.startsWith("/") ? extra : join(process.cwd(), extra))).rankers({ root, notes, rules, idx, golden }));

function score(r: Run, g: Q) {
  const pos = g.want.length ? r.ids.findIndex((id) => g.want.includes(id)) : -1;
  const leaked = (g.forbid ?? []).filter((f) => r.ids.includes(f));
  return {
    hit1: g.want.length ? pos === 0 : r.ids.every((id) => !(g.forbid ?? []).includes(id)),
    r5: g.want.length ? pos >= 0 && pos < 5 : leaked.length === 0,
    rr: g.want.length ? (pos >= 0 ? 1 / (pos + 1) : 0) : (leaked.length ? 0 : 1),
    ans: g.answer ? r.context.toLowerCase().includes(g.answer.toLowerCase()) : undefined,
    bytes: r.context.length,
    leaked,
    pos,
  };
}

const report: Record<string, unknown> = {};
for (const [name, fn] of Object.entries(rankers)) {
  const rows = golden.map((g) => ({ g, s: score(fn(g.as ?? "steward", g.q), g) }));
  const kinds = [...new Set(golden.map((g) => g.kind)), "all"];
  console.log(`\n## ${name}\n`);
  console.log("| kind | n | hit@1 | recall@5 | MRR | answer in context | avg context chars |");
  console.log("|---|---|---|---|---|---|---|");
  const summary: Record<string, unknown> = {};
  for (const k of kinds) {
    const rs = rows.filter((r) => k === "all" || r.g.kind === k);
    const withAns = rs.filter((r) => r.s.ans !== undefined);
    const pct = (n: number, d: number) => d ? `${Math.round(100 * n / d)}%` : "-";
    const line = {
      n: rs.length,
      hit1: pct(rs.filter((r) => r.s.hit1).length, rs.length),
      r5: pct(rs.filter((r) => r.s.r5).length, rs.length),
      mrr: (rs.reduce((a, r) => a + r.s.rr, 0) / rs.length).toFixed(2),
      ans: `${pct(withAns.filter((r) => r.s.ans).length, withAns.length)} of ${withAns.length}`,
      chars: Math.round(rs.reduce((a, r) => a + r.s.bytes, 0) / rs.length),
    };
    summary[k] = line;
    console.log(`| ${k} | ${line.n} | ${line.hit1} | ${line.r5} | ${line.mrr} | ${line.ans} | ${line.chars} |`);
  }
  const misses = rows.filter((r) => !r.s.r5 || r.s.ans === false).map((r) => `${r.g.id}${r.s.r5 ? "" : `(rank ${r.s.pos < 0 ? "none" : r.s.pos + 1})`}${r.s.ans === false ? "(answer not in context)" : ""}${r.s.leaked.length ? "(FORBIDDEN RETURNED)" : ""}`);
  console.log(`\nmisses: ${misses.join(", ") || "none"}`);
  report[name] = { summary, rows: rows.map((r) => ({ id: r.g.id, kind: r.g.kind, ...r.s, leaked: r.s.leaked.length })) };
}
const out = arg("--json");
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
