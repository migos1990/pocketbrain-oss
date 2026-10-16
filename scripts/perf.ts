// SPDX-License-Identifier: AGPL-3.0-only
// Scale check (docs/perf.md): build a synthetic brain the size of a few years of daily use, then
// time what the hub does every day against budgets. Synthetic data only; never point it at a
// real brain.
//   bun scripts/perf.ts [--notes 10000] [--days 365] [--runs 5] [--keep] [--json]
//   bun scripts/perf.ts --gen <dir> [--notes N] [--days D]   only build the brain (crash tests use it)
// Exits 1 when a median is over its budget.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const EXAMPLE = join(import.meta.dir, "..", "examples", "brain");
const AGENTS = ["steward", "planner", "helper"];
const TYPES: [dir: string, type: string, share: number][] = [["people", "person", 0.4], ["orgs", "org", 0.1], ["projects", "project", 0.2], ["decisions", "decision", 0.1], ["notes", "note", 0.2]];
const WORDS = "budget grade course meeting invoice launch draft review client contract renewal schedule travel dentist school lease insurance garden recipe workshop hiring quarterly roadmap pilot".split(" ");

// A small deterministic generator, so two runs build the same brain.
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const day = (start: string, plus: number) => new Date(Date.parse(start) + plus * 86_400_000).toISOString().slice(0, 10);

export interface Synth { root: string; ids: string[]; today: string; area: Map<string, string> }

// Notes, a year of journal lines and read log, and a git history of one commit per write,
// written with git fast-import so 10k notes and their history take seconds, not hours.
export function synthBrain(root: string, o: { notes?: number; days?: number; seed?: number } = {}): Synth {
  const n = o.notes ?? 10_000, days = o.days ?? 365, r = rng(o.seed ?? 7);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  // Names, places and companies: real values are mostly distinct words, not a small vocabulary.
  const SYL = "ka lo mi ne ra so tu vi be da fe go hi ju ma no pe ri sa te".split(" ");
  const name = () => { const w = Array.from({ length: 2 + Math.floor(r() * 2) }, () => pick(SYL)).join(""); return w[0].toUpperCase() + w.slice(1); };
  const start = "2025-10-15", today = day(start, days);
  mkdirSync(root, { recursive: true });
  cpSync(join(EXAMPLE, "rules"), join(root, "rules"), { recursive: true });
  const files = new Map<string, string>();
  const ids: string[] = [];
  const areas = new Map<string, string>();
  for (const [dir, type, share] of TYPES) {
    for (let i = 0; i < Math.round(n * share); i++) {
      const id = `${dir}/${type}-${String(i).padStart(5, "0")}`;
      ids.push(id);
      const area = r() < 0.5 ? "work" : "personal";
      areas.set(id, area);
      const facts: Record<string, unknown> = {};
      for (let k = 0; k < 2 + Math.floor(r() * 4); k++) {
        const as_of = day(start, Math.floor(r() * days));
        facts[k === 0 && type === "person" ? "role" : k === 0 && type === "project" ? "next_step" : `${pick(WORDS)}_${k}`] = { value: `${name()} ${pick(WORDS)} ${Math.floor(r() * 1000)}`, as_of, sources: [`gmail:${(i * 31 + k).toString(16).padStart(16, "0")}`], verification: "verified-by-source", by: pick(AGENTS), recorded: as_of };
      }
      const fm = { id, type, title: `${type} ${i} ${pick(WORDS)}`, area, sensitivity: r() < 0.15 ? "private" : "personal", status: "active", created: start, updated: today, by: pick(AGENTS), facts };
      const body = Array.from({ length: 1 + Math.floor(r() * 4) }, () => `${pick(WORDS)} ${pick(WORDS)} with [[${ids[Math.floor(r() * ids.length)]}]] about ${pick(WORDS)}.`).join(" ");
      files.set(`${id}.md`, `---\n${YAML.stringify(fm, { lineWidth: 0 })}---\n${body}\n`);
    }
  }
  // A year of journal lines: about ten a day across the agents, one file per agent and month.
  const journal = new Map<string, string[]>();
  for (let d = 0; d < days; d++) for (let k = 0; k < 10; k++) {
    const a = pick(AGENTS), date = day(start, d), f = `journal/${a}/${date.slice(0, 7)}.md`;
    (journal.get(f) ?? journal.set(f, [`# ${a} journal, ${date.slice(0, 7)}`, ""]).get(f)!).push(`- ${date} ${pick(WORDS)} call about [[${pick(ids)}]], ${pick(WORDS)} ${pick(WORDS)}`);
  }
  for (const [f, lines] of journal) files.set(f, lines.join("\n") + "\n");

  // History: the bulk import, then one small commit per day per write (about 20 a day).
  const fi: string[] = [];
  let mark = 0;
  const blob = (text: string) => { const b = Buffer.from(text); fi.push(`blob\nmark :${++mark}\ndata ${b.length}\n${text}\n`); return mark; };
  const commit = (who: string, date: string, msg: string, changed: [string, string][]) => {
    const marks = changed.map(([p, t]) => [p, blob(t)] as const);
    const t = Math.floor(Date.parse(`${date}T12:00:00Z`) / 1000);
    const m = Buffer.from(msg);
    fi.push(`commit refs/heads/main\nmark :${++mark}\nauthor ${who} <${who}@pocketbrain.local> ${t} +0000\ncommitter ${who} <${who}@pocketbrain.local> ${t} +0000\ndata ${m.length}\n${msg}\n${marks.map(([p, b]) => `M 100644 :${b} ${p}`).join("\n")}\n\n`);
  };
  const rulesText = readdirSync(join(root, "rules")).map((f) => [`rules/${f}`, readFileSync(join(root, "rules", f), "utf8")] as [string, string]);
  commit("louis", start, "synthetic brain", [...rulesText, ...files]);
  const writes: string[] = [];
  for (let d = 1; d <= days; d++) for (let k = 0; k < 20; k++) {
    const id = pick(ids), who = pick(AGENTS), date = day(start, d), attr = `${pick(WORDS)}_1`;
    const text = files.get(`${id}.md`)!.replace(/updated: \S+/, `updated: ${date}`);
    files.set(`${id}.md`, text);
    commit(who, date, `${who}: ${id}#${attr} (synthetic)`, [[`${id}.md`, text]]);
    // Its write-log line, the size the hub writes (the chain's two hashes are stand-ins).
    const h = (d * 20 + k).toString(16).padStart(64, "0");
    writes.push(JSON.stringify({ at: `${date}T12:00:00.000Z`, agent: who, kind: "fact", key: `${id}#${attr}`, outcome: "committed", step: 1, checks: [], prev: h, hash: h }));
  }
  const env = { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "louis@pocketbrain.local", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "louis@pocketbrain.local" };
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: root, env });
  const imp = Bun.spawnSync(["git", "fast-import", "--quiet"], { cwd: root, env, stdin: Buffer.from(fi.join("")) });
  if (imp.exitCode !== 0) throw new Error(`fast-import: ${imp.stderr.toString()}`);
  Bun.spawnSync(["git", "checkout", "-q", "-f", "main"], { cwd: root, env });

  // A year of read log, as agents leave it (about 100 reads a day), hash chain left out: the
  // hub only reads it.
  mkdirSync(join(root, "log"), { recursive: true });
  const reads: string[] = [];
  for (let d = 0; d < days; d++) for (let k = 0; k < 100; k++) reads.push(JSON.stringify({ at: `${day(start, d)}T${String(k % 24).padStart(2, "0")}:00:00.000Z`, agent: pick(AGENTS), op: pick(["search", "read", "context_pack"]), ids: [pick(ids), pick(ids)] }));
  writeFileSync(join(root, "log", "reads.jsonl"), reads.join("\n") + "\n");
  writeFileSync(join(root, "log", "writes.jsonl"), writes.join("\n") + "\n");
  return { root, ids, today, area: areas };
}

// ---------- timing ----------

// Medians at 10k notes and a year of use (docs/perf.md). "search after a write" includes
// bringing the reader's cell up to date, in place, rewriting only the notes the write reaches.
export const BUDGETS_MS: Record<string, number> = {
  "search (warm)": 300,
  "context_pack": 500,
  "write (remember)": 1500,
  "search after a write": 500,
  "whats_new": 1500,
  "sleep pass (forget + consolidate scan)": 120_000,
  "backup": 60_000,
  "git gc --auto (night housekeeping)": 120_000,
};

// Disk after a year (docs/perf.md): the brain's .git once the night's gc ran, and log/ (the
// hash-chained read and write logs, never cut). Hub logs rotate at 10 MB x 3 (src/growth.ts).
export const BUDGETS_MB: Record<string, number> = {
  ".git after a year (after gc)": 512,
  "log/ after a year": 256,
};

async function time(fn: () => unknown | Promise<unknown>): Promise<number> { const t = performance.now(); await fn(); return performance.now() - t; }
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main(argv: string[]): Promise<number> {
  const num = (f: string, d: number) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
  const gen = argv.indexOf("--gen");
  if (gen >= 0) { const s = synthBrain(argv[gen + 1], { notes: num("--notes", 10_000), days: num("--days", 365) }); console.log(`${s.root}: ${s.ids.length} notes, today ${s.today}`); return 0; }

  const root = mkdtempSync(join(tmpdir(), "pb-perf-"));
  const t0 = performance.now();
  const s = synthBrain(root, { notes: num("--notes", 10_000), days: num("--days", 365) });
  const genMs = performance.now() - t0;
  process.env.PB_TODAY = s.today;
  process.env.PB_NOW = `${s.today}T12:00:00Z`;
  // Imported after PB_TODAY is set, as the hub would be started.
  const { useCells, buildCells } = await import("../src/cell");
  const core = await import("../src/core");
  const { sleep } = await import("../src/sleep");
  const { makeModel } = await import("../src/model");
  const { backup } = await import("../src/backup");
  useCells(true);
  const tb = performance.now(); buildCells(root); const cellsMs = performance.now() - tb;

  const runs = num("--runs", 5);
  const out: Record<string, number[]> = {};
  const add = (k: string, ms: number) => (out[k] ??= []).push(ms);
  for (let i = 0; i < runs; i++) {
    add("search (warm)", await time(() => core.search(root, "planner", `${WORDS[i]} course`)));
    add("context_pack", await time(() => core.contextPack(root, "planner", WORDS[i + 3])));
    add("write (remember)", await time(() => core.remember(root, "steward", { id: s.ids[i * 7], attribute: `perf_${i}`, value: `value ${i}`, as_of: s.today, sources: [`gmail:${String(i).padStart(16, "a")}`] })));
    add("search after a write", await time(() => core.search(root, "planner", "budget review")));
    add("whats_new", await time(() => core.whatsNew(root, "planner", `${s.today.slice(0, 8)}01T00:00:00Z`)));
  }
  const fake = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [] }) });
  add("sleep pass (forget + consolidate scan)", await time(() => sleep(root, { model: fake, maxProposals: 0 })));
  if (Bun.which("age")) {
    const key = Bun.spawnSync(["age-keygen"]).stdout.toString().match(/age1[0-9a-z]+/)![0];
    add("backup", await time(() => backup(root, { dest: join(root, "..", `${root.split("/").pop()}-backups`), recipients: [key], record: false })));
  }

  const { gcAuto, diskUse } = await import("../src/growth");
  const before = diskUse(root, join(root, "no-hub-logs")).git;
  add("git gc --auto (night housekeeping)", await time(() => gcAuto(root)));
  const disk = diskUse(root, join(root, "no-hub-logs"));
  const mbOf = (b: number) => Math.round(b / 104857.6) / 10;
  const diskRows = [{ step: ".git after a year (after gc)", mb: mbOf(disk.git), before_gc_mb: mbOf(before) }, { step: "log/ after a year", mb: mbOf(disk.log) }].map((r) => ({ ...r, budget_mb: BUDGETS_MB[r.step], over: r.mb > BUDGETS_MB[r.step] }));

  const rows = Object.entries(out).map(([k, xs]) => ({ step: k, median_ms: Math.round(median(xs)), max_ms: Math.round(Math.max(...xs)), budget_ms: BUDGETS_MS[k], over: median(xs) > (BUDGETS_MS[k] ?? Infinity) }));
  if (argv.includes("--json")) console.log(JSON.stringify({ notes: s.ids.length, days: num("--days", 365), gen_ms: Math.round(genMs), cells_ms: Math.round(cellsMs), rows, disk: diskRows }, null, 2));
  else {
    console.log(`synthetic brain: ${s.ids.length} notes, ${num("--days", 365)} days (built in ${(genMs / 1000).toFixed(1)} s; cells ${(cellsMs / 1000).toFixed(1)} s)`);
    for (const r of rows) console.log(`${r.over ? "✗" : "✓"} ${r.step.padEnd(40)} median ${String(r.median_ms).padStart(7)} ms  max ${String(r.max_ms).padStart(7)} ms  budget ${r.budget_ms ?? "-"} ms`);
    for (const r of diskRows) console.log(`${r.over ? "✗" : "✓"} ${r.step.padEnd(40)} ${String(r.mb).padStart(7)} MB${"before_gc_mb" in r ? ` (before gc ${r.before_gc_mb} MB)` : ""}  budget ${r.budget_mb} MB`);
  }
  if (!argv.includes("--keep")) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}-backups`, { recursive: true, force: true }); }
  else console.log(`kept ${root}`);
  return rows.some((r) => r.over) || diskRows.some((r) => r.over) ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
