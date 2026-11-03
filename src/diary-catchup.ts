// SPDX-License-Identifier: AGPL-3.0-only
// The diary catches up with every fact change that has no row of its own (phone UI spec §6; the
// Mac's use-it check, 2026-10-26): write() and settle() add their row in their own commit, but the
// hub's other commits (filing, upkeep, merges, hand edits) and everything from before the diary
// existed don't. This reads the commits since the last catch-up (7 days back the first time), skips
// any that already touched diary/, and adds one row per fact whose shown value changed, by the
// record's writer, at the commit's time. Page text, names and rules change no fact and add nothing.
// Hub state only for the cursor (.git/pb-diary-cursor): new commits are read oldest first, the
// first 7 days newest first, so the home fills from today backwards. A lost cursor re-reads 7 days
// and skips commits a row already names.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote, CONTENT_DIRS, sensitivityRank, type Note, type FactRecord } from "./brain";
import { appendDiary, diaryRow, readDiary, shownValue, DIARY_DIR, type DiaryKind, type DiaryRow } from "./diary";
import { gitRun, commitPaths, gitTime } from "./git";
import { sourceRank } from "./sources";
import { isOwnerConfirmed } from "./owner";
import { foldLog } from "./fold";

export const CATCHUP_DAYS = 7;
const cursorFile = (root: string) => join(root, ".git", "pb-diary-cursor");
const FOLDERS = new Set(CONTENT_DIRS.filter((d) => d !== "disputes"));

function noteAt(root: string, rev: string, path: string): Note | undefined {
  const r = gitRun(root, ["show", `${rev}:${path}`]);
  if (!r.ok) return undefined;
  try { return parseNote(r.out, path); } catch { return undefined; }
}

// HEAD's commit from .git's files (a loose ref, else packed-refs), without starting git; undefined
// when it can't tell (the caller then asks git).
export function headSha(root: string): string | undefined {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.match(/^ref: (refs\/[^\s]+)$/)?.[1];
    if (!ref) return undefined;
    const loose = join(root, ".git", ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8").split("\n").find((l) => l.endsWith(` ${ref}`));
    return packed?.split(" ")[0];
  } catch { return undefined; }
}

const key = (v: unknown) => JSON.stringify(v ?? null);
const liveRecord = (f: unknown): FactRecord | undefined => {
  const o = f as { items?: FactRecord[]; dispute?: string; value?: unknown } | undefined;
  if (!o || o.dispute) return undefined;
  if (Array.isArray(o.items)) return o.items.filter((i) => !i.valid_to).at(-1);
  return o as FactRecord;
};

// The rows one commit's change to one note makes.
function rowsFor(before: Note | undefined, after: Note, at: string, author: string, commit: string): DiaryRow[] {
  const out: DiaryRow[] = [];
  const attrs = new Set([...Object.keys(before?.fm.facts ?? {}), ...Object.keys(after.fm.facts ?? {})]);
  for (const attr of attrs) {
    const was = shownValue(before?.fm.facts?.[attr]), now = shownValue(after.fm.facts?.[attr]);
    if (key(was) === key(now)) continue;
    const f = after.fm.facts?.[attr] as { dispute?: string } | undefined;
    const rec = liveRecord(f) ?? liveRecord(before?.fm.facts?.[attr]);
    const push = (kind: DiaryKind, from: unknown, to: unknown) => {
      const incoming = { value: to, as_of: rec?.as_of ?? at.slice(0, 10), sources: rec?.sources ?? [], verification: rec?.verification ?? "unverified", by: rec?.by ?? author, recorded: rec?.recorded ?? at.slice(0, 10), ...(rec?.confidence ? { confidence: rec.confidence } : {}) } as FactRecord;
      const sensitivity = [rec?.sensitivity, after.fm.sensitivity].filter(Boolean).sort((a, b) => sensitivityRank(b!) - sensitivityRank(a!))[0] ?? "personal";
      out.push({ ...diaryRow({ at, factKey: `${after.fm.id}#${attr}`, title: String(after.fm.title ?? after.fm.id), kind, from, to, incoming, rank: isOwnerConfirmed(incoming.verification) ? 5 : sourceRank(incoming), sensitivity: sensitivity as never }), commit });
    };
    if (f?.dispute) { push("conflict", was, undefined); continue; }
    if (now === undefined) { push("retracted", was, undefined); continue; }
    if (was === undefined) { push("new", undefined, now); continue; }
    if (Array.isArray(was) && Array.isArray(now)) {
      const old = new Set(was.map(key));
      const added = now.filter((v) => !old.has(key(v)));
      const kept = was.every((v) => now.some((x) => key(x) === key(v)));
      if (added.length && kept) { for (const v of added) push("item_added", undefined, v); continue; }
    }
    push("changed", was, now);
  }
  return out;
}

export interface CatchUp {
  commits: number; // commits read this run
  rows: number; // diary lines added (or that would be, on a dry run)
  skipped: { diary: number; first: number; no_notes: number; known: number };
  notes: number; // note versions compared
  kinds: Record<string, number>;
  pending: number; // commits still to read, newest first, on later ticks
  unsaved?: string;
}
// Where the catch-up stands: `head` is where reading forward resumes; `back`, while the first
// 7 days are still being read, is the oldest commit read so far ("" once done). Hub state, in .git/.
interface Cursor { head: string; back: string; since: string }
const MAX_NOTES = 1500; // note versions compared per run, so one tick never holds the write queue long

function readCursor(root: string): Cursor | undefined {
  if (!existsSync(cursorFile(root))) return undefined;
  const t = readFileSync(cursorFile(root), "utf8").trim();
  try { const c = JSON.parse(t) as Cursor; return typeof c.head === "string" ? c : undefined; } catch { return undefined; }
}

interface Commit { sha: string; parent?: string; at: string; author: string; files: string[] }
// Every commit in a range with its files, in one git call.
function commitsIn(root: string, range: string[]): Commit[] {
  const out = gitRun(root, ["log", "--first-parent", "-m", "--format=%x01%H%x00%P%x00%cI%x00%an", "--name-only", ...range]).out;
  return out.split("\x01").filter((b) => b.trim()).map((b) => {
    const [head, ...rest] = b.split("\n");
    const [sha, parents, at, author] = head!.split("\0");
    return { sha: sha!, parent: parents?.split(" ")[0] || undefined, at: gitTime(at!), author: author ?? "hub", files: rest.map((x) => x.trim()).filter(Boolean) };
  });
}

// dryRun: read and count only; nothing is written, not even the cursor (`pocketbrain diary catchup --dry-run`).
export function catchUpDiary(root: string, now: Date, o: { days?: number; dryRun?: boolean } = {}): CatchUp {
  const res: CatchUp = { commits: 0, rows: 0, skipped: { diary: 0, first: 0, no_notes: 0, known: 0 }, notes: 0, kinds: {}, pending: 0 };
  const cur = readCursor(root);
  // The minute tick on an idle hub: HEAD hasn't moved and the first week is read, so no git at all
  // (HEAD is read from .git's own files).
  if (cur && !cur.back && cur.head === headSha(root)) return res;
  const head = gitRun(root, ["rev-parse", "HEAD"]);
  if (!head.ok) return res;
  if (cur && cur.head === head.out && !cur.back) return res;
  const since = cur?.since ?? new Date(now.getTime() - (o.days ?? CATCHUP_DAYS) * 86_400_000).toISOString();
  const valid = (c?: string) => !!c && gitRun(root, ["cat-file", "-e", `${c}^{commit}`]).ok;
  // Forward from the last head (oldest first), then the first 7 days from the newest down.
  const forward = cur && valid(cur.head) ? commitsIn(root, ["--reverse", `${cur.head}..HEAD`]) : [];
  const backStart = !cur || !valid(cur.head) ? head.out : cur.back && valid(cur.back) ? `${cur.back}^` : undefined;
  const backward = backStart && gitRun(root, ["rev-parse", "--verify", "-q", backStart]).ok ? commitsIn(root, [`--since=${since}`, backStart]) : [];
  const named = new Set(readDiary(root).map((r) => r.commit).filter(Boolean));
  // A fold is one line whose Undo is the fold's (audit v11), never a line per moved fact; a fold's
  // own undo makes no lines (its line says Undone).
  const folds = foldLog(root);
  const foldAt = new Map(folds.filter((f) => f.commit).map((f) => [f.commit!, f]));
  const quiet = new Set(folds.map((f) => f.undo_commit).filter(Boolean));
  const rows: DiaryRow[] = [];
  let lastForward = cur?.head ?? head.out, lastBack = cur?.back ?? head.out, budget = MAX_NOTES;
  const read = (c: Commit): boolean => {
    const notes = c.files.filter((p) => p.endsWith(".md") && FOLDERS.has(p.split("/")[0]!));
    if (budget - notes.length < 0 && res.commits > 0) return false;
    res.commits++;
    if (named.has(c.sha)) { res.skipped.known++; return true; }
    if (c.files.some((p) => p.startsWith(`${DIARY_DIR}/`))) { res.skipped.diary++; return true; } // its rows came with it
    if (!c.parent) { res.skipped.first++; return true; } // the brain's first commit is where it started, not something it learned
    if (!notes.length) { res.skipped.no_notes++; return true; }
    if (quiet.has(c.sha)) { res.skipped.known++; return true; }
    const fold = foldAt.get(c.sha);
    if (fold) {
      const keep = noteAt(root, c.sha, notes.find((p) => noteAt(root, c.sha, p)?.fm.id === fold.keep) ?? ""), drop = noteAt(root, c.parent, notes.find((p) => noteAt(root, c.parent!, p)?.fm.id === fold.drop) ?? "");
      if (keep) {
        const at = new Date(c.at).toISOString(), d = at.slice(0, 10);
        const sensitivity = [keep.fm.sensitivity, drop?.fm.sensitivity].filter(Boolean).sort((a, b) => sensitivityRank(b!) - sensitivityRank(a!))[0] ?? "personal";
        rows.push({ ...diaryRow({ at, factKey: `${fold.keep}#`, title: String(keep.fm.title ?? fold.keep), kind: "folded", from: undefined, to: undefined, incoming: { value: undefined, as_of: d, sources: [], verification: "unverified", by: c.author, recorded: d } as never, rank: 0, sensitivity: sensitivity as never }), commit: c.sha, fold: c.sha, dropped: fold.drop });
      }
      budget -= notes.length; res.notes += notes.length;
      return true;
    }
    for (const p of notes) {
      budget--; res.notes++;
      const after = noteAt(root, c.sha, p);
      if (!after) continue; // a note taken out (forget) has its own record
      rows.push(...rowsFor(noteAt(root, c.parent, p), after, new Date(c.at).toISOString(), c.author, c.sha));
    }
    return true;
  };
  for (const c of forward) { if (!read(c)) break; lastForward = c.sha; }
  if (!cur || !valid(cur.head)) lastForward = head.out;
  let backDone = !backStart;
  for (const [i, c] of backward.entries()) { if (!read(c)) break; lastBack = c.sha; if (i === backward.length - 1) backDone = true; }
  if (!backward.length) backDone = true;
  res.pending = Math.max(0, forward.length + backward.length - res.commits);
  for (const r of rows) res.kinds[r.kind] = (res.kinds[r.kind] ?? 0) + 1;
  res.rows = rows.length;
  if (o.dryRun) return res;
  const save = () => writeFileSync(cursorFile(root), JSON.stringify({ head: lastForward, back: backDone ? "" : lastBack, since } satisfies Cursor));
  if (!rows.length) { save(); return res; }
  const paths = new Set<string>();
  for (const r of rows) paths.add(appendDiary(root, r, r.at.slice(0, 7)));
  const unsaved = commitPaths(root, [...paths], `hub: diary catch-up, ${rows.length} ${rows.length === 1 ? "line" : "lines"}\n\nWhy: these fact changes were saved without a diary line (the hub's own filing, upkeep, or before the diary existed), so the owner's home showed nothing for them.\nKind: diary-catchup`, "hub");
  if (unsaved) return { ...res, rows: 0, unsaved };
  save(); // our own commit touched diary/ and is skipped when read forward
  return res;
}
