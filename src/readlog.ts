// SPDX-License-Identifier: AGPL-3.0-only
// The read log (log/reads.jsonl): which agent was handed which notes, and when. It is the
// evidence behind `explain` ("who read it") and the use signal behind forgetting (sleep.ts).
// Entries are hash-chained like log/writes.jsonl, so an edited or deleted line shows.
import { sha256, readJsonl, tailOf, endTornLine } from "./util";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// q: the words of a search or topic; asked: a note the agent asked for and didn't get (hidden
// or missing; the agent got the same answer for both). Owner-only, like the rest of the log.
// grant: a one-time read the owner approved (op ask_read, src/asks.ts), with how it was approved.
export interface ReadEntry { at: string; agent: string; op: string; ids: string[]; q?: string; asked?: string; grant?: string; approved_via?: string; approval_ref?: string; prev?: string; hash?: string }

const ZERO = "0".repeat(64);

// Only the end of the file is read: the log grows by a line per read, and reading all of it on
// every read made a year-old brain's reads slower (docs/perf.md).
export function lastHash(file: string): string {
  if (!existsSync(file)) return ZERO;
  for (const bytes of [65_536, Infinity]) {
    const { text, whole } = bytes === Infinity ? { text: readFileSync(file, "utf8"), whole: true } : tailOf(file, bytes);
    const lines = text.trim().split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= (whole ? 0 : 1); i--) { // the tail's first line may be cut
      try { const h = JSON.parse(lines[i]).hash; if (h) return h; } catch { /* a broken line is reported by verifyChain */ }
    }
    if (whole) break;
  }
  return ZERO;
}

export function appendChained(file: string, entry: Record<string, unknown>) {
  mkdirSync(dirname(file), { recursive: true });
  endTornLine(file);
  const prev = lastHash(file);
  const hash = sha256(JSON.stringify({ ...entry, prev }));
  appendFileSync(file, JSON.stringify({ ...entry, prev, hash }) + "\n");
}

// Lines written before the chain existed (no hash) are counted, not judged. After the first
// chained line, every line must carry the previous line's hash and its own correct hash.
export function verifyChain(file: string): { entries: number; unchained: number; broken?: number; why?: string } {
  if (!existsSync(file)) return { entries: 0, unchained: 0 };
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let prev: string | undefined;
  let unchained = 0;
  for (let i = 0; i < lines.length; i++) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(lines[i]); } catch { return { entries: lines.length, unchained, broken: i + 1, why: "not JSON" }; }
    const { hash, ...rest } = e;
    if (!hash) {
      if (prev !== undefined) return { entries: lines.length, unchained, broken: i + 1, why: "unchained line after the chain started" };
      unchained++;
      continue;
    }
    if (prev !== undefined && rest.prev !== prev) return { entries: lines.length, unchained, broken: i + 1, why: "a line before it was removed or changed" };
    if (prev === undefined && unchained === 0 && rest.prev !== ZERO) return { entries: lines.length, unchained, broken: i + 1, why: "the start of the log is missing" };
    if (sha256(JSON.stringify(rest)) !== hash) return { entries: lines.length, unchained, broken: i + 1, why: "the line was edited" };
    prev = hash as string;
  }
  return { entries: lines.length, unchained };
}

export function readEntries(root: string): ReadEntry[] {
  return readJsonl<ReadEntry>(join(root, "log", "reads.jsonl"));
}

// "*" means the agent pulled its whole view (context_pack without a topic, or a pasted view).
// That says nothing about which note it needed, so it never counts as using a note.
export function specificReads(entries: ReadEntry[], since?: string): Map<string, ReadEntry[]> {
  const out = new Map<string, ReadEntry[]>();
  for (const e of entries) {
    if (since && e.at < since) continue;
    for (const id of e.ids ?? []) if (id !== "*") (out.get(id) ?? out.set(id, []).get(id)!).push(e);
  }
  return out;
}
