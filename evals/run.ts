#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// pocketBrain evals.
//   bun evals/run.ts                 deterministic suite: components + scripted (worst-case) scenarios
//   bun evals/run.ts --llm [--k 3]   adds the LLM-driven episodes and retrieval (a real model in each agent seat)
//   bun evals/run.ts --ci            deterministic suite, exits 1 on a regression (see gaps.ts for known gaps)
//   bun evals/run.ts --trend         scorecard history across commits
//   bun evals/run.ts --backfill      run the deterministic suite on every past commit of this repo
//   --only <prefix>   run cases whose id starts with prefix      --json   machine output
//   --save-baseline [name]   save per-case results to evals/baselines/<name|default>.json
//   --compare [name]         pair this run with that baseline by case id; exits 1 on a regression
//   --compare-files a.json b.json   pair two saved results or baseline files, running nothing
//   --k <n>   runs each llm case n times (pass^k: passes only if every run does; runs: {pass, k})
// The real brain is used when PB_BRAIN points at it (never modified: every case copies it).
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Case, Scored } from "./lib/case";
import { SRC } from "./lib/pb";
import { realBrainPath, TODAY, sh } from "./lib/sandbox";
import { usage, pool, AGENT_MODEL, JUDGE_MODEL } from "./lib/llm";
import { GAPS } from "./gaps";
import { compare, render, loadRun, loadBaseline, toBaseline, saveBaseline, promptHash } from "./lib/compare";
import { recordSwitchDay } from "./lib/switchday-history";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const HERE = import.meta.dir;
const OUT = join(HERE, "out");
const HISTORY = join(HERE, "history", "scorecard.jsonl");

if (flag("--trend")) { console.log(trend()); process.exit(0); }
if (flag("--backfill")) { await backfill(); process.exit(0); }
// An optional name after a flag: the next arg unless it is another flag.
const named = (f: string) => { const v = val(f); return v && !v.startsWith("--") ? v : "default"; };
if (flag("--compare-files")) {
  const [a, b] = [val("--compare-files"), args[args.indexOf("--compare-files") + 2]];
  if (!a || !b) { console.error("usage: --compare-files <baseline-or-results.json> <results.json>"); process.exit(2); }
  const A = loadRun(a), B = loadRun(b), r = compare(A.cases, B.cases);
  console.log(render(r, A.meta, B.meta));
  process.exit(r.ok ? 0 : 1);
}

const useLlm = flag("--llm");
const k = Number(val("--k") ?? 1);
const only = val("--only");

const { componentCases } = await import("./cases/components");
// A closed gap is a promise: its cases are must-hold again.
const openGap = (c: Case) => c.gap && !GAPS[c.gap]?.closed ? c.gap : undefined;
const optional = async (f: string, name: string, ...a: unknown[]): Promise<Case[]> => existsSync(join(HERE, "cases", f)) ? ((m) => typeof m === "function" ? m(...a) : m)((await import(`./cases/${f}`))[name]) : [];

let cases: Case[] = ([...componentCases, ...(await optional("e2e.ts", "e2eCases")), ...(await optional("dashboard.ts", "dashboardCases")), ...(await optional("real.ts", "realCases")), ...(await optional("cells.ts", "cellCases")), ...(await optional("textline.ts", "textlineCases")), ...(await optional("retrieval.ts", "retrievalCases", useLlm)), ...(await optional("orientation.ts", "orientationCases")), ...(await optional("judge.ts", "judgeCases")), ...(await optional("steps.ts", "stepCases")), ...(await optional("fill.ts", "fillCases")), ...(await optional("redteam.ts", "redteamCases")), ...(await optional("act.ts", "actCases")), ...(await optional("usage.ts", "usageCases")), ...(await optional("agents.ts", "agentCases")), ...(await optional("handoff.ts", "handoffCases")), ...(await optional("onboarding.ts", "onboardingCases")), ...(await optional("switchday.ts", "switchDayCases")), ...(await optional("consent.ts", "consentCases")), ...(await optional("say.ts", "sayCases")), ...(await optional("loop.ts", "loopCases")), ...(await optional("demo.ts", "demoCases"))]).map((c) => ({ ...c, gap: openGap(c) }));
if (!useLlm) cases = cases.filter((c) => !c.llm);
if (only) cases = cases.filter((c) => c.id.startsWith(only));

const scored: Scored[] = [];
const det = cases.filter((c) => !c.llm), withLlm = cases.filter((c) => c.llm);
for (const c of det) scored.push(await runOne(c));
scored.push(...(await pool(withLlm, Number(process.env.EVAL_CONCURRENCY ?? 4), runOne)));

async function runOne(c: Case): Promise<Scored> {
  const t0 = Date.now();
  const reps = c.llm && k > 1 ? k : 1, results = [];
  for (let i = 0; i < reps; i++) {
    try { results.push(await c.run()); } catch (e) { results.push({ pass: false as const, detail: `error: ${String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join(" | ")}` }); }
  }
  const passes = results.filter((r) => r.pass === true).length;
  const shown = results.find((r) => r.pass === false) ?? results.find((r) => r.pass === true) ?? results[0];
  // With --k, a case's metrics are the mean over its runs (each key over the runs that report it), printed with the line.
  const ms = results.map((r) => r.metrics).filter((m): m is Record<string, number> => !!m && Object.keys(m).length > 0);
  const keys = [...new Set(ms.flatMap((m) => Object.keys(m)))];
  const mean = (key: string) => { const xs = ms.map((m) => m[key]).filter((x) => typeof x === "number" && Number.isFinite(x)); return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : undefined; };
  const metrics = Object.fromEntries(keys.map((key) => [key, mean(key)]).filter(([, v]) => v !== undefined)) as Record<string, number>;
  const result = { ...shown, ...(Object.keys(metrics).length ? { metrics } : {}) };
  const s: Scored = { ...c, result, ms: Date.now() - t0, ...(reps > 1 && results.some((r) => r.pass !== "n/a") ? { runs: { pass: passes, k: reps } } : {}) };
  if (!flag("--json")) process.stderr.write(`${mark(s)} ${c.id}${s.runs ? ` (${passes}/${reps})` : ""}  ${result.detail ?? ""}`.slice(0, 400) + (reps > 1 && result.metrics ? ` | metrics: ${Object.entries(result.metrics).map(([key, v]) => `${key}=${v}`).join(" ")}` : "") + "\n");
  return s;
}

function mark(s: Scored) {
  if (s.result.pass === "n/a") return "·";
  if (s.result.pass) return s.gap ? "✓?" : "✓";
  return s.gap ? "~" : "✗";
}

// ---------------------------------------------------------------- scoring -----------------
const DIMS = ["carving", "write-quality", "conflicts", "idempotency", "upkeep", "relay", "retrieval", "e2e", "escalation"] as const;
const appCommit = sh(join(SRC, ".."), ["git", "rev-parse", "--short", "HEAD"]) || "uncommitted";
const dirty = sh(join(SRC, ".."), ["git", "status", "--porcelain", "--", "src"]) ? "+dirty" : "";
const brainCommit = realBrainPath() ? sh(realBrainPath()!, ["git", "rev-parse", "--short", "HEAD"]) : "none";

const byDim = Object.fromEntries(DIMS.map((d) => {
  const xs = scored.filter((s) => s.dimension === d && s.result.pass !== "n/a");
  const pass = xs.filter((s) => s.result.pass === true).length;
  const mustHold = xs.filter((s) => !s.gap);
  return [d, { total: xs.length, pass, rate: xs.length ? pass / xs.length : null, regressions: mustHold.filter((s) => !s.result.pass).length, knownGaps: xs.filter((s) => s.gap && !s.result.pass).length }];
}));

// AgentDojo-style episode metrics, per driver.
function episodeMetrics(driver: string) {
  const eps = scored.filter((s) => s.dimension === "e2e" && s.id.endsWith(`@${driver}`) && s.result.metrics);
  const m = (k: string) => eps.filter((e) => e.result.metrics![k] !== undefined);
  const avg = (xs: Scored[], k: string) => xs.length ? xs.reduce((a, e) => a + e.result.metrics![k], 0) / xs.length : null;
  const benign = eps.filter((e) => e.kind === "benign"), attack = eps.filter((e) => e.kind === "attack");
  return {
    episodes: eps.length,
    benign_utility: avg(m("utility").filter((e) => e.kind === "benign"), "utility"),
    utility_under_attack: avg(m("utility").filter((e) => e.kind === "attack"), "utility"),
    attack_success_rate: avg(attack, "attack_success"),
    agent_compliance_rate: driver === "llm" ? avg(m("agent_complied").filter((e) => e.kind === "attack"), "agent_complied") : null,
    invariant_violations: eps.reduce((a, e) => a + (e.result.metrics!.invariant_violations ?? 0), 0),
    pass_k: driver === "llm" ? avg(eps, "pass_k") : null,
    benign: benign.length, attack: attack.length,
  };
}
const scripted = episodeMetrics("scripted");
const llmM = useLlm ? episodeMetrics("llm") : undefined;
const retrievalM = (() => {
  const xs = scored.filter((s) => s.dimension === "retrieval" && s.result.metrics);
  const sum = (k: string) => xs.reduce((a, s) => a + (s.result.metrics![k] ?? 0), 0);
  return { coverage: sum("covered") / Math.max(1, sum("asked")), accuracy: useLlm ? sum("correct") / Math.max(1, sum("answered")) : null, refusal_ok: useLlm ? sum("refused_ok") / Math.max(1, sum("carved_asked")) : null, staleness_flagged: useLlm ? sum("stale_flagged") / Math.max(1, sum("stale_asked")) : null };
})();

const regressions = scored.filter((s) => !s.gap && s.result.pass === false);
const fixedGaps = scored.filter((s) => s.gap && s.result.pass === true);
const summary = {
  at: new Date().toISOString(), today: TODAY, app_commit: appCommit + dirty, brain_commit: brainCommit, prompt_hash: await promptHash(),
  driver: useLlm ? `scripted+llm(${AGENT_MODEL}, judge ${JUDGE_MODEL}, k=${k})` : "scripted",
  cases: scored.length, passed: scored.filter((s) => s.result.pass === true).length,
  regressions: regressions.length, known_gaps_open: scored.filter((s) => s.gap && s.result.pass === false).length,
  dims: byDim, scripted, llm: llmM, retrieval: retrievalM,
  llm_usage: useLlm ? { calls: usage.calls, usd: Math.round(usage.usd * 100) / 100 } : undefined,
};

if (flag("--json")) console.log(JSON.stringify({ summary, cases: scored.map(({ run, ...s }) => s) }, null, 2));
else {
  const md = scorecard(summary, scored);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "scorecard.md"), md);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ summary, cases: scored.map(({ run, ...s }) => s) }, null, 2));
  console.log(md);
}
if (!only && !flag("--no-history")) { mkdirSync(join(HERE, "history"), { recursive: true }); appendFileSync(HISTORY, JSON.stringify(summary) + "\n"); }
// Switch-day scores go to their own history file even with --only (the paid run is --only switchday).
if (!flag("--no-history")) recordSwitchDay(join(HERE, "history"), scored, { at: summary.at, app_commit: summary.app_commit });
if (flag("--save-baseline")) {
  const p = saveBaseline(toBaseline(named("--save-baseline"), summary, scored, summary.prompt_hash, useLlm ? { agent: AGENT_MODEL, judge: JUDGE_MODEL } : undefined));
  console.error(`baseline saved: ${p} (${scored.length} cases, prompt ${summary.prompt_hash})`);
}
let compareFailed = false;
if (flag("--compare")) {
  const base = loadBaseline(named("--compare"));
  // Pair only what this run could have run: the same --only prefix, and llm cases only with --llm.
  const inScope = base.cases.filter((c) => (!only || c.id.startsWith(only)) && (useLlm || !c.llm));
  const r = compare(inScope, scored.map((s) => ({ id: s.id, pass: s.result.pass, gap: s.gap, detail: s.result.detail, runs: s.runs })));
  console.error(render(r, base.meta, summary));
  compareFailed = !r.ok;
}
if (flag("--ci")) {
  for (const s of fixedGaps) console.error(`gap ${s.gap} looks fixed (${s.id} passes): close it in evals/gaps.ts`);
  if (regressions.length) { console.error(`${regressions.length} regression(s): ${regressions.map((s) => s.id).join(", ")}`); process.exit(1); }
}
if (compareFailed) process.exit(1);

// ---------------------------------------------------------------- rendering ---------------
function pct(x: number | null | undefined) { return x === null || x === undefined ? "n/a" : `${Math.round(x * 100)}%`; }
function scorecard(s: typeof summary, xs: Scored[]): string {
  const L: string[] = [];
  L.push(`# pocketBrain eval scorecard`, "", `${s.at.slice(0, 16).replace("T", " ")} UTC · app ${s.app_commit} · brain ${s.brain_commit} · ${s.driver}`, "");
  L.push(`**${s.passed}/${s.cases} cases pass · ${s.regressions} regressions · ${s.known_gaps_open} known gaps open**`, "");
  L.push("| Dimension | Pass | Known gaps open |", "|---|---|---|");
  for (const d of DIMS) { const x = s.dims[d]; if (x.total) L.push(`| ${d} | ${x.pass}/${x.total} (${pct(x.rate)}) | ${x.knownGaps} |`); }
  if (s.scripted.episodes || s.llm) L.push("", "## End-to-end episodes", "", "| Driver | Episodes | Benign utility | Utility under attack | Attack success (system) | Agent complied with attack | Invariant violations | pass^k |", "|---|---|---|---|---|---|---|---|");
  if (s.scripted.episodes || s.llm) for (const [name, m] of [["scripted (worst-case agent)", s.scripted], ...(s.llm ? [[`llm`, s.llm]] : [])] as const)
    L.push(`| ${name} | ${m.episodes} | ${pct(m.benign_utility)} | ${pct(m.utility_under_attack)} | ${pct(m.attack_success_rate)} | ${pct(m.agent_compliance_rate)} | ${m.invariant_violations} | ${pct(m.pass_k)} |`);
  if (s.dims.retrieval?.total) L.push("", `Retrieval: answer present in the agent's view ${pct(s.retrieval.coverage)}; answered correctly ${pct(s.retrieval.accuracy)}; carved facts declined ${pct(s.retrieval.refusal_ok)}; stale or disputed facts flagged ${pct(s.retrieval.staleness_flagged)}.`);
  if (s.llm_usage) L.push("", `Model use: ${s.llm_usage.calls} calls, about $${s.llm_usage.usd}.`);
  const open = Object.entries(GAPS).filter(([id]) => xs.some((x) => x.gap === id && x.result.pass === false));
  if (open.length) {
    L.push("", "## Gaps found (each with a proposed fix)", "");
    for (const [id, g] of open) {
      const hit = xs.filter((x) => x.gap === id && x.result.pass === false);
      L.push(`### ${id}. ${g.title} (${g.severity})`, "", g.finding, "", `**Fix:** ${g.fix}`, "", `Cases: ${hit.map((h) => `\`${h.id}\``).join(", ")}`, "");
    }
  }
  if (regressions.length) { L.push("## Regressions", ""); for (const r of regressions) L.push(`- \`${r.id}\` (${r.dimension}): ${r.title}. ${r.result.detail ?? ""}`); L.push(""); }
  L.push("## All cases", "", "✓ pass · ✗ fail (regression) · ~ known gap · ✓? known gap now passing · · n/a", "");
  for (const d of DIMS) {
    const ds = xs.filter((x) => x.dimension === d);
    if (!ds.length) continue;
    L.push(`**${d}**`, "");
    for (const x of ds) L.push(`- ${mark(x)} \`${x.id}\` ${x.title}${x.result.detail ? `: ${x.result.detail}` : ""}`);
    L.push("");
  }
  return L.join("\n");
}

function trend(): string {
  if (!existsSync(HISTORY)) return "no history yet";
  const rows = readFileSync(HISTORY, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = new Map<string, any>();
  for (const r of rows) last.set(`${r.app_commit}|${r.driver.startsWith("scripted+") ? "llm" : "det"}`, r);
  const L = ["| App commit | Driver | Cases pass | Regressions | Gaps open | Carving | Writes | Conflicts | Idempotency | Upkeep | Relay |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of last.values()) {
    const d = (k: string) => (r.dims[k]?.total ? `${r.dims[k].pass}/${r.dims[k].total}` : "n/a");
    L.push(`| ${r.app_commit} | ${r.driver.split("(")[0]} | ${r.passed}/${r.cases} | ${r.regressions} | ${r.known_gaps_open} | ${d("carving")} | ${d("write-quality")} | ${d("conflicts")} | ${d("idempotency")} | ${d("upkeep")} | ${d("relay")} |`);
  }
  return L.join("\n");
}

async function backfill() {
  const repo = join(HERE, "..");
  const commits = sh(repo, ["git", "log", "--reverse", "--format=%h"]).split("\n").filter(Boolean);
  for (const c of commits) {
    const wt = join(tmpdir(), `pb-eval-wt-${c}`);
    rmSync(wt, { recursive: true, force: true });
    sh(repo, ["git", "worktree", "add", "-f", "--detach", wt, c]);
    const p = Bun.spawnSync(["bun", join(HERE, "run.ts"), "--json"], { env: { ...process.env, PB_SRC: join(wt, "src") }, stdout: "pipe", stderr: "pipe" });
    sh(repo, ["git", "worktree", "remove", "--force", wt]);
    try {
      const j = JSON.parse(p.stdout.toString());
      j.summary.app_commit = c; // the worktree's own HEAD
      console.error(`${c}: ${j.summary.passed}/${j.summary.cases}, ${j.summary.regressions} regressions`);
    } catch { console.error(`${c}: run failed: ${p.stderr.toString().slice(0, 300)}`); }
  }
  console.log(trend());
}
