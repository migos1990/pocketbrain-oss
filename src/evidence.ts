// SPDX-License-Identifier: AGPL-3.0-only
// The evidence block on a proposal (docs/gardener.md, "What a proposal shows you"). The hub writes
// it from what it holds, never from what the agent says: the notes the change touches, the refs it
// cites, the value it would replace, and the verify_source verdicts the hub itself logged for those
// refs and this exact value. An agent's own "evidence" stays inside its request, unshown as such.
import { join } from "node:path";
import { readJsonl, sha256 } from "./util";
import type { Note, FactRecord, SourceRef } from "./brain";
import type { WriteRequest } from "./checks";
import { refString } from "./sources";
import { clock } from "./clock";

export const verifyLog = (root: string) => join(root, "log", "sources", "verify.jsonl");
// Which claim a verdict was for, without keeping the claim's words in the log.
export const claimKey = (claim: string) => sha256(claim.trim().toLowerCase().replace(/\s+/g, " ")).slice(0, 12);

export interface Evidence {
  notes: string[];
  refs: string[];
  now?: { value: unknown; as_of?: string; sources: string[] };
  // `withheld`: the source read as instructions, so its quote was kept back (G90); the card says so.
  verified: { ref: string; result: string; by: string; at: string; withheld?: string }[];
}

const VERDICT_DAYS = 30;
const words = (v: unknown): string[] => typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(words) : [];

export function evidenceFor(root: string, req: WriteRequest, notes: Note[]): Evidence {
  const ids = new Set(notes.map((n) => n.fm.id));
  const touched: string[] = [];
  const add = (id: string) => { if (ids.has(id) && !touched.includes(id)) touched.push(id); };
  if (req.id) add(req.id);
  for (const s of [req.text, ...words(req.value)]) for (const m of String(s ?? "").matchAll(/\b([a-z]+\/[a-z0-9][a-z0-9-]*)\b/g)) add(m[1]);
  const refs = [...new Set((req.sources ?? []).map((s: SourceRef) => refString(s)))];
  const out: Evidence = { notes: touched, refs, verified: [] };
  const fact = req.id && req.attribute ? notes.find((n) => n.fm.id === req.id)?.fm.facts?.[req.attribute] : undefined;
  if (fact && !Array.isArray(fact) && typeof fact === "object" && "value" in fact) {
    const f = fact as FactRecord;
    out.now = { value: f.value, ...(f.as_of ? { as_of: String(f.as_of) } : {}), sources: (f.sources ?? []).map((s) => refString(s)) };
  }
  // A verdict is about what a ref says for the fact that cites it: the same value proposed for
  // another note or attribute gets none (the email backs one fact, not every fact with that value).
  const cited = new Set(out.now?.sources ?? []);
  if (refs.some((r) => cited.has(r)) && req.value !== undefined) {
    const key = claimKey(typeof req.value === "string" ? req.value : JSON.stringify(req.value));
    // The hub's clock, as the verdicts were dated by it: PB_NOW stands in for today (CI 2026-11-07, a
    // verdict dated 2026-10-08 aged out of the wall clock's 30 days and every proposal lost it).
    const since = new Date(clock().getTime() - VERDICT_DAYS * 86_400_000).toISOString();
    const last = new Map<string, Evidence["verified"][number]>();
    for (const e of readJsonl<{ at: string; agent: string; ref: string; result: string; claim?: string; withheld?: string }>(verifyLog(root)))
      if (e.agent === req.agent && e.claim === key && refs.includes(e.ref) && cited.has(e.ref) && e.at >= since && e.result !== "unreachable")
        last.set(e.ref, { ref: e.ref, result: e.result, by: e.agent, at: e.at.slice(0, 10), ...(e.withheld ? { withheld: String(e.withheld).slice(0, 120) } : {}) });
    out.verified = [...last.values()];
  }
  return out;
}
