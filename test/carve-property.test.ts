// SPDX-License-Identifier: AGPL-3.0-only
// The carve as a property (backlog 276): for random brains and policies (test/carve-gen.ts:
// areas, tags, types, sensitivity, aliases, object and list facts, fact-level sensitivity and
// share_with, slices of every kind, excludes, tiers, reader tokens, merges, superseded decisions,
// handoffs, contact cards' emails and phones held until Show, facts that link another note with the
// page writer run over them), no agent's answer through any door of the live server (MCP, the /v1
// API and the browser door; test/carve-check.ts has the reads: orientation, read, search,
// context_pack, whats_new with its handoffs, memory_check, why, who_is)
// carries a value, a name, a note id or a date of a note or fact carved out for it. "Carved out" is the leak oracle's (evals/lib/oracle.ts),
// written from rules/ without the carve code. What an agent asked for (a read id, a search word, a
// topic) is taken out of that call's own answer before it is checked: echoing it isn't a leak.
//   CI: CARVE_CASES brains (default 6), each read through one door in turn, so two a door: the whole
//   suite has a time limit in CI, and every door on every brain is the nightly run's job
//   (scripts/slice-proof.ts). CARVE_DOORS=all reads every door here too, as the soak and a replay do.
//   Soak: CARVE_SOAK=1 (300 brains), or CARVE_CASES=n.
//   One seed: CARVE_SEED=n.  Freeze a failing seed: CARVE_FREEZE=1 writes test/fixtures/carve-seeds/seed-<n>/.
// Every frozen fixture is replayed on every run.
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, freeze, thaw, type Generated } from "./carve-gen";
import { check, report, brainOf, DOORS } from "./carve-check";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadBrain } from "../src/brain";
import { handOff } from "../src/handoff";
import { useCells } from "../src/cell";
import { restoreCells } from "./cells";
import { makeBrain } from "./fixture";
import { forbiddenFor } from "../evals/lib/oracle";

const FIXTURES = join(import.meta.dir, "fixtures", "carve-seeds");
const BASE = 7_000;
const N = Number(process.env.CARVE_CASES ?? (process.env.CARVE_SOAK ? 300 : 6));
const SEEDS = process.env.CARVE_SEED ? [Number(process.env.CARVE_SEED)] : Array.from({ length: N }, (_, i) => BASE + i);

const EVERY_DOOR = !!(process.env.CARVE_SOAK || process.env.CARVE_SEED || process.env.CARVE_DOORS === "all");
const doorsOf = (i: number) => EVERY_DOOR ? DOORS : [DOORS[i % DOORS.length]];

// Built once per run: the coverage test below reads the same brains the property checked.
const built = new Map<number, Promise<Generated>>();
function brainFor(seed: number): Promise<Generated> {
  if (!built.has(seed)) built.set(seed, brainOf(seed));
  return built.get(seed)!;
}

test(`carve property: ${SEEDS.length} random brains, every agent and token, ${EVERY_DOOR ? "every door" : "the doors in turn"} (${DOORS.join(", ")}), no carved value, name, id or date in any answer`, async () => {
  const failed: string[] = [];
  for (const [i, seed] of SEEDS.entries()) {
    const g = await brainFor(seed);
    const f = (await check(g, doorsOf(i))).findings;
    if (f.length) {
      failed.push(report(g, f));
      if (process.env.CARVE_FREEZE) freeze(g, join(FIXTURES, `seed-${seed}`));
    }
  }
  expect(failed.join("\n")).toBe("");
}, Math.max(600_000, SEEDS.length * 20_000)); // three doors take about 3 s a brain; the soak's 300 need room

// Frozen seeds: a found leak stays a test until it's fixed. A fixture with a gap id in its
// meta.json ("gap": an id or a list of ids) is a known open gap: it must still fail, so a fix gets
// noticed and the gap closed (then drop "gap" and the fixture guards the fix).
// A fixture that found the same fault as another ("same_as" in meta.json names that one) is replayed
// when every door is read (CARVE_DOORS=all, a soak, a replay), not on every run: the one it names
// guards the fix here.
const sameAs = (d: string) => (JSON.parse(readFileSync(join(FIXTURES, d, "meta.json"), "utf8")) as { same_as?: string }).same_as;
const frozen = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((d) => existsSync(join(FIXTURES, d, "meta.json")) && (EVERY_DOOR || !sameAs(d))) : [];
for (const name of frozen) {
  test(`carve property, frozen ${name}`, async () => {
    const g = thaw(join(FIXTURES, name), mkdtempSync(join(tmpdir(), "pb-carve-fixture-")));
    const meta = await Bun.file(join(FIXTURES, name, "meta.json")).json();
    // A fixture found with cells on ("cells": true) is replayed the way the hub serves, whichever lane runs.
    if (meta.cells) useCells(true);
    let f: Awaited<ReturnType<typeof check>>["findings"];
    // Through the door it leaked by ("doors" in meta.json, the MCP door when it names none).
    try { f = (await check(g, EVERY_DOOR ? DOORS : meta.doors ?? ["mcp"])).findings; } finally { restoreCells(); }
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
  // A fact that links another note, by id and by name, with the page writer run over it, a summary
  // and an older plain-words sentence naming the linked note (G754, G755).
  expect(all.some((g) => g.ops.some((o) => /^page writer: [1-9]/.test(o)))).toBe(true);
  const links = notes.filter((n) => typeof (n.fm.facts?.partner as any)?.value === "string");
  expect(links.some((n) => typeof n.fm.summary === "string")).toBe(true);
  expect(links.some((n) => n.body.includes("The partner of"))).toBe(true);
  expect(links.some((n) => !String((n.fm.facts!.partner as any).value).includes("/"))).toBe(true);
  // Contact cards (G563): emails and phones citing a card, private, some held until Show and some
  // seen, and the oracle forbids every held one to every agent, a core one that sees all included.
  const card = (r: any) => (r.sources ?? []).some((x: unknown) => String(x).startsWith("contacts:"));
  const cardRecs = notes.flatMap((n) => ["emails", "phones"].flatMap((a) => (n.fm.facts?.[a] as any)?.items ?? [])).filter(card);
  expect(cardRecs.some((r: any) => r.unseen === true)).toBe(true);
  expect(cardRecs.some((r: any) => r.sensitivity === "private" && !r.unseen)).toBe(true);
  for (const g of all) {
    const held = loadBrain(g.root).flatMap((n) => ["emails", "phones"].flatMap((a) => (n.fm.facts?.[a] as any)?.items ?? [])).filter((r: any) => card(r) && r.unseen).map((r: any) => String(r.value));
    for (const a of g.agents) {
      const out = new Set((await forbiddenFor(g.root, a.name)).map((f) => f.value));
      expect(held.filter((v) => !out.has(v))).toEqual([]);
    }
  }
}, 120_000);

// G254, the coordinator's repro (the note copied from evals/cases/handoff.ts on claude/handoff-eval):
// Steward, who sees everything, hands Planner (work, no money) a task naming the private money note
// Planner is excluded from. The handoff gate used to check fact values only, so the hub delivered
// the note's id as-is and Planner's whats_new showed it. Now a carved-out page's id and title are
// hidden names (hiddenNames in src/needles.ts), so the handoff is held for the owner.
test("G254: a handoff naming a note its recipient can't see is not delivered as-is", async () => {
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
  const res = await handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${issueToken(root, "planner")}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whats_new", arguments: { since: "1990-01-01" } } }) }));
  const seen = JSON.stringify(await res.json());
  const dir = join(root, "handoffs"), file = readdirSync(dir).map((d) => join(dir, d, `${h.id}.md`)).find(existsSync)!;
  const verdict = (await Bun.file(file).text()).match(/^verdict: (\S+)/m)?.[1];
  expect({ verdict, named: seen.includes("money/workshop-fund") }).toEqual({ verdict: "held", named: false });
}, 60_000);

test("carve fixtures: one that stands in for others (same_as) is itself replayed on every run", () => {
  const all = readdirSync(FIXTURES).filter((d) => existsSync(join(FIXTURES, d, "meta.json")));
  const named = all.map(sameAs).filter((s): s is string => !!s);
  // The three G810 memories are one fault: one guards the fix on every run, two wait for every door.
  expect([sameAs("seed-7238"), sameAs("seed-7288"), sameAs("seed-7042")]).toEqual(["seed-7042", "seed-7042", undefined]);
  expect(named.filter((n) => !all.includes(n) || sameAs(n))).toEqual([]);
});
