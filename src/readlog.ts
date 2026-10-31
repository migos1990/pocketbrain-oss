// SPDX-License-Identifier: AGPL-3.0-only
// The read log (log/reads.jsonl): which agent was handed which notes, and when. It is the
// evidence behind `explain` ("who read it") and the use signal behind forgetting (sleep.ts).
// Entries are hash-chained like log/writes.jsonl, so an edited or deleted line shows.
import { sha256, readJsonl, tailOf, endTornLine, withRequestId } from "./util";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  const e = withRequestId(entry);
  const hash = sha256(JSON.stringify({ ...e, prev }));
  appendFileSync(file, JSON.stringify({ ...e, prev, hash }) + "\n");
}

// Lines written before the chain existed (no hash) are counted, not judged. After the first
// chained line, every line must carry the previous line's hash and its own correct hash.
export interface ChainCheck { entries: number; unchained: number; broken?: number; why?: string }
export function verifyChain(file: string): ChainCheck {
  if (!existsSync(file)) return { entries: 0, unchained: 0 };
  return verifyLines(readFileSync(file, "utf8").split("\n").filter(Boolean));
}

function verifyLines(lines: string[]): ChainCheck {
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

// ---------- archive (backlog row 324) ----------
// Without a cut the log grows by a line per read forever, and readers parse all of it. Whole
// months older than the window every reader needs move to log/reads-archive/YYYY-MM.jsonl: the
// forgetting signal looks back 90 days, the week report 8 weeks, the rest less. The archive and
// the live file are still one chain (archive months in name order, then the live file), so a
// removed, edited or missing line anywhere breaks it. Owner-only and git-ignored like the live
// file; backups carry it, as they carry every untracked file.
export const READ_LOG_KEEP_DAYS = 120;
const DAY = 86_400_000;
const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;
const liveFile = (root: string) => join(root, "log", "reads.jsonl");
const archiveDir = (root: string) => join(root, "log", "reads-archive");
const linesOf = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);
const monthOf = (line: string) => { try { return String(JSON.parse(line).at ?? "").slice(0, 7); } catch { return ""; } };

function archiveMonths(root: string): string[] {
  return existsSync(archiveDir(root)) ? readdirSync(archiveDir(root)).filter((f) => MONTH_FILE.test(f)).sort() : [];
}

// The whole log in chain order. A pass cut off after writing the archive but before replacing
// the live file leaves the same lines at the start of the live file; they are read once.
function chainLines(root: string): { archived: string[]; live: string[]; overlap: number } {
  const archived = archiveMonths(root).flatMap((m) => linesOf(join(archiveDir(root), m)));
  const live = linesOf(liveFile(root));
  const seen = new Set(archived);
  let overlap = 0;
  while (overlap < live.length && seen.has(live[overlap])) overlap++;
  return { archived, live: live.slice(overlap), overlap };
}

export function verifyReadLog(root: string): ChainCheck {
  const { archived, live } = chainLines(root);
  return verifyLines([...archived, ...live]);
}

// The live file only, unless `all`: every reader but `explain` looks back less than the window.
export function readEntries(root: string, o: { all?: boolean } = {}): ReadEntry[] {
  if (!o.all) return readJsonl<ReadEntry>(liveFile(root));
  const { archived, live } = chainLines(root);
  const out: ReadEntry[] = [];
  for (const l of [...archived, ...live]) { try { out.push(JSON.parse(l)); } catch { /* torn line */ } }
  return out;
}

// Each agent's reads (context_pack, search, read, who_is, why: every line is one) at or after `since`
// (an ISO time) that `keep` takes, for the home's "read your brain today" line. Only the end of the live file is read while it reaches back far
// enough: the home opens often.
export function readsSince(root: string, since: string, keep: (at: string) => boolean = () => true): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of readEntriesSince(root, since, keep)) out.set(e.agent, (out.get(e.agent) ?? 0) + 1);
  return out;
}

// The read log's lines themselves, oldest first, for the home's "what it asked today" (owner-only).
export function readEntriesSince(root: string, since: string, keep: (at: string) => boolean = () => true): ReadEntry[] {
  const f = liveFile(root);
  if (!existsSync(f)) return [];
  let lines: string[] = [];
  for (const bytes of [262_144, Infinity]) {
    const { text, whole } = bytes === Infinity ? { text: readFileSync(f, "utf8"), whole: true } : tailOf(f, bytes);
    lines = text.split("\n").filter(Boolean).slice(whole ? 0 : 1); // the tail's first line may be cut
    let first: string | undefined;
    try { first = JSON.parse(lines[0] ?? "{}").at; } catch { first = undefined; }
    if (whole || (first && first < since)) break;
  }
  const out: ReadEntry[] = [];
  for (const l of lines) {
    try { const e = JSON.parse(l) as ReadEntry; if (e.agent && e.at >= since && keep(e.at)) out.push(e); } catch { /* torn line */ }
  }
  return out;
}

// When the read log began, archive included: forgetting waits until it is 90 days old.
export function readLogStart(root: string): string | undefined {
  const first = archiveMonths(root)[0];
  for (const l of first ? linesOf(join(archiveDir(root), first)) : linesOf(liveFile(root))) {
    try { const at = JSON.parse(l).at; if (at) return at; } catch { /* torn line */ }
  }
  return undefined;
}

// Moves whole months that ended before the window into the archive. A broken chain is left
// where it is, as evidence. The last line always stays live, so the next read chains to it.
// Each archive month and then the live file are written beside themselves and renamed over.
export function rotateReadLog(root: string, o: { keepDays?: number; now?: number } = {}): { moved: number; months: string[]; skipped?: string } {
  const now = o.now ?? (process.env.PB_NOW ? Date.parse(process.env.PB_NOW) : Date.now());
  const cut = new Date(now - (o.keepDays ?? READ_LOG_KEEP_DAYS) * DAY).toISOString().slice(0, 7);
  if (!existsSync(liveFile(root))) return { moved: 0, months: [] };
  const check = verifyReadLog(root);
  if (check.broken) return { moved: 0, months: [], skipped: `the read log's chain is broken at line ${check.broken} (${check.why}); left as it is` };
  const { live, overlap } = chainLines(root);
  let k = 0;
  while (k < live.length - 1 && monthOf(live[k]) < cut) k++;
  if (!k && !overlap) return { moved: 0, months: [] };
  const existing = archiveMonths(root);
  let last = existing.at(-1)?.slice(0, 7) ?? "";
  const byMonth = new Map<string, string[]>();
  for (const l of live.slice(0, k)) {
    const m = monthOf(l) > last ? monthOf(l) : last; // chain order is file order
    last = m;
    (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(l);
  }
  mkdirSync(archiveDir(root), { recursive: true });
  if (!existsSync(join(archiveDir(root), ".gitignore"))) writeFileSync(join(archiveDir(root), ".gitignore"), "*\n");
  for (const [m, add] of byMonth) {
    const f = join(archiveDir(root), `${m}.jsonl`);
    writeFileSync(`${f}.tmp`, [...linesOf(f), ...add].map((l) => l + "\n").join(""));
    renameSync(`${f}.tmp`, f);
  }
  // A read appended while this ran is kept: appends only add to the end.
  const before = overlap + live.length, now2 = linesOf(liveFile(root));
  const keep = [...live.slice(k), ...now2.slice(before)];
  writeFileSync(`${liveFile(root)}.tmp`, keep.map((l) => l + "\n").join(""));
  renameSync(`${liveFile(root)}.tmp`, liveFile(root));
  return { moved: k, months: [...byMonth.keys()] };
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
