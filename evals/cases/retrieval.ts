// SPDX-License-Identifier: AGPL-3.0-only
// Retrieval quality through the path agents actually use (core.search and core.contextPack,
// the same calls behind the MCP and API tools), scored against the golden set the retrieval
// thread keeps in the brain repo ($PB_BRAIN/evals/retrieval.yaml, since it quotes real names).
// Reports name question ids, never note values. The same scoring runs on a synthetic French and
// English golden set (evals/fixtures/retrieval: fictional notes laid over the synthetic brain),
// so CI and the cloud measure retrieval too, against a committed baseline. Plus synthetic cases
// for what the golden sets don't cover yet (freshness).
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { SRC } from "../lib/pb";
import { realBrainPath, sandbox } from "../lib/sandbox";
import { forbiddenFor, findLeaks } from "../lib/oracle";
import { ok, na, type Case, type Result } from "../lib/case";

const core = existsSync(join(SRC, "core.ts")) ? await import(join(SRC, "core.ts")) : undefined;

interface Q { id: string; kind: string; q: string; as?: string; want: string[]; answer?: string; forbid?: string[] }
const GATE = 0.85; // held-out recall@5 (retrieval-capture.md section 2); under it is also the trigger for embeddings

type Golden = { root: string; rows: { g: Q; ids: string[]; pos: number; leaked: string[] }[] };
let memo: Golden | undefined;
const synthMemo = new Map<boolean, Golden>();
function golden(): Golden {
  if (memo) return memo;
  const brain = realBrainPath();
  return (memo = score(sandbox("real"), YAML.parse(readFileSync(join(brain!, "evals", "retrieval.yaml"), "utf8")).questions));
}
export const SYNTH_DIR = join(import.meta.dir, "..", "fixtures", "retrieval");
// Runs fn with the French-English word map (src/lexicon.ts, PB_LEXICON) on or off, then puts it back.
function withLexicon<T>(on: boolean, fn: () => T): T {
  const keep = process.env.PB_LEXICON;
  process.env.PB_LEXICON = on ? "1" : "0";
  try { return fn(); } finally { if (keep === undefined) delete process.env.PB_LEXICON; else process.env.PB_LEXICON = keep; }
}
// The synthetic golden set: its notes laid over the synthetic brain, its questions beside them,
// scored with the word map off (the default) or on.
function synthGolden(lexicon = false): Golden {
  const hit = synthMemo.get(lexicon);
  if (hit) return hit;
  const root = sandbox("synthetic", (r) => {
    for (const d of ["people", "orgs", "projects", "decisions", "notes", "money"]) if (existsSync(join(SYNTH_DIR, d))) cpSync(join(SYNTH_DIR, d), join(r, d), { recursive: true });
  });
  const g = withLexicon(lexicon, () => score(root, YAML.parse(readFileSync(join(SYNTH_DIR, "questions.yaml"), "utf8")).questions));
  synthMemo.set(lexicon, g);
  return g;
}
function score(root: string, qs: Q[]): Golden {
  const rows = qs.map((g) => {
    const ids = core.search(root, g.as ?? "steward", g.q, 20).map((h: any) => h.id);
    return { g, ids, pos: g.want.length ? ids.findIndex((id: string) => g.want.includes(id)) : -1, leaked: (g.forbid ?? []).filter((f) => ids.includes(f)) };
  });
  return { root, rows };
}
const r5 = (rows: ReturnType<typeof golden>["rows"]) => {
  const scored = rows.filter((r) => r.g.want.length);
  const hit = scored.filter((r) => r.pos >= 0 && r.pos < 5);
  const misses = scored.filter((r) => !(r.pos >= 0 && r.pos < 5)).map((r) => `${r.g.id}(${r.pos < 0 ? "none" : r.pos + 1})`);
  return { rate: scored.length ? hit.length / scored.length : 0, n: scored.length, hit: hit.length, misses };
};

function goldenCase(id: string, title: string, fn: () => Result | Promise<Result>, gap?: string): Case {
  const ready = () => {
    if (!core) return "no core at this commit";
    const b = realBrainPath();
    if (!b) return "PB_BRAIN not set";
    if (!existsSync(join(b, "evals", "retrieval.yaml"))) return "no golden set in the brain";
  };
  return { id, dimension: "retrieval", title, source: "real", gap, run: async () => { const why = ready(); return why ? na(why) : fn(); } };
}

// Two notes match the same words; one was settled this month, the other is two years old.
function freshness(): Result {
  if (!core) return na("no core at this commit");
  const note = (id: string, date: string, text: string) => `---
id: ${id}
type: decision
title: Parking pass for the downtown lot
area: work
sensitivity: personal
status: active
created: ${date}
updated: ${date}
by: planner
facts:
  outcome: { value: ${text}, as_of: ${date}, sources: ["agent:planner"], verification: self-reported, by: planner, recorded: ${date} }
---
`;
  const root = sandbox("synthetic", (r) => {
    mkdirSync(join(r, "decisions"), { recursive: true });
    writeFileSync(join(r, "decisions", "2024-08-20-parking-pass.md"), note("decisions/2024-08-20-parking-pass", "2024-08-20", "Parking pass for the downtown lot is bought at the front desk"));
    writeFileSync(join(r, "decisions", "2026-10-01-parking-pass.md"), note("decisions/2026-10-01-parking-pass", "2026-10-01", "Parking pass for the downtown lot is now bought online"));
  });
  const ids = core.search(root, "planner", "parking pass downtown lot", 10).map((h: any) => h.id);
  const cur = ids.indexOf("decisions/2026-10-01-parking-pass"), old = ids.indexOf("decisions/2024-08-20-parking-pass");
  return ok(cur >= 0 && (old < 0 || cur < old), `current at ${cur + 1}, stale at ${old < 0 ? "absent" : old + 1}`);
}

// A decision replaced by a newer one (status: superseded, superseded_by). The old file repeats
// the query's words more, so on text alone it wins. It must rank below its replacement, yet
// still come back: "what did I decide before" is a question the brain exists to answer.
// (A shared index of planning docs once answered with a superseded plan over the current fact;
// its fix had to keep history questions working, which is why both halves are checked.)
function superseded(): { cur: number; old: number } | undefined {
  if (!core) return undefined;
  const note = (id: string, date: string, status: string, link: string, text: string, body: string) => `---
id: ${id}
type: decision
title: Office lease for the team
area: work
sensitivity: personal
status: ${status}
${link}
created: ${date}
updated: ${date}
by: planner
facts:
  outcome: { value: ${text}, as_of: ${date}, sources: ["agent:planner"], verification: self-reported, by: planner, recorded: ${date} }
---
${body}
`;
  const OLD = "decisions/2026-03-02-office-lease", NEW = "decisions/2026-09-15-office-lease";
  const root = sandbox("synthetic", (r) => {
    mkdirSync(join(r, "decisions"), { recursive: true });
    writeFileSync(join(r, "decisions", "2026-03-02-office-lease.md"), note(OLD, "2026-03-02", "superseded", `superseded_by: ${NEW}`,
      "Office lease for the team stays at the old office lease",
      "We compared office lease offers for the team and kept the old office lease. The office lease price was the deciding factor."));
    writeFileSync(join(r, "decisions", "2026-09-15-office-lease.md"), note(NEW, "2026-09-15", "active", `supersedes: ${OLD}`,
      "Team moves to the shared space on Pine Street from November",
      "Moved the team to the shared space after the second visit."));
  });
  const ids = core.search(root, "planner", "office lease for the team", 10).map((h: any) => h.id);
  return { cur: ids.indexOf(NEW), old: ids.indexOf(OLD) };
}

// The question kinds (questions.yaml): direct and direct2 reuse a note's words; heldout and dev2
// don't, but were written by whoever wrote the word map; blind2 was written by a separate writer
// that never saw it, so the 85% gate is measured there.
export const KINDS = ["direct", "heldout", "dev2", "direct2", "blind2"] as const;
const mode = (on: boolean) => (on ? "lexicon" : "plain");
// What the synthetic set scored when committed, per mode and kind; a drop under it is a regression.
const baseline = (): Record<string, Record<string, number>> => JSON.parse(readFileSync(join(SYNTH_DIR, "baseline.json"), "utf8")).recall5;
const synthReady = () => (!core ? "no core at this commit" : undefined);
function synthCase(id: string, title: string, fn: () => Result | Promise<Result>, gap?: string): Case {
  return { id, dimension: "retrieval", title, source: "synthetic", gap, run: async () => { const why = synthReady(); return why ? na(why) : fn(); } };
}
const pct = (x: number) => Math.round(100 * x);
const ofKind = (g: Golden, k: string) => g.rows.filter((r) => r.g.kind === k);

export function synthRetrievalCases(): Case[] {
  const unseen = (on: boolean) => () => {
    const s = r5(ofKind(synthGolden(on), "blind2"));
    return ok(s.rate >= GATE, `${s.hit}/${s.n} (${pct(s.rate)}%) with the word map ${on ? "on" : "off"}`, { recall5: s.rate });
  };
  return [
    synthCase("ret-synth-unseen", `synthetic FR/EN set: questions written blind, in the other language or other words, find a wanted note in the top 5 (gate ${GATE * 100}%, under it add semantic search)`, unseen(false), "G172"),
    synthCase("ret-synth-unseen-lexicon", `synthetic FR/EN set: the same blind questions with the French-English word map on (PB_LEXICON=1), gate ${GATE * 100}%`, unseen(true), "G172"),
    synthCase("ret-synth-baseline", "synthetic FR/EN set: recall@5 holds its committed baseline for every kind of question, word map off and on", () => {
      const b = baseline(), drops: string[] = [], now: string[] = [];
      for (const on of [false, true]) for (const k of KINDS) {
        const r = r5(ofKind(synthGolden(on), k)).rate, was = b[mode(on)]?.[k];
        now.push(`${mode(on)} ${k} ${pct(r)}%`);
        if (was !== undefined && r + 1e-9 < was) drops.push(`${mode(on)} ${k} ${pct(was)}% → ${pct(r)}%`);
      }
      return ok(drops.length === 0, drops.length ? `dropped: ${drops.join(", ")}` : now.join(", "), { recall5: r5(synthGolden(false).rows).rate });
    }),
    synthCase("ret-synth-lexicon-same-words", "synthetic FR/EN set: the word map never costs a question that uses the note's own words", () => {
      const lost = (["direct", "direct2"] as const).flatMap((k) => {
        const off = new Map(ofKind(synthGolden(false), k).map((r) => [r.g.id, r.pos]));
        return ofKind(synthGolden(true), k).filter((r) => { const p = off.get(r.g.id)!; return p >= 0 && p < 5 && !(r.pos >= 0 && r.pos < 5); }).map((r) => r.g.id);
      });
      return ok(lost.length === 0, lost.length ? `lost with the word map: ${lost.join(", ")}` : "no same-words question lost");
    }),
    synthCase("ret-synth-no-forbidden", "synthetic FR/EN set: carve questions never return a note the asking agent may not see, word map off or on", () => {
      const bad = [false, true].flatMap((on) => synthGolden(on).rows.filter((r) => r.leaked.length).map((r) => `${r.g.id}(${mode(on)})`));
      return ok(bad.length === 0, bad.length ? `forbidden note returned for ${bad.join(", ")}` : `${synthGolden(false).rows.filter((r) => r.g.forbid?.length).length} carve questions clean in both modes`);
    }),
    synthCase("ret-synth-context-clean", "synthetic FR/EN set: every context pack built for a limited agent is clean against the leak oracle, word map off or on", async () => {
      const bad: string[] = [];
      for (const on of [false, true]) {
        const { root, rows } = synthGolden(on);
        const forbidden = new Map<string, Awaited<ReturnType<typeof forbiddenFor>>>();
        for (const r of rows.filter((x) => x.g.as)) if (!forbidden.has(r.g.as!)) forbidden.set(r.g.as!, await forbiddenFor(root, r.g.as!));
        for (const r of rows.filter((x) => x.g.as)) {
          const hits = findLeaks(withLexicon(on, () => core.contextPack(root, r.g.as!, r.g.q)), forbidden.get(r.g.as!)!);
          if (hits.length) bad.push(`${r.g.id}(${mode(on)}, ${hits.length})`);
        }
      }
      return ok(bad.length === 0, bad.length ? `leaks in ${bad.join(", ")}` : `${synthGolden(false).rows.filter((x) => x.g.as).length} packs clean in both modes`);
    }),
  ];
}

// The scores the synthetic set gets now, per mode and kind, for writing baseline.json.
export function synthScores() {
  const out: Record<string, Record<string, ReturnType<typeof r5>>> = {};
  for (const on of [false, true]) out[mode(on)] = Object.fromEntries(KINDS.map((k) => [k, r5(ofKind(synthGolden(on), k))]));
  return out;
}

export function retrievalCases(): Case[] {
  return [
    ...synthRetrievalCases(),
    goldenCase("ret-golden-heldout", `golden set: held-out questions find a wanted note in the top 5 (gate ${GATE * 100}%)`, () => {
      const s = r5(golden().rows.filter((r) => r.g.kind === "heldout"));
      return ok(s.rate >= GATE, `${s.hit}/${s.n} (${Math.round(100 * s.rate)}%)${s.misses.length ? `; misses: ${s.misses.join(", ")}` : ""}`, { recall5: s.rate });
    }, "G14"),
    goldenCase("ret-golden-all", `golden set: all questions, recall@5 (gate ${GATE * 100}%)`, () => {
      const s = r5(golden().rows);
      return ok(s.rate >= GATE, `${s.hit}/${s.n} (${Math.round(100 * s.rate)}%)`, { recall5: s.rate });
    }, "G14"),
    goldenCase("ret-golden-no-forbidden", "golden set: carve questions asked as planner, helper or claude never return a forbidden note", () => {
      const bad = golden().rows.filter((r) => r.leaked.length).map((r) => r.g.id);
      return ok(bad.length === 0, bad.length ? `forbidden note returned for ${bad.join(", ")}` : `${golden().rows.filter((r) => r.g.forbid?.length).length} carve questions clean`);
    }),
    goldenCase("ret-golden-context-clean", "golden set: every context pack built for planner, helper or claude is clean against the leak oracle", async () => {
      const { root, rows } = golden();
      const bad: string[] = [];
      for (const r of rows.filter((x) => x.g.as)) {
        const hits = findLeaks(core.contextPack(root, r.g.as!, r.g.q), await forbiddenFor(root, r.g.as!));
        if (hits.length) bad.push(`${r.g.id}(${hits.length})`);
      }
      return ok(bad.length === 0, bad.length ? `leaks in ${bad.join(", ")}` : `${rows.filter((x) => x.g.as).length} packs clean`);
    }),
    { id: "ret-superseded-below-replacement", dimension: "retrieval", title: "a superseded decision that matches the words better still ranks below the decision that replaced it", run: async () => {
      const r = superseded();
      if (!r) return na("no core at this commit");
      return ok(r.cur >= 0 && (r.old < 0 || r.cur < r.old), `replacement at ${r.cur + 1}, superseded at ${r.old < 0 ? "absent" : r.old + 1}`);
    } },
    { id: "ret-superseded-still-found", dimension: "retrieval", title: "a superseded decision is ranked down, never out: it still comes back in the top 5", run: async () => {
      const r = superseded();
      if (!r) return na("no core at this commit");
      return ok(r.old >= 0 && r.old < 5, `superseded at ${r.old < 0 ? "absent" : r.old + 1}`);
    }, gap: "G16" },
    { id: "ret-fresh-before-stale", dimension: "retrieval", title: "a note settled this month ranks above a two-year-old one on the same words", gap: "G15", run: async () => freshness() },
  ];
}
