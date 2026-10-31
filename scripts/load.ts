// SPDX-License-Identifier: AGPL-3.0-only
// Load check (docs/perf.md "Several agents at once"): a real hub on a synthetic brain, several
// agents calling it at the same time, and a /health probe that shows how long the hub stops
// answering anyone. Synthetic data only; never point it at a real brain.
//   bun scripts/load.ts [--notes 10000] [--readers 5] [--writers 2] [--seconds 30] [--json]
// Exits 1 when a p95 or the longest /health wait is over its budget.
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthBrain } from "./perf";

const APP = join(import.meta.dir, "..");
const argv = process.argv.slice(2);
const num = (flag: string, d: number) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : d; };
const WORDS = "budget grade course meeting invoice launch draft review client contract renewal schedule".split(" ");

// p95 per tool while the others run, and the longest any request waited for /health. A hub that
// answers /health in 2 s while agents work has stopped answering everyone for that long.
// They hold today's numbers with room (docs/perf.md "Several agents at once"); they are not a target.
export const BUDGETS_MS: Record<string, number> = { search: 2500, context_pack: 2500, read: 2500, whats_new: 3000, remember: 3000, health: 5000 };

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") }); const p = s.port as number; s.stop(true); return p;
}

export async function load(o: { notes: number; readers: number; writers: number; seconds: number; log?: (s: string) => void }) {
  const log = o.log ?? (() => {});
  const root = mkdtempSync(join(tmpdir(), "pb-load-"));
  const config = mkdtempSync(join(tmpdir(), "pb-load-config-"));
  const s = synthBrain(root, { notes: o.notes, days: 365 });
  const env = { ...process.env, PB_TODAY: s.today, PB_CONFIG_DIR: config };
  // The per-agent request budget (src/budget.ts) would turn most of this into 429s; this measures the hub, not the budget.
  appendFileSync(join(root, "rules", "policy.yaml"), "budget: { requests_per_minute: 100000, writes_per_hour: 100000 }\n");
  const cli = (...a: string[]) => { const r = Bun.spawnSync(["bun", "src/cli.ts", ...a, "--brain", root], { cwd: APP, env }); return r.stdout.toString() + r.stderr.toString(); };
  const token = (agent: string) => { const t = cli("token", "--agent", agent).match(/pb_[A-Za-z0-9_-]{8,}/)?.[0]; if (!t) throw new Error(`no token for ${agent}`); return t; };
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  log(`brain ${o.notes} notes; starting the hub`);
  // PB_LOAD_PROF=<dir>: the hub writes a CPU profile there (markdown) when it stops.
  const hub = Bun.spawn(["bun", ...(process.env.PB_LOAD_PROF ? ["--cpu-prof-md", `--cpu-prof-dir=${process.env.PB_LOAD_PROF}`] : []), "src/cli.ts", "serve", "--brain", root, "--port", String(port)], { cwd: APP, env, stdout: "ignore", stderr: "pipe" });
  const times: Record<string, number[]> = {};
  const errors: Record<string, number> = {};
  const add = (k: string, ms: number) => (times[k] ??= []).push(ms);
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ }
      if (i > 600) throw new Error("the hub didn't answer /health");
      await Bun.sleep(100);
    }
    const tokens = { planner: token("planner"), steward: token("steward") };
    let id = 0;
    const call = async (agent: keyof typeof tokens, name: string, args: Record<string, unknown>) => {
      const t0 = performance.now();
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokens[agent]}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
      const j = await r.json().catch(() => undefined) as { result?: { isError?: boolean } } | undefined;
      add(name, performance.now() - t0);
      if (!r.ok || !j?.result || j.result.isError) errors[name] = (errors[name] ?? 0) + 1;
    };
    // Warm: the first call per agent builds its cell and index, as after a restart.
    await call("planner", "search", { query: "budget" });
    await call("steward", "search", { query: "budget" });
    for (const k of Object.keys(times)) delete times[k];

    const until = performance.now() + o.seconds * 1000;
    const work = s.ids.filter((n) => s.area.get(n) === "work");
    const reader = async (r: number) => {
      for (let i = 0; performance.now() < until; i++) {
        const w = WORDS[(i + r) % WORDS.length];
        await call("planner", "search", { query: `${w} review` });
        await call("planner", "context_pack", { topic: w });
        await call("planner", "read", { id: work[(i * 31 + r) % work.length] });
        if (i % 3 === 0) await call("planner", "whats_new", {});
      }
    };
    const writer = async (wr: number) => {
      for (let i = 0; performance.now() < until; i++) {
        await call("steward", "remember", { id: s.ids[(i * 13 + wr * 101) % s.ids.length], attribute: `load_${wr}_${i}`, value: `value ${i}`, as_of: s.today, sources: [`gmail:${String(wr * 1000 + i).padStart(16, "b")}`] });
      }
    };
    const health = async () => {
      while (performance.now() < until) {
        const t0 = performance.now();
        await fetch(`${base}/health`).catch(() => undefined);
        add("health", performance.now() - t0);
        await Bun.sleep(100);
      }
    };
    log(`${o.readers} readers and ${o.writers} writers for ${o.seconds}s`);
    await Promise.all([...Array.from({ length: o.readers }, (_, r) => reader(r)), ...Array.from({ length: o.writers }, (_, w) => writer(w)), health()]);
  } finally {
    hub.kill();
    await hub.exited;
    rmSync(root, { recursive: true, force: true });
    rmSync(config, { recursive: true, force: true });
  }
  const rows = Object.entries(times).map(([k, xs]) => ({ tool: k, n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(...xs)), errors: errors[k] ?? 0, budget: BUDGETS_MS[k] }));
  const over = rows.filter((r) => r.budget !== undefined && (r.tool === "health" ? r.max : r.p95) > r.budget);
  return { rows, over, errors };
}

if (import.meta.main) {
  const res = await load({ notes: num("--notes", 10_000), readers: num("--readers", 5), writers: num("--writers", 2), seconds: num("--seconds", 30), log: (s) => console.error(s) });
  if (argv.includes("--json")) console.log(JSON.stringify(res, null, 2));
  else {
    console.log("tool            calls    p50    p95    max  errors  budget");
    for (const r of res.rows) console.log(`${r.tool.padEnd(14)} ${String(r.n).padStart(6)} ${String(r.p50).padStart(6)} ${String(r.p95).padStart(6)} ${String(r.max).padStart(6)} ${String(r.errors).padStart(7)}  ${r.budget ?? "-"}${r.tool === "health" ? " (max)" : ""}`);
    for (const r of res.over) console.log(`OVER: ${r.tool} ${r.tool === "health" ? `waited ${r.max}` : `p95 ${r.p95}`} ms > ${r.budget} ms`);
  }
  process.exit(res.over.length || Object.keys(res.errors).length ? 1 : 0);
}
