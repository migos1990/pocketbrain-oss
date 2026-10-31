// SPDX-License-Identifier: AGPL-3.0-only
// Brain health in the week report (docs/real-use-bar.md, "Brain health in the week report"): numbers that show the brain
// decaying before the owner feels it, each with the one action that improves it, and last week's
// number next to it. Counts only: no fact value, title or source ever appears in a line.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FactRecord, Note } from "./brain";
import { isDisputed, isList, linksIn, loadBrain, today } from "./brain";
import { loadRules, attributeSpec, shelfLifeDays, type Rules } from "./rules";
import { recordFreshness, daysBetween } from "./freshness";
import { refString, schemeOf, SCHEMES } from "./sources";
import { isOwnerConfirmed } from "./owner";
import { notesInUse, UNUSED_DAYS } from "./sleep";
import { readJsonl, appendJsonl } from "./util";
import { summaryOf } from "./wiki";
import type { CallLine } from "./calls";

export type HealthKey = "unsourced" | "stale" | "old-disputes" | "unread" | "no-summary" | "gardener-refused" | "unlinked" | "broken-links";
export interface HealthLine { key: HealthKey; label: string; count: number; of: number; since?: string; last?: number; fix: string }

const DISPUTE_DAYS = 7;

// A live source is one that still stands behind the value: the owner's word, or an exact ref
// (a message, an event, a document) the hub hasn't marked as moved or gone. An agent's own memory,
// a vague pointer or "unverified" is not one.
export function hasLiveSource(r: FactRecord): boolean {
  if (r.recheck) return false;
  if (isOwnerConfirmed(r.verification) || r.verification === "confirmed-by-co-owner") return true;
  return (r.sources ?? []).some((s) => ["louis", "exact"].includes(SCHEMES[schemeOf(refString(s)) ?? ""] ?? ""));
}

// Every fact still in force on a content note: a single value, or each live item of a list.
// Ended, retired and disputed ones are left out (disputes have their own line).
export function liveRecords(n: Note): { attr: string; r: FactRecord }[] {
  const out: { attr: string; r: FactRecord }[] = [];
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (isDisputed(f)) continue;
    const recs = isList(f) ? f.items : [f as FactRecord];
    for (const r of recs) if (!r.valid_to && !r.retired && !(r as { dispute?: string }).dispute) out.push({ attr, r });
  }
  return out;
}

const REFUSED_DAYS = 7;
const GARDENER_WRITES = new Set(["wiki_sync", "remember", "retire"]);
function gardenerRefused(root: string, rules: Rules, now: string): { count: number; of: number } {
  const file = join(root, "log", "calls.jsonl");
  const from = new Date(Date.parse(`${now}T00:00:00Z`) - REFUSED_DAYS * 86_400_000).toISOString().slice(0, 10);
  const gardeners = new Set(Object.entries(rules.policy.agents).filter(([, a]) => (a as { role?: string }).role === "gardener").map(([k]) => k));
  const calls = existsSync(file) ? readJsonl<CallLine>(file).filter((l) => gardeners.has(l.agent) && GARDENER_WRITES.has(l.tool) && String(l.at).slice(0, 10) >= from) : [];
  return { count: calls.filter((l) => l.refused).length, of: calls.length };
}

// How well notes are tied together (memory-graph.md, docs/real-use-bar.md): notes with no link in
// or out, and links to a note that doesn't exist. Counts only, like every line here.
const LINKED_DIRS = new Set(["people", "orgs", "projects", "decisions", "notes", "money"]);
export function graphCounts(notes: Note[]): { notes: number; isolated: number; links: number; broken: number } {
  const live = notes.filter((n) => LINKED_DIRS.has(n.fm.id.split("/")[0]) && n.fm.status !== "merged");
  const all = new Set(notes.map((n) => n.fm.id));
  const touched = new Set<string>();
  let links = 0, broken = 0;
  for (const n of live) for (const to of new Set([...linksIn(n.body), ...linksIn(JSON.stringify(n.fm.facts ?? {}))])) {
    if (to === n.fm.id || to === "redacted") continue;
    links++;
    if (!all.has(to)) { broken++; continue; }
    touched.add(n.fm.id); touched.add(to);
  }
  return { notes: live.length, isolated: live.filter((n) => !touched.has(n.fm.id)).length, links, broken };
}

const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0);

export function brainHealth(root: string, notes: Note[] = loadBrain(root), now = today()): HealthLine[] {
  const rules = loadRules(root);
  const content = notes.filter((n) => n.fm.type !== "dispute");
  let facts = 0, unsourced = 0, volatile = 0, stale = 0;
  for (const n of content) for (const { attr, r } of liveRecords(n)) {
    facts++;
    if (!hasLiveSource(r)) unsourced++;
    const spec = attributeSpec(rules, n.fm.type, attr);
    if (!shelfLifeDays(spec)) continue;
    volatile++;
    if (recordFreshness(r, spec, now) === "stale") stale++;
  }
  const open = notes.filter((n) => n.fm.type === "dispute" && n.fm.status === "open");
  const oldOpen = open.filter((n) => daysBetween(String(n.fm.created ?? now), now) > DISPUTE_DAYS).length;
  // A note counts once it is old enough to have been missed for the whole window.
  const aged = content.filter((n) => daysBetween(String(n.fm.created ?? now), now) >= UNUSED_DAYS);
  const { used, logSince } = notesInUse(root, content, now);
  const pages = content.filter((n) => (n.fm.type === "person" || n.fm.type === "project") && !["archived", "superseded"].includes(String(n.fm.status ?? "")));
  const logDays = logSince ? daysBetween(logSince.slice(0, 10), now) : 0;
  const g = graphCounts(notes);
  const lines: HealthLine[] = [
    { key: "unsourced", label: "Facts with no live source", count: unsourced, of: facts, fix: "run pocketbrain sources backfill <source>: a fact your mail still states gets that mail as its source" },
    { key: "stale", label: "Stale facts that change over time", count: stale, of: volatile, fix: `mark them Still true or change them under the Brain's Needs a look` },
    { key: "old-disputes", label: `Conflicts open more than ${DISPUTE_DAYS} days`, count: oldOpen, of: open.length, fix: `settle them from Waiting on you on the home` },
    { key: "unread", label: `Notes no assistant read in ${UNUSED_DAYS} days`, count: aged.filter((n) => !used.has(n.fm.id)).length, of: aged.length,
      since: logDays < UNUSED_DAYS ? (logSince?.slice(0, 10) ?? "never") : undefined, fix: "nothing by hand: the nightly pass forgets their facts past shelf life (pocketbrain undo --run brings one back)" },
    // The wiki (docs/wiki.md): an assistant asking who someone is gets the summary, not a list of facts.
    { key: "no-summary", label: "People and projects with no wiki summary", count: pages.filter((n) => !summaryOf(n)).length, of: pages.length,
      fix: "nothing by hand: the Gardener writes them from their facts, a few each night (pocketbrain wiki sync on lets it)" },
    // Pages stay empty and facts go unwritten when the hub refuses what the Gardener writes, not
    // only when it doesn't run: a refused write is otherwise only in the Gardener's own transcript.
    { key: "gardener-refused", label: `Gardener writes the hub refused in ${REFUSED_DAYS} days`, ...gardenerRefused(root, rules, now),
      fix: "nothing by hand while it stays low: each refusal says what to change and the Gardener tries once more; if it stays high, run pocketbrain week to see the refusal kinds" },
    { key: "unlinked", label: "Notes not linked to any other note", count: g.isolated, of: g.notes,
      fix: "nothing by hand for names: upkeep links a name that fits one note each night; for the rest, add a [[link]] where a note mentions another" },
    { key: "broken-links", label: "Links to a note that doesn't exist", count: g.broken, of: g.links,
      fix: "open the upkeep review lines (broken-link) in the digest and point each at the right note, or remove it" },
  ];
  return lines;
}

// Last week's numbers come from log/health.jsonl, one row per week report; a report re-run for
// the same day replaces nothing and compares with the row before it.
export function withTrend(root: string, lines: HealthLine[], end: string): HealthLine[] {
  const file = join(root, "log", "health.jsonl");
  const rows = existsSync(file) ? readJsonl<{ date: string; pct: Record<string, number> }>(file) : [];
  const prev = rows.filter((r) => r.date < end).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!rows.some((r) => r.date === end)) appendJsonl(file, { date: end, pct: Object.fromEntries(lines.filter((l) => !l.since).map((l) => [l.key, pct(l.count, l.of)])) });
  return lines.map((l) => (prev?.pct[l.key] === undefined ? l : { ...l, last: prev.pct[l.key] }));
}

export function healthLines(lines: HealthLine[]): string[] {
  return ["## Brain health", "", ...lines.map((l) => {
    if (l.since) return `- ${l.label}: no data yet (reads logged since ${l.since}).`;
    const trend = l.last === undefined ? "" : `; last week ${l.last}%`;
    const fix = l.count ? ` Fix: ${l.fix}.` : "";
    return `- ${l.label}: ${pct(l.count, l.of)}% (${l.count} of ${l.of}${trend}).${fix}`;
  }), ""];
}
