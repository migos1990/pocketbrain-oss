// SPDX-License-Identifier: AGPL-3.0-only
// Context sizes on a synthetic brain (backlog 290, docs/perf.md "Context sizes"): what each agent
// is handed by orientation, context_pack (whole view and by topic) and whats_new, in estimated
// tokens, before and after its context budget. Synthetic data only; never point it at a real brain.
//   bun scripts/context-size.ts [--notes 10000] [--json]
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthBrain } from "./perf";

const argv = process.argv.slice(2);
const num = (f: string, d: number) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
const root = mkdtempSync(join(tmpdir(), "pb-ctx-"));
const s = synthBrain(root, { notes: num("--notes", 10_000), days: 365 });
process.env.PB_TODAY = s.today;
process.env.PB_NOW = `${s.today}T12:00:00Z`;
const core = await import("../src/core");
const { loadBrain } = await import("../src/brain");
const { loadRules } = await import("../src/rules");
const { carve, grantFor } = await import("../src/carve");
const { renderView } = await import("../src/view");
const { tokensOf, contextBudget } = await import("../src/context");

const rules = loadRules(root), notes = loadBrain(root);
const rows: Record<string, unknown>[] = [];
const last = () => readFileSync(join(root, "log", "reads.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
for (const agent of ["steward", "planner", "helper"]) {
  const b = contextBudget(rules, agent);
  const whole = tokensOf(renderView(notes, rules, carve(notes, rules, grantFor(rules, agent)), root));
  core.orientation(root, agent, "mcp"); const o = last();
  core.contextPack(root, agent); const w = last();
  core.contextPack(root, agent, "budget meeting"); const t = last();
  core.whatsNew(root, agent, `${s.today.slice(0, 8)}01T00:00:00Z`); const n = last();
  rows.push({ agent, budget: b, orientation: o.tokens, whole_view_uncut: whole, whole_view_sent: w.tokens, whole_view_cut: w.cut ?? 0, topic_sent: t.tokens, topic_cut: t.cut ?? 0, whats_new_sent: n.tokens, whats_new_cut: n.cut ?? 0 });
}
if (argv.includes("--json")) console.log(JSON.stringify({ notes: s.ids.length, rows }, null, 2));
else {
  console.log(`${s.ids.length} synthetic notes, today ${s.today}; tokens = characters / 4`);
  for (const r of rows) console.log(`${r.agent}: orientation ${r.orientation} | whole view ${r.whole_view_uncut} -> ${r.whole_view_sent} (${r.whole_view_cut} notes cut) | topic ${r.topic_sent} (${r.topic_cut} cut) | whats_new ${r.whats_new_sent} (${r.whats_new_cut} cut)`);
}
rmSync(root, { recursive: true, force: true });
