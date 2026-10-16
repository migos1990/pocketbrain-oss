#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// A read-only audit of the gardener's last runs, safe to paste out of the hub machine:
//   bun scripts/gardener-audit.ts --brain <brain> [--runs 3] [--agents ~/pocketbrain-agents] [--no-ant]
// It prints counts, verdicts, times and note/fact ids. Never a fact value, a quote, an alert's
// detail, a log line, a journal or a token; an error prints as "yes" or its type. It writes
// nothing and calls `ant` only to list and retrieve (ANTHROPIC_API_KEY removed).
//
// What it reads, and why directly: no command shows the gardener's activity per run (`week` has
// daily totals only), so it reads these with the app's own readers, keeping only the fields named:
//   rules/policy.yaml            (loadRules) the gardener's tier, cap, hours, status, night mode
//   log/gardener.jsonl           (runs) at, op, run, findings/retired counts
//   log/reads.jsonl              agent, op, at                    -> tool calls per run
//   log/writes.jsonl             agent, outcome, checks, key, at  -> proposals and refusals
//   log/sources/verify.jsonl     agent, result, at                -> verify_source verdicts
//   log/alerts.jsonl             check, at, and `from` only for write_conflict (a fact key)
//   inbox/*.yaml, inbox/decided/*.yaml  request.agent/id/attribute, decision, decided, source_check.result
//   <agents>/agents/*/agent.md   frontmatter only: model and enabled tool names; whether the prompt names verify_source
//   ~/Library/Logs/*pocketbrain* per file, a count of lines of each night kind (no line is printed)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { formatProblem } from "../src/format";
import { loadRules, gardeners } from "../src/rules";
import { loadHub } from "../src/hub";
import { runs } from "../src/gardener";
import { readJsonl } from "../src/util";

type Row = Record<string, any>;
const count = (xs: string[]) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>);
const home = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

function proposals(root: string, dir: string, agent: string) {
  const d = join(root, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".yaml")).flatMap((f) => {
    let p: Row = {};
    try { p = YAML.parse(readFileSync(join(d, f), "utf8")) ?? {}; } catch { return []; }
    if (p.request?.agent !== agent) return [];
    const key = p.request?.attribute ? `${p.request.id}#${p.request.attribute}` : String(p.request?.id ?? "");
    return [{ file: f, key, decision: p.decision as string | undefined, decided: p.decided as string | undefined, check: String(p.source_check?.result ?? "none"), retire: !!p.request?.retire, sourced: !!(p.request?.sources ?? []).length, mtime: statSync(join(d, f)).mtime.toISOString() }];
  });
}

export function agentConfig(dir: string) {
  const out: Record<string, unknown> = {};
  for (const sub of ["gardener", "gardener-weekly"]) {
    const f = join(dir, "agents", sub, "agent.md");
    if (!existsSync(f)) { out[sub] = "agent.md not found"; continue; }
    const text = readFileSync(f, "utf8");
    let fm: Row = {};
    try { fm = YAML.parse(text.split(/^---$/m)[1] ?? "") ?? {}; } catch { out[sub] = "frontmatter unreadable"; continue; }
    const tools = (fm.tools ?? []).flatMap((t: Row) => (t.configs ?? []).filter((c: Row) => c.enabled).map((c: Row) => String(c.name)));
    const prompt = text.split(/^---$/m).slice(2).join("---");
    out[sub] = { model: fm.model ?? "(none: weekly may say 'same as nightly')", tools, prompt_names_verify_source: prompt.includes("verify_source"), prompt_names_memory_sync: prompt.includes("memory_sync") };
  }
  return out;
}

export function audit(root: string, opts: { runs?: number; agents?: string; ant?: boolean; logs?: string } = {}) {
  const N = opts.runs ?? 3;
  const rules = loadRules(root);
  const name = gardeners(rules)[0] ?? "gardener";
  const a = rules.policy.agents[name] ?? ({} as Row);
  const out: Row = {};
  out.policy = { gardeners: gardeners(rules), status: a.status ?? "active", tier: a.tier, max_sensitivity: a.max_sensitivity, cap: a.max_proposals_per_day ?? null, verifies_cap: a.max_verifies_per_day ?? 40, windows: a.windows ?? [], night: (loadHub(root)?.night ?? rules.policy.night) ?? "local" };
  out.agent_config = agentConfig(home(opts.agents ?? "~/pocketbrain-agents"));

  const mine = runs(root).filter((e) => e.agent === name);
  const ups = mine.filter((e) => e.op === "upkeep_run");
  out.run_log = { upkeep_runs: ups.length, first: ups[0]?.at ?? null, ops: count(mine.map((e) => e.op)), last_cleanups: mine.filter((e) => e.op === "cleanup").slice(-3).map((e) => ({ at: e.at, deleted: e.deleted, failed: e.failed })), last_rotate: mine.filter((e) => e.op === "rotate").at(-1)?.at ?? null };

  const log = (rel: string) => readJsonl<Row>(join(root, "log", rel));
  const reads = log("reads.jsonl").filter((e) => e.agent === name);
  const writes = log("writes.jsonl").filter((e) => e.agent === name);
  const verifies = log("sources/verify.jsonl").filter((e) => e.agent === name);
  const alerts = log("alerts.jsonl");
  const open = proposals(root, "inbox", name), decided = proposals(root, "inbox/decided", name);
  // writes.jsonl keys a proposal by its note id (or note#attribute); match either.
  const same = (p: { key: string }, k: string) => p.key === k || p.key.split("#")[0] === k;
  const fate = (k: string) => { const d = decided.filter((p) => same(p, k)); const o = open.some((p) => same(p, k)); return d.length ? [...d.map((x) => `${x.decision} ${x.decided}`), ...(o ? ["open"] : [])].join(", ") : o ? "open" : "not found"; };
  // A run's activity: everything by the gardener from 30 minutes before its upkeep_run to 3 hours after.
  const near = (at: string, run: string) => { const t = Date.parse(at), b = Date.parse(run); return t >= b - 1_800_000 && t <= b + 10_800_000; };
  const tz = rules.policy.owner?.timezone?.trim() || "America/Toronto";
  const local = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  out.runs = ups.slice(-N).map((r) => {
    const w = writes.filter((e) => near(e.at, r.at));
    return {
      at: r.at, local: local(r.at), run: r.run, upkeep_findings: r.findings ?? null,
      sleep_retired: mine.find((e) => e.op === "sleep_run" && near(e.at, r.at))?.retired ?? "no sleep_run",
      tool_calls: count(reads.filter((e) => near(e.at, r.at)).map((e) => String(e.op))),
      writes: count(w.map((e) => String(e.outcome))), checks_hit: count(w.flatMap((e) => e.checks ?? [])),
      proposals: w.filter((e) => e.outcome === "inbox").map((e) => ({ key: String(e.key ?? ""), fate: fate(String(e.key ?? "")) })),
      verify_source: count(verifies.filter((e) => near(e.at, r.at)).map((e) => String(e.result))),
      alerts: count(alerts.filter((e) => near(e.at, r.at)).map((e) => String(e.check))),
    };
  });
  const days = (iso: string) => Math.round((Date.now() - Date.parse(iso)) / 86_400_000);
  out.proposals_all_time = {
    open: open.length, oldest_open_days: open.length ? Math.max(...open.map((p) => days(p.mtime))) : null,
    decided: count(decided.map((p) => String(p.decision))), source_check: count([...open, ...decided].map((p) => p.check)),
    retire: [...open, ...decided].filter((p) => p.retire).length, no_source: [...open, ...decided].filter((p) => !p.sourced).length,
  };
  const vcap = Number(a.max_verifies_per_day ?? 40);
  out.rails = {
    cap_hits: writes.filter((e) => (e.checks ?? []).includes("proposal_cap")).map((e) => e.at),
    tripwire: alerts.filter((e) => e.check === "gardener_hours").map((e) => e.at),
    ant_alerts: alerts.filter((e) => e.check === "gardener_ant").map((e) => e.at),
    verify_all_time: count(verifies.map((e) => String(e.result))),
    verify_cap_days: Object.entries(count(verifies.map((e) => String(e.at).slice(0, 10)))).filter(([, n]) => n >= vcap).map(([d]) => d),
  };
  const proposedOn = new Set(writes.filter((e) => e.outcome === "inbox").map((e) => String(e.key ?? "").split("#")[0]));
  const conflicts = alerts.filter((e) => e.check === "write_conflict" && (!ups[0] || e.at >= ups[0].at));
  out.clashes = {
    write_conflicts_since_first_run: conflicts.map((e) => ({ at: e.at, key: String(e.from ?? ""), gardener_proposed_on_note: proposedOn.has(String(e.from ?? "").split("#")[0]) })),
    open_disputes: existsSync(join(root, "disputes")) ? readdirSync(join(root, "disputes")).filter((f) => f.endsWith(".md") && /^status:\s*open\s*$/m.test(readFileSync(join(root, "disputes", f), "utf8"))).length : 0,
  };
  if (opts.ant !== false) out.managed = managed(home(opts.agents ?? "~/pocketbrain-agents"), N);
  out.hub_logs = hubLogs(opts.logs ?? join(homedir(), "Library", "Logs"));
  return out;
}

// Per log file, how many lines of each night kind. No line is printed.
export function hubLogs(dir: string) {
  if (!existsSync(dir)) return "no log folder";
  const kinds: [string, RegExp][] = [["fallback_ran_locally", /night: gardener silent/], ["left_to_gardener", /upkeep left to the gardener/], ["night_local", /night: \d+ upkeep finding/], ["gardener_job_failed", /gardener (cleanup|rotate) failed/], ["cleanup_ok", /gardener cleanup: \d+ session/]];
  const out: Record<string, Record<string, number>> = {};
  for (const f of readdirSync(dir).filter((x) => /pocketbrain/i.test(x) && statSync(join(dir, x)).isFile())) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    out[f] = Object.fromEntries(kinds.map(([k, re]) => [k, lines.filter((l) => re.test(l)).length]));
  }
  return out;
}

// The Managed Agents side, read-only: per deployment, its last runs, how they ended, their usage numbers.
function managed(dir: string, N: number) {
  const lock = join(dir, "claude-lock.json");
  if (!existsSync(lock)) return "no claude-lock.json";
  const ant = (args: string[]) => { const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; try { const r = Bun.spawnSync(["ant", "--profile", "pocketbrain", ...args, "--format", "jsonl"], { env, timeout: 60_000 }); return { ok: r.exitCode === 0, rows: rows(r.stdout.toString()) }; } catch { return { ok: false, rows: [] as Row[] }; } };
  const res = (JSON.parse(readFileSync(lock, "utf8")).resources ?? {}) as Record<string, { id?: string }>;
  const numbers = (u: unknown) => (u && typeof u === "object" ? Object.fromEntries(Object.entries(u).filter(([, v]) => typeof v === "number")) : null);
  return Object.entries(res).filter(([k, v]) => /deployment[^/]*\.ya?ml$/.test(k) && v?.id).map(([k, v]) => {
    const dep = ant(["beta:deployments", "retrieve", "--deployment-id", v.id!]);
    const list = ant(["beta:deployment-runs", "list", "--deployment-id", v.id!]);
    return {
      deployment: k.split("/").pop(), retrieve_ok: dep.ok, paused: dep.rows[0]?.paused ?? dep.rows[0]?.status ?? null, list_ok: list.ok,
      runs: list.rows.slice(0, N).map((r) => {
        const sid = String(r.session_id ?? r.session?.id ?? "");
        const s = /^[A-Za-z0-9_-]+$/.test(sid) ? ant(["beta:sessions", "retrieve", "--session-id", sid]).rows[0] : undefined;
        const stop = s?.stop_reason;
        return { created: r.created_at ?? null, status: r.status ?? null, error: r.error ? (typeof r.error === "object" && typeof r.error.type === "string" ? r.error.type : "yes") : null, session_kept: !!s, session_status: s?.status ?? null, stop: typeof stop === "string" ? stop : stop?.type ?? null, usage: numbers(s?.usage ?? r.usage) };
      }),
    };
  });
}

function rows(s: string): Row[] {
  const t = s.trim();
  if (!t) return [];
  if (t.startsWith("[")) { try { return JSON.parse(t); } catch { return []; } }
  const xs = t.split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  return xs.length === 1 && Array.isArray(xs[0]?.data) ? xs[0].data : xs;
}

if (import.meta.main) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const brain = arg("--brain");
  if (!brain) { console.error("usage: bun scripts/gardener-audit.ts --brain <brain> [--runs 3] [--agents ~/pocketbrain-agents] [--no-ant]"); process.exit(2); }
  // A brain newer (or older) than this code is refused, as every pocketbrain command does (src/format.ts).
  const fp = formatProblem(home(brain));
  if (fp) { console.error(fp.text); process.exit(1); }
  console.log(JSON.stringify(audit(home(brain), { runs: Number(arg("--runs") ?? 3), agents: arg("--agents"), ant: !process.argv.includes("--no-ant") }), null, 2));
}
