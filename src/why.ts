// SPDX-License-Identifier: AGPL-3.0-only
// Provenance of one fact (backlog 291, docs/why.md): where its value came from, which sources
// back it and how strong they are, who wrote it, which checks it met, and what happened to it.
// The owner sees everything: earlier values, refused and held writes, dispute ids, every writer.
// An agent (`why` tool, core.why) sees only a fact in its own view and only what its read
// already shows: the current records it may see and their sources, with
// other agents named "another assistant", no earlier values (a cell never holds history), and
// only its own writes from the log.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Fact, FactRecord, Note, Sensitivity } from "./brain";
import { isList, isDisputed, sensitivityRank } from "./brain";
import { OWNER } from "./owner";
import { refString, schemeOf, sourceRank, readerRef } from "./sources";
import { readJsonl } from "./util";

export interface WhySource { ref: string; kind: string }
export interface WhyRecord { value?: unknown; as_of: string; by?: string; recorded?: string; verification: string; strength: string; sources: WhySource[]; last_confirmed?: string; ended?: string }
export interface WhyEvent { at: string; by: string; event: string; outcome?: string; step?: number; checks?: string[]; token?: string }
export interface Why { key: string; current: WhyRecord[]; disputed?: string | true; earlier?: WhyRecord[]; events: WhyEvent[] }

// sourceRank's levels (src/sources.ts), in words.
const STRENGTH: Record<string, string> = { "0": "no backing source", "0.5": "relayed by another assistant", "1": "inferred", "2": "a vague source", "3": "an exact source", "4": "checked at its source", "5": "the owner's word" };
export const strengthOf = (r: FactRecord) => STRENGTH[String(sourceRank(r))] ?? "unknown";

export interface WhyFor {
  agent: string; // the caller; the owner sees everything
  may?: (r: FactRecord) => boolean; // whether the caller may see one current record (its level and share_with)
  scrub?: (v: unknown, r?: FactRecord) => unknown; // carved values in the caller's view withheld (view.ts scrubLeaves)
}

const isOwner = (w: WhyFor) => w.agent === OWNER;
// Another agent's name is the owner's to know (a cell drops `by` for the same reason, src/cell.ts).
const writer = (by: string | undefined, w: WhyFor) => (!by || isOwner(w) || by === w.agent || by === OWNER ? by : "another assistant");

function record(r: FactRecord, w: WhyFor, ended?: string): WhyRecord {
  const scrub = w.scrub ?? ((v: unknown) => v);
  return {
    value: scrub(r.value, r), as_of: r.as_of, ...(r.by ? { by: writer(r.by, w) } : {}), ...(r.recorded ? { recorded: r.recorded } : {}),
    verification: r.verification, strength: strengthOf(r),
    // Another assistant's ref names it (G722; builder's slice audit of PR 131): the owner sees it, an agent its own.
    sources: (r.sources ?? []).map((x) => { const ref = refString(x); const shown = isOwner(w) ? ref : readerRef(ref, w.agent); return { ref: String(scrub(shown, r)), kind: schemeOf(ref) ?? "?" }; }),
    ...(r.last_confirmed ? { last_confirmed: r.last_confirmed } : {}), ...(ended ? { ended } : {}),
  };
}

export function factWhy(root: string, note: Note, attr: string, w: WhyFor): Why {
  const key = `${note.fm.id}#${attr}`;
  const f = (Object.hasOwn(note.fm.facts ?? {}, attr) ? note.fm.facts![attr] : undefined) as Fact | undefined;
  // A record the caller may not see is left out without a count: a count would say it exists.
  const keep = (rs: FactRecord[]) => rs.filter((r) => !w.may || w.may(r));
  const items = f && isList(f) ? (f.items as FactRecord[]) : [];
  const current = !f ? [] : isList(f) ? keep(items.filter((i) => !i.valid_to)) : isDisputed(f) ? keep(f.candidates) : keep([f as FactRecord]);
  const owner = isOwner(w);
  // Earlier values are the owner's: an agent's read never shows them.
  const earlier = owner
    ? [...(note.fm.history?.[attr] ?? []), ...items.filter((i) => i.valid_to)].map((r) => record(r, w, r.valid_to ?? (r as FactRecord & { ended_by?: { at?: string } }).ended_by?.at))
    : undefined;
  // The hub's write log for this key. The owner gets every line. An agent gets only its own
  // writes: the rest would tell it who else wrote the fact, how often and when, how disputes
  // went and what checks others met, none of which its read shows (slice audit F1).
  const log = join(root, "log", "writes.jsonl");
  const events: WhyEvent[] = (existsSync(log) ? readJsonl<Record<string, unknown>>(log) : [])
    .filter((e) => e.key === key && (owner || e.agent === w.agent))
    .map((e) => ({
      at: String(e.at ?? ""), by: writer(String(e.agent ?? "?"), w) ?? "?", event: String(e.kind ?? "fact"),
      ...(e.outcome ? { outcome: String(e.outcome) } : {}), ...(typeof e.step === "number" ? { step: e.step } : {}),
      ...(Array.isArray(e.checks) && e.checks.length ? { checks: e.checks.map(String) } : {}),
      ...(e.as && (owner || e.agent === w.agent) ? { token: String(e.as) } : {}),
    }));
  return {
    key, current: current.map((r) => record(r, w)),
    ...(f && isDisputed(f) ? { disputed: owner ? f.dispute : true } : {}),
    ...(earlier ? { earlier } : {}), events,
  };
}

// An agent's filter: a record above its ceiling, or shared with other agents only, is left out.
export const recordFilter = (agent: string, ceiling: Sensitivity, noteLevel: Sensitivity) => (r: FactRecord) =>
  sensitivityRank((r.sensitivity ?? noteLevel) as Sensitivity) <= sensitivityRank(ceiling) && (!r.share_with || r.share_with.includes(agent));

// Plain text for the CLI and the tool.
export function whyText(w: Why): string {
  const src = (r: WhyRecord) => r.sources.map((s) => `${s.ref} (${s.kind})`).join(", ") || "no source";
  const line = (r: WhyRecord) => `${JSON.stringify(r.value)} as of ${r.as_of}; ${r.strength} (${r.verification}); from ${src(r)}${r.by ? `; written by ${r.by}` : ""}${r.recorded ? ` on ${r.recorded}` : ""}${r.last_confirmed ? `; last confirmed ${r.last_confirmed}` : ""}${r.ended ? `; ended ${r.ended}` : ""}`;
  const dispute = w.disputed === true ? " (in dispute: the owner decides)" : w.disputed ? ` (in dispute ${w.disputed})` : "";
  return [
    `Why ${w.key}${dispute}`,
    ...(w.current.length ? w.current.map((r) => `- now: ${line(r)}`) : ["- no current value"]),
    ...(w.earlier ?? []).map((r) => `- before: ${line(r)}`),
    ...w.events.map((e) => `- ${e.at.slice(0, 16).replace("T", " ")} ${e.by}${e.token ? ` (${e.token})` : ""}: ${e.event} ${e.outcome ?? ""}${e.step ? ` at conflict step ${e.step}` : ""}${e.checks?.length ? `; checks: ${e.checks.join(", ")}` : ""}`.trimEnd()),
  ].join("\n");
}
