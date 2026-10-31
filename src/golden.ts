// SPDX-License-Identifier: AGPL-3.0-only
// The golden set (docs/prove-the-loop.md#the-golden-set): the owner's real weekly questions, each asked
// through an agent's view and scored against the fact that answers it. The file lives in the brain
// (evals/weekly.yaml), never in this repository; examples/brain carries five synthetic ones. Output
// names ids, ranks and freshness only, never a question, an answer or a value.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { askAs } from "./core";
import { loadBrain, today, isList, isDisputed, type FactRecord } from "./brain";
import { loadRules, attributeSpec, shelfLifeDays, DATED } from "./rules";
import { datesIn, daysBetween, passedDay } from "./freshness";

export interface Golden { id: string; as: string[]; q: string; want: string[]; expect: string; answer?: string }
export type Grade = "pass" | "watch" | "fail";
export interface GoldenRow { id: string; agent: string; rank: number | null; freshness: string; grade: Grade; why: string }

export function goldenFile(root: string): string | undefined {
  return [process.env.PB_GOLDEN, join(root, "evals", "weekly.yaml")].find((f): f is string => !!f && existsSync(f));
}

// `questions: [{ id, theme, as, q, want: [note ids], expect, answer? }]`. `as` defaults to claude,
// `expect` to body (the note's text); `answer`, when given, must appear in the expected fact.
export function loadGolden(file: string): Golden[] {
  const raw = YAML.parse(readFileSync(file, "utf8"));
  const list: any[] = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
  const ids = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(String).filter(Boolean);
  return list.map((o, i) => ({
    id: String(o?.id ?? `w${i + 1}`).replace(/[^\w-]/g, ""), as: ids(o?.as).length ? ids(o?.as) : ["claude"],
    q: String(o?.q ?? ""), want: ids(o?.want), expect: String(o?.expect ?? "body"),
    ...(o?.answer != null ? { answer: String(o.answer) } : {}),
  })).filter((g) => g.q && g.want.length);
}

// One question through one agent: a wanted note in its top 5, the expected fact shown, fresh.
// Stale (old, or its date has passed) and disputed fail: the agent would serve a wrong answer.
// Due passes as a watch: right today, but it needs a recheck.
// Why a fact the owner relies on reads stale or due, and where it waits: days and attribute names
// only, never the value or its date.
export function staleWhy(root: string, id: string, attr: string, day = today()): string {
  const n = loadBrain(root).find((x) => x.fm.id === id);
  const f = n?.fm.facts?.[attr];
  if (!n || !f || isList(f) || isDisputed(f)) return "";
  const r = f as FactRecord, rules = loadRules(root), spec = attributeSpec(rules, String(n.fm.type), attr);
  const ends = !!(spec.ends_on_date || spec.shelf_life === "until_date");
  const passed = passedDay(r, spec, day);
  const dated = typeof r.value === "string" && datesIn(r.value, r.as_of).length > 0;
  const shelf = shelfLifeDays(spec);
  const days = (d: number) => `${d} day${d === 1 ? "" : "s"}`;
  const cause = passed ? `its date passed ${days(daysBetween(passed, day))} ago`
    : [r.review_after && r.review_after <= day ? "its review date passed" : shelf ? `last checked ${days(daysBetween(r.last_confirmed ?? r.as_of, day))} ago (shelf life ${shelf}d)` : "",
      !ends ? (dated ? `${attr} names a date but doesn't end on it (only ${DATED.slice(0, -1).join(", ")} and ${DATED.at(-1)} do)` : "")
        : !dated ? "no date in it ends it" : "confirmed since its date"].filter(Boolean).join("; ");
  // Only a conflict asks the owner (G452): this waits under Needs a look.
  return `${cause}; it waits under Needs a look, nothing asks`;
}

export function askOne(root: string, g: Golden, agent: string): GoldenRow {
  const row = (rank: number | null, freshness: string, grade: Grade, why: string): GoldenRow => ({ id: g.id, agent, rank, freshness, grade, why });
  let probe;
  try { probe = askAs(root, agent, g.q, 5); } catch { return row(null, "-", "fail", "the agent can't read the brain"); }
  const at = probe.hits.findIndex((h) => g.want.includes(h.id));
  if (at < 0) return row(null, "-", "fail", "no wanted note in its top 5");
  const n = probe.note(probe.hits[at].id);
  if (!n) return row(at + 1, "-", "fail", "the note is outside its view");
  if (g.expect === "body") return n.body?.trim() ? row(at + 1, "-", "pass", "found; the note has text") : row(at + 1, "-", "fail", "the note has no text it can see");
  const line = String(n.markdown).split("\n").find((l) => l.startsWith(`- **${g.expect}** [`));
  if (!line) return row(at + 1, "-", "fail", `${g.expect} is not shown`);
  const fresh = line.match(/^- \*\*[^*]+\*\* \[(\w+)\]/)?.[1] ?? "-";
  if (g.answer && !line.toLowerCase().includes(g.answer.toLowerCase())) return row(at + 1, fresh, "fail", `${g.expect} doesn't say the expected answer`);
  if (fresh === "current") return row(at + 1, fresh, "pass", `${g.expect} shown, current`);
  const why = fresh === "stale" || fresh === "due" ? staleWhy(root, probe.hits[at].id, g.expect) : "";
  const and = why ? `; ${why}` : "";
  if (fresh === "due") return row(at + 1, fresh, "watch", `${g.expect} shown, due for a recheck${and}`);
  return row(at + 1, fresh, "fail", `${g.expect} is ${fresh}: the agent would serve an old answer${and}`);
}

export function runGolden(root: string, opts: { agent?: string; file?: string } = {}) {
  const file = opts.file ? (existsSync(opts.file) ? opts.file : undefined) : goldenFile(root);
  if (!file) return { file: undefined, rows: [] as GoldenRow[], text: "no golden set: add evals/weekly.yaml to the brain (docs/prove-the-loop.md#the-golden-set)" };
  const rows = loadGolden(file).flatMap((g) => (opts.agent ? [opts.agent] : g.as).map((a) => askOne(root, g, a)));
  const passed = rows.filter((r) => r.grade !== "fail").length;
  const text = [
    `Golden set: ${passed}/${rows.length} answered right and fresh`,
    ...rows.map((r) => `  ${r.grade.padEnd(5)} ${r.id} ${r.agent}: ${r.rank ? `rank ${r.rank}, ` : ""}${r.why}`),
  ].join("\n");
  return { file, rows, text };
}
