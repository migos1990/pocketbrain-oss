// SPDX-License-Identifier: AGPL-3.0-only
// Scale check (docs/perf.md): build a synthetic brain the size of a few years of daily use, then
// time what the hub does every day against budgets. Synthetic data only; never point it at a
// real brain.
//   bun scripts/perf.ts [--notes 10000] [--days 365] [--runs 5] [--keep] [--json] [--progress]
//   bun scripts/perf.ts --gen <dir> [--notes N] [--days D]   only build the brain (crash tests use it)
// Exits 1 when a median is over its budget.
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
export function synthBrain(root: string, o: { notes?: number; days?: number; seed?: number; inbox?: number } = {}): Synth {
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

  // The read log, as agents leave it (about 100 reads a day): the fields the hub writes (src/core.ts
  // logRead), a search's words and the notes it handed over, and the real hash chain, so its size
  // and the archive's chain check are what a real brain's would be (backlog row 324).
  mkdirSync(join(root, "log"), { recursive: true });
  const reads: string[] = [];
  let prev = "0".repeat(64);
  for (let d = 0; d < days; d++) for (let k = 0; k < 100; k++) {
    const op = pick(["search", "search", "read", "context_pack", "whats_new"]);
    const n = op === "read" ? 1 : op === "search" ? 3 + Math.floor(r() * 6) : 5 + Math.floor(r() * 8);
    const e = { at: `${day(start, d)}T${String(k % 24).padStart(2, "0")}:${String(k % 60).padStart(2, "0")}:00.000Z`, agent: pick(AGENTS), op, ids: Array.from({ length: n }, () => pick(ids)), ...(op === "search" || op === "context_pack" ? { q: `${pick(WORDS)} ${pick(WORDS)}` } : {}), tokens: 200 + Math.floor(r() * 4000), prev };
    const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(e)).digest("hex");
    reads.push(JSON.stringify({ ...e, hash }));
    prev = hash;
  }
  writeFileSync(join(root, "log", "reads.jsonl"), reads.join("\n") + "\n");
  writeFileSync(join(root, "log", "writes.jsonl"), writes.join("\n") + "\n");
  // A year of alerts (about five a day) and an inbox left to fill up: the owner's longest lists
  // on the dashboard (backlog #295). Inbox files are hub state the pages read, not commits.
  const alerts: string[] = [];
  for (let d = 0; d < days; d++) for (let k = 0; k < 5; k++) alerts.push(JSON.stringify({ at: `${day(start, d)}T${String(8 + k).padStart(2, "0")}:00:00.000Z`, check: pick(["leak_tripwire", "budget", "hub", "capture_held", "write_conflict"]), agent: pick(AGENTS), detail: `${pick(WORDS)} ${pick(WORDS)}` }));
  writeFileSync(join(root, "log", "alerts.jsonl"), alerts.join("\n") + "\n");
  mkdirSync(join(root, "inbox"), { recursive: true });
  for (let i = 0; i < (o.inbox ?? 1000); i++) {
    const id = pick(ids), who = pick(AGENTS), date = day(start, Math.floor(r() * days));
    const request = { agent: who, id, attribute: `${pick(WORDS)}_${i}`, value: `${name()} ${pick(WORDS)}`, as_of: date, sources: [`gmail:${(i * 7919).toString(16).padStart(16, "0")}`] };
    writeFileSync(join(root, "inbox", `${date}-${who}-${i.toString(16).padStart(8, "0")}.yaml`), YAML.stringify({ proposed: date, by: who, reason: `${who} is a trial agent: propose-only`, checks: [], request }, { lineWidth: 0 }));
  }
  return { root, ids, today, area: areas };
}

// ---------- timing ----------

// Medians at 10k notes and a year of use (docs/perf.md), the default run. "search after a write" includes
// The owner's pages timed by the perf run; {id} is a note, {day} the synthetic brain's last day.
export const DASHBOARD_PAGES = ["/", "/?page=2", "/agents", "/brain", "/brain?kind=people", "/brain?q=budget", "/note/{id}", "/history", "/history/{id}", "/history?at={day}", "/map", "/map?page=3", "/activity", "/activity?page=5", "/people", "/agent/planner", "/agent/planner?page=4"];

// Medians at 10k notes and a year of use (docs/perf.md). "search after a write" includes
// bringing the reader's cell up to date, in place, rewriting only the notes the write reaches.
export const BUDGETS_MS: Record<string, number> = {
  "search (warm)": 300,
  "context_pack": 500,
  "write (remember)": 1500,
  // 500 ms until carves withheld carved values in every title (G56). The incremental carve brought
  // it to about 0.5 s again; the rest is reading every note file and the cell's own work (docs/perf.md).
  "search after a write": 750,
  "whats_new": 1500,
  "whats_new (from its cursor)": 1500,
  "read log archive (night housekeeping)": 30_000,
  "sleep pass (forget + consolidate scan)": 120_000,
  // The rest of the night pass (src/start.ts): upkeep's scan, the check that every note can be
  // found by its title (it didn't finish at 10k notes until foundBy, src/retrieve.ts), and the
  // memory-sync pass.
  "upkeep (night)": 30_000,
  "searchable check (night)": 60_000,
  "memory sync pass (night)": 30_000,
  "backup": 60_000,
  "restart to first answer": 10_000,
  "git gc --auto (night housekeeping)": 120_000,
  // The owner's pages (backlog #295): every list a page at a time, the page state kept between
  // requests. The first page after a write carves each assistant again, so it gets its own row.
  ...Object.fromEntries(DASHBOARD_PAGES.map((p) => [`dashboard ${p}`, 300])),
  "dashboard /agent/planner (new minute)": 300,
  "dashboard / (first after a write)": 8000,
  // History after a write carves nobody: a page carves an assistant only to show what it sees (#320).
  "dashboard /history (first after a write)": 300,
};

// At 50k notes and three years (--notes 50000 --days 1095), where a brain that lasts years
// gets to (docs/perf.md "At 50k notes"). Writes and the first read after one carve the whole
// brain, so they grow with it; these hold today's numbers with room, not a target.
export const BUDGETS_50K_MS: Record<string, number> = {
  ...BUDGETS_MS,
  "write (remember)": 5_000,
  "search after a write": 6_000,
  "restart to first answer": 12_000,
  "upkeep (night)": 120_000,
  "searchable check (night)": 300_000,
  "memory sync pass (night)": 180_000,
};
// The hub's peak resident memory over the run (one process: server, cells, nightly jobs). At 50k
// it was 8 GB until the run also timed the night pass's searchable check and memory-sync pass,
// which the hub always ran but this didn't: 8.2 GB with them (docs/perf.md, "The night pass").
export const PEAK_MB = { at10k: 2_048, at50k: 9_216 };

// Disk after a year (docs/perf.md): the brain's .git once the night's gc ran, and log/ (the
// hash-chained logs). Hub logs rotate at 10 MB x 3 (src/growth.ts). The read log's live file
// holds the last 120 days whatever the brain's age (src/readlog.ts rotateReadLog); every read
// path that looks at it parses it whole.
export const BUDGETS_MB: Record<string, number> = {
  ".git after a year (after gc)": 512,
  "log/ after a year": 256,
  "read log, live file": 16,
};

async function time(fn: () => unknown | Promise<unknown>): Promise<number> { const t = performance.now(); await fn(); return performance.now() - t; }
// Resident memory, sampled after each step; the hub is one process, so this is its footprint.
let peakRss = 0;
const rssMb = () => { const r = process.memoryUsage().rss; peakRss = Math.max(peakRss, r); return Math.round(r / 2 ** 20); };
// --progress prints each step to stderr as it ends, so a run too slow to finish still says where.
let progress = false;
const step = (what: string, ms: number) => { const mb = rssMb(); if (progress) console.error(`  ${what}: ${Math.round(ms)} ms, rss ${mb} MB`); };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main(argv: string[]): Promise<number> {
  const num = (f: string, d: number) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
  const gen = argv.indexOf("--gen");
  if (gen >= 0) { const s = synthBrain(argv[gen + 1], { notes: num("--notes", 10_000), days: num("--days", 365) }); console.log(`${s.root}: ${s.ids.length} notes, today ${s.today}`); return 0; }

  progress = argv.includes("--progress");
  const root = mkdtempSync(join(tmpdir(), "pb-perf-"));
  const t0 = performance.now();
  const s = synthBrain(root, { notes: num("--notes", 10_000), days: num("--days", 365) });
  const genMs = performance.now() - t0;
  step("generate", genMs);
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
  step("cells at start", cellsMs);

  const runs = num("--runs", 5);
  const out: Record<string, number[]> = {};
  const add = (k: string, ms: number) => { step(k, ms); (out[k] ??= []).push(ms); };
  // Every night's housekeeping archives the read log, so the read paths below run on the live
  // file a brain this old would have: the window, not all of it.
  const { rotateReadLog, verifyReadLog } = await import("../src/readlog");
  const readsFile = join(root, "log", "reads.jsonl");
  const readsBefore = statSync(readsFile).size;
  add("read log archive (night housekeeping)", await time(() => rotateReadLog(root)));
  if (verifyReadLog(root).broken) throw new Error("the archived read log's chain doesn't verify");
  for (let i = 0; i < runs; i++) {
    add("search (warm)", await time(() => core.search(root, "planner", `${WORDS[i]} course`)));
    add("context_pack", await time(() => core.contextPack(root, "planner", WORDS[i + 3])));
    add("write (remember)", await time(() => core.remember(root, "steward", { id: s.ids[i * 7], attribute: `perf_${i}`, value: `value ${i}`, as_of: s.today, sources: [`gmail:${String(i).padStart(16, "a")}`] })));
    add("search after a write", await time(() => core.search(root, "planner", "budget review")));
    add("whats_new", await time(() => core.whatsNew(root, "planner", `${s.today.slice(0, 8)}01T00:00:00Z`)));
    add("whats_new (from its cursor)", await time(() => core.whatsNew(root, "helper")));
  }
  const fake = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [] }) });
  add("sleep pass (forget + consolidate scan)", await time(() => sleep(root, { model: fake, maxProposals: 0 })));
  {
    const { upkeep } = await import("../src/upkeep");
    const { unsearchable } = await import("../src/probe");
    const { syncPass } = await import("../src/memsync");
    add("upkeep (night)", await time(() => upkeep(root)));
    add("searchable check (night)", await time(() => unsearchable(root)));
    add("memory sync pass (night)", await time(() => syncPass(root)));
  }
  if (Bun.which("age")) {
    const key = Bun.spawnSync(["age-keygen"]).stdout.toString().match(/age1[0-9a-z]+/)![0];
    add("backup", await time(() => backup(root, { dest: join(root, "..", `${root.split("/").pop()}-backups`), recipients: [key], record: false })));
  }

  // A restart (launchd kickstart, an auto-update): a new hub process, from start to the first
  // answer to an agent whose cell was current when the old one stopped (backlog row 217).
  {
    const { issueToken } = await import("../src/auth");
    const { saveParseSnapshots } = await import("../src/brain");
    const tok = issueToken(root, "planner");
    core.search(root, "planner", "budget"); // the cell is current, as after any read
    saveParseSnapshots(); // as the old hub does when it stops (src/brain.ts)
    const port = 18000 + Math.floor(Math.random() * 2000);
    const t = performance.now();
    const hub = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "serve", "--brain", root, "--port", String(port)], { stdout: "ignore", stderr: "ignore", env: { ...process.env } });
    let ok = false;
    for (let i = 0; i < 6000 && !ok && hub.exitCode === null; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/v1/search?q=budget`, { headers: { authorization: `Bearer ${tok}` } })).ok; } catch { /* not up yet */ }
      if (!ok) await Bun.sleep(50);
    }
    if (ok) add("restart to first answer", performance.now() - t);
    hub.kill();
    await hub.exited;
  }
  // The owner's pages, through the dashboard's own handler (no socket), signed in once.
  const { dashboardHandler } = await import("../src/dashboard/server");
  const H = "127.0.0.1:8788", key = "k".repeat(32);
  const dash = dashboardHandler(root, { port: 8788, loginKey: key });
  const cookie = (await dash.handle(new Request(`http://${H}/login?key=${key}`, { headers: { host: H } }))).headers.get("set-cookie")!.split(";")[0];
  const page = async (path: string) => { const r = await dash.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } })); await r.text(); if (r.status !== 200) throw new Error(`${path}: ${r.status}`); };
  await page("/"); // the first load builds the page state: the hub does this once at start
  for (let i = 0; i < runs; i++) for (const p of DASHBOARD_PAGES) {
    const path = p.replace("{id}", s.ids[i * 11]).replace("{day}", s.today);
    add(`dashboard ${p}`, await time(() => page(path)));
  }
  // A new minute: what's kept under the page key (logs, git, the minute) is worked out again, as
  // the first view of a page each minute does. The assistant page is the one with the most of it.
  for (let i = 0; i < runs; i++) {
    process.env.PB_NOW = new Date(Date.parse(`${s.today}T12:00:00Z`) + (i + 1) * 60_000).toISOString();
    add("dashboard /agent/planner (new minute)", await time(() => page("/agent/planner")));
  }
  process.env.PB_NOW = `${s.today}T12:00:00Z`;
  await time(() => core.remember(root, "steward", { id: s.ids[3], attribute: "perf_page", value: "after a write", as_of: s.today, sources: [`gmail:${"b".repeat(16)}`] }));
  add("dashboard / (first after a write)", await time(() => page("/")));
  await time(() => core.remember(root, "steward", { id: s.ids[3], attribute: "perf_page", value: "after a write", as_of: s.today, sources: [`gmail:${"b".repeat(16)}`] }));
  add("dashboard /history (first after a write)", await time(() => page("/history")));

  const { gcAuto, diskUse } = await import("../src/growth");
  const before = diskUse(root, join(root, "no-hub-logs")).git;
  add("git gc --auto (night housekeeping)", await time(() => gcAuto(root)));
  const disk = diskUse(root, join(root, "no-hub-logs"));
  const mbOf = (b: number) => Math.round(b / 104857.6) / 10;
  const diskRows = [{ step: ".git after a year (after gc)", mb: mbOf(disk.git), before_gc_mb: mbOf(before) }, { step: "log/ after a year", mb: mbOf(disk.log) }, { step: "read log, live file", mb: mbOf(statSync(readsFile).size), before_archive_mb: mbOf(readsBefore) }].map((r) => ({ ...r, budget_mb: BUDGETS_MB[r.step], over: r.mb > BUDGETS_MB[r.step] }));

  const big = s.ids.length >= 50_000;
  const budgets = big ? BUDGETS_50K_MS : BUDGETS_MS;
  const rows = Object.entries(out).map(([k, xs]) => ({ step: k, median_ms: Math.round(median(xs)), max_ms: Math.round(Math.max(...xs)), budget_ms: budgets[k], over: median(xs) > (budgets[k] ?? Infinity) }));
  const peakMb = Math.round(peakRss / 2 ** 20), peakBudget = big ? PEAK_MB.at50k : PEAK_MB.at10k;
  if (argv.includes("--json")) console.log(JSON.stringify({ notes: s.ids.length, days: num("--days", 365), gen_ms: Math.round(genMs), cells_ms: Math.round(cellsMs), peak_rss_mb: Math.round(peakRss / 2 ** 20), rows, disk: diskRows }, null, 2));
  else {
    console.log(`synthetic brain: ${s.ids.length} notes, ${num("--days", 365)} days (built in ${(genMs / 1000).toFixed(1)} s; cells ${(cellsMs / 1000).toFixed(1)} s; peak memory ${Math.round(peakRss / 2 ** 20)} MB)`);
    for (const r of rows) console.log(`${r.over ? "✗" : "✓"} ${r.step.padEnd(40)} median ${String(r.median_ms).padStart(7)} ms  max ${String(r.max_ms).padStart(7)} ms  budget ${r.budget_ms ?? "-"} ms`);
    for (const r of diskRows) console.log(`${r.over ? "✗" : "✓"} ${r.step.padEnd(40)} ${String(r.mb).padStart(7)} MB${"before_gc_mb" in r ? ` (before gc ${r.before_gc_mb} MB)` : ""}${"before_archive_mb" in r ? ` (before the archive ${r.before_archive_mb} MB)` : ""}  budget ${r.budget_mb} MB`);
    console.log(`${peakMb > peakBudget ? "✗" : "✓"} ${"peak memory".padEnd(40)} ${String(peakMb).padStart(7)} MB  budget ${peakBudget} MB`);
  }
  if (!argv.includes("--keep")) { rmSync(root, { recursive: true, force: true }); rmSync(`${root}-backups`, { recursive: true, force: true }); }
  else console.log(`kept ${root}`);
  return rows.some((r) => r.over) || diskRows.some((r) => r.over) || peakMb > peakBudget ? 1 : 0;
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2)));
