// SPDX-License-Identifier: AGPL-3.0-only
// The carve as a property (backlog 276): for random brains and policies (test/carve-gen.ts:
// areas, tags, types, sensitivity, aliases, object and list facts, fact-level sensitivity and
// share_with, slices of every kind, excludes, tiers, reader tokens, merges, superseded decisions,
// handoffs), no agent's output through the live MCP server (orientation, read, search,
// context_pack, whats_new with its handoffs, memory_check) carries a value, a name, a note id or a
// date of a note or fact carved out for it. "Carved out" is the leak oracle's (evals/lib/oracle.ts),
// written from rules/ without the carve code. What an agent asked for (a read id, a search word, a
// topic) is taken out of that call's own answer before it is checked: echoing it isn't a leak.
//   CI: CARVE_CASES brains (default 6).  Soak: CARVE_SOAK=1 (300 brains), or CARVE_CASES=n.
//   One seed: CARVE_SEED=n.  Freeze a failing seed: CARVE_FREEZE=1 writes test/fixtures/carve-seeds/seed-<n>/.
// Every frozen fixture is replayed on every run.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, evolve, freeze, thaw, type Generated } from "./carve-gen";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain } from "../src/brain";
import { mergeNotes } from "../src/merge";
import { handOff } from "../src/handoff";
import { makeBrain } from "./fixture";
import { forbiddenFor, carvedFor, findLeaks } from "../evals/lib/oracle";

const FIXTURES = join(import.meta.dir, "fixtures", "carve-seeds");
const BASE = 7_000;
const N = Number(process.env.CARVE_CASES ?? (process.env.CARVE_SOAK ? 300 : 6));
const SEEDS = process.env.CARVE_SEED ? [Number(process.env.CARVE_SEED)] : Array.from({ length: N }, (_, i) => BASE + i);

interface Finding { agent: string; role: string; tool: string; kind: "value" | "name" | "id" | "date"; what: string; from: string }

async function call(root: string, token: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }));
  const j = await res.json().catch(() => undefined) as any;
  return (j?.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n") || JSON.stringify(j?.error ?? "");
}

// Every surface the property covers, for one agent and token; each answer with its asked words removed.
async function outputs(g: Generated, agent: string, token: string): Promise<{ tool: string; text: string }[]> {
  const notes = loadBrain(g.root);
  const asks: [string, Record<string, unknown>][] = [["orientation", {}], ["whats_new", { since: "1990-01-01" }], ["context_pack", {}], ["memory_check", {}]];
  for (const n of notes) asks.push(["read", { id: n.fm.id }]);
  for (const n of notes.slice(0, 4)) asks.push(["context_pack", { topic: n.fm.title }]);
  for (const n of notes.slice(0, 6)) {
    const v = Object.values(n.fm.facts ?? {})[0] as any;
    const word = String(v?.value ?? v?.items?.[0]?.value ?? n.fm.title).split(/[^\p{L}\p{N}]+/u).find((x) => x.length > 3) ?? n.fm.title;
    asks.push(["search", { query: word }]);
  }
  const out: { tool: string; text: string }[] = [];
  for (const [tool, args] of asks) {
    let text = await call(g.root, token, tool, args);
    for (const a of Object.values(args)) if (typeof a === "string" && a.length > 2) text = text.split(a).join(" ");
    out.push({ tool: `${tool}${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ""}`, text });
  }
  return out;
}

export async function check(g: Generated): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const a of g.agents) for (const role of a.roles) {
    const token = issueToken(g.root, a.name, role === "reader" ? "reader" : undefined);
    const opts = role === "reader" ? { role: "reader" as const } : {};
    const values = await forbiddenFor(g.root, a.name, opts);
    const { carved, shownDates } = await carvedFor(g.root, a.name, opts);
    const names = carved.flatMap((c) => c.names.map((n) => ({ value: n, from: c.id })));
    for (const { tool, text } of await outputs(g, a.name, token)) {
      const add = (kind: Finding["kind"], what: string, from: string) => findings.push({ agent: a.name, role, tool, kind, what, from });
      for (const l of findLeaks(text, values)) add("value", l.value, l.from);
      for (const l of findLeaks(text, names)) add("name", l.value, l.from);
      for (const c of carved) {
        if (c.whole && new RegExp(`(^|[^\\w/-])${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w-])`).test(text)) add("id", c.id, c.id);
        // Only the generator's dates (each used once, 1991-2019) identify a note; a stamp the code
        // writes (a merge's today) is shared by many notes and says nothing.
        for (const d of c.dates) if (/^(199|200|201)\d-/.test(d) && !shownDates.has(d) && text.includes(d)) add("date", d, c.id);
      }
    }
  }
  return findings;
}

const report = (g: Generated, f: Finding[]) => `seed ${g.seed} (replay: CARVE_SEED=${g.seed} bun test test/carve-property.test.ts; CARVE_FREEZE=1 to freeze it)${g.ops.length ? `\n  ops: ${g.ops.join("; ")}` : ""}\n` +
  [...new Map(f.map((x) => [`${x.agent}/${x.role} ${x.kind} ${x.what}`, x])).values()].slice(0, 12).map((x) => `  ${x.agent} (${x.role} token) got ${x.kind} "${x.what}" of ${x.from} in ${x.tool}`).join("\n");

// Built once per run: the coverage test below reads the same brains the property checked.
const built = new Map<number, Promise<Generated>>();
function brainFor(seed: number): Promise<Generated> {
  if (!built.has(seed)) built.set(seed, (async () => { const g = generate(seed); await evolve(g, { mergeNotes, handOff, loadBrain }); return g; })());
  return built.get(seed)!;
}

test(`carve property: ${SEEDS.length} random brains, every agent and token, no carved value, name, id or date in any output`, async () => {
  const failed: string[] = [];
  for (const seed of SEEDS) {
    const g = await brainFor(seed);
    const f = await check(g);
    if (f.length) {
      failed.push(report(g, f));
      if (process.env.CARVE_FREEZE) freeze(g, join(FIXTURES, `seed-${seed}`));
    }
  }
  expect(failed.join("\n")).toBe("");
}, 600_000);

// Frozen seeds: a found leak stays a test until it's fixed. A fixture with a gap id in its
// meta.json ("gap": an id or a list of ids) is a known open gap: it must still fail, so a fix gets
// noticed and the gap closed (then drop "gap" and the fixture guards the fix).
const frozen = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((d) => existsSync(join(FIXTURES, d, "meta.json"))) : [];
for (const name of frozen) {
  test(`carve property, frozen ${name}`, async () => {
    const g = thaw(join(FIXTURES, name), mkdtempSync(join(tmpdir(), "pb-carve-fixture-")));
    const meta = await Bun.file(join(FIXTURES, name, "meta.json")).json();
    const f = await check(g);
    if (meta.gap) expect([meta.gap, f.length > 0]).toEqual([meta.gap, true]);
    else expect(report(g, f)).toBe(report(g, []));
  }, 120_000);
}

test("carve property: the generator is deterministic and covers what it claims", async () => {
  const a = generate(BASE), b = generate(BASE);
  expect(loadBrain(a.root).map((n) => n.fm)).toEqual(loadBrain(b.root).map((n) => n.fm));
  // Across the CI seeds: every sensitivity level, object and list facts, reader tokens, a merge and a handoff.
  const all = await Promise.all(SEEDS.slice(0, Math.max(6, Math.min(SEEDS.length, 12))).map(brainFor));
  const notes = all.flatMap((g) => loadBrain(g.root));
  const levels = new Set(notes.map((n) => n.fm.sensitivity));
  expect([...levels].sort()).toEqual(["personal", "private", "public", "secret"]);
  expect(notes.some((n) => Object.values(n.fm.facts ?? {}).some((f: any) => f?.value && typeof f.value === "object"))).toBe(true);
  expect(notes.some((n) => Object.values(n.fm.facts ?? {}).some((f: any) => Array.isArray(f?.items)))).toBe(true);
  expect(all.some((g) => g.agents.some((x) => x.roles.includes("reader")))).toBe(true);
  expect(all.some((g) => g.ops.some((o) => o.startsWith("merge") && o.endsWith("ok")))).toBe(true);
  expect(all.some((g) => g.ops.some((o) => o.startsWith("handoff ")))).toBe(true);
}, 120_000);

// G254, the coordinator's repro (the note copied from evals/cases/handoff.ts on claude/handoff-eval):
// Steward, who sees everything, hands Planner (work, no money) a task naming the private money note
// Planner is excluded from. The handoff gate checks fact values only, so the hub delivers the note's
// id as-is and Planner's whats_new shows it. Open gap: test.failing keeps it red-by-design, and it
// starts failing the run the day a fix lands (then make it a plain test and close G254).
const G254 = test.failing;
G254("G254: a handoff naming a note its recipient can't see is not delivered as-is", async () => {
  const root = makeBrain();
  const ref = `as_of: 2026-10-06, sources: ["gmail:f000000000000031"], verification: verified-by-source, recorded: 2026-10-06`;
  writeFileSync(join(root, "money", "workshop-fund.md"), `---
id: money/workshop-fund
type: money
title: Workshop fund
area: personal
sensitivity: private
status: active
created: 2026-10-06
updated: 2026-10-06
by: steward
facts:
  account: { value: Ostrava Credit Union account 0042-7781, ${ref}, by: steward }
  balance: { value: "CAD 2,914.60", ${ref}, by: steward }
---
Workshop costs, the Course A supplies run included, are paid from the Ostrava Credit Union account 0042-7781.
`);
  Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "-c", "commit.gpgsign=false", "commit", "-qm", "fund"], { cwd: root });
  const { carvedFor: carved } = await import("../evals/lib/oracle");
  expect((await carved(root, "planner")).carved.some((c) => c.id === "money/workshop-fund")).toBe(true);
  const h = await handOff(root, "steward", { to: "planner", task: "Payment comes from money/workshop-fund", next_step: "Finish the supplies plan and tell the owner." }, { model: null });
  const seen = await call(root, issueToken(root, "planner"), "whats_new", { since: "1990-01-01" });
  const dir = join(root, "handoffs"), file = readdirSync(dir).map((d) => join(dir, d, `${h.id}.md`)).find(existsSync)!;
  const verdict = (await Bun.file(file).text()).match(/^verdict: (\S+)/m)?.[1];
  expect({ verdict, named: seen.includes("money/workshop-fund") }).toEqual({ verdict: "held", named: false });
}, 60_000);
