// SPDX-License-Identifier: AGPL-3.0-only
// A note's history, read from git: every saved version of the file, who saved it, and what each
// save changed, fact by fact. Also the brain-wide list of what changed this week. Read-only: the
// only buttons on these pages are the undos that already exist (owner-undo, commit-revert,
// upkeep-undo), and they keep their own checks.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isDisputed, isList, parseNote, sensitivityRank, CONTENT_DIRS, type Fact, type FactRecord, type Note, type SourceRef } from "../brain";
import { git } from "../git";
import { OWNER } from "../owner";
import type { Rules } from "../rules";

export interface Commit { hash: string; at: string; author: string; email: string; message: string; kind?: string; run?: string }
export interface Version extends Commit { note?: Note } // note is undefined when the file was deleted or unreadable

export type ChangeType = "created" | "deleted" | "added" | "changed" | "removed" | "forgot" | "private" | "shared" | "confirmed" | "text" | "note-private" | "corrected" | "note-open";
export interface FactChange { type: ChangeType; attr?: string; from?: string; to?: string; sources?: SourceRef[]; level?: string }
export interface Save extends Commit { id: string; actor: string; changes: FactChange[]; v?: number } // v: which saved version of the note, from 1

const FS = "\x1f", RS = "\x1e";
const FORMAT = `${RS}%H${FS}%aI${FS}%an${FS}%ae${FS}%B${FS}`;

function parseLog(out: string): (Commit & { files: string[] })[] {
  return out.split(RS).filter((x) => x.trim()).map((rec) => {
    const [hash, at, author, email, message, rest = ""] = rec.split(FS);
    return {
      hash, at, author, email, message: message.trim(),
      kind: message.match(/^Kind: (.+)$/m)?.[1].trim(), run: message.match(/^Run: (\S+)$/m)?.[1],
      files: rest.split("\n").map((l) => l.trim()).filter(Boolean),
    };
  });
}

// Many file versions in one git call: "<rev>:<path>" -> text, undefined when it doesn't exist.
export function blobs(root: string, specs: string[]): (string | undefined)[] {
  if (!specs.length || !existsSync(join(root, ".git"))) return specs.map(() => undefined);
  const r = Bun.spawnSync(["git", "cat-file", "--batch"], { cwd: root, stdin: Buffer.from(specs.join("\n") + "\n") });
  const buf = Buffer.from(r.stdout);
  const out: (string | undefined)[] = [];
  let at = 0;
  for (let i = 0; i < specs.length && at < buf.length; i++) {
    const nl = buf.indexOf(10, at);
    const head = buf.subarray(at, nl).toString();
    at = nl + 1;
    const m = head.match(/^\S+ (\S+) (\d+)$/);
    if (!m) { out.push(undefined); continue; }
    const size = Number(m[2]);
    out.push(m[1] === "blob" ? buf.subarray(at, at + size).toString("utf8") : undefined);
    at += size + 1;
  }
  while (out.length < specs.length) out.push(undefined);
  return out;
}

function parse(text: string | undefined, id: string): Note | undefined {
  if (text === undefined) return undefined;
  try { return parseNote(text, `${id}.md`); } catch { return undefined; }
}

// Every saved version of one note, oldest first.
export function noteVersions(root: string, id: string, limit = 400): Version[] {
  const log = parseLog(git(root, ["log", `-${limit}`, "--no-merges", `--format=${FORMAT}`, "--", `${id}.md`])).reverse();
  const texts = blobs(root, log.map((c) => `${c.hash}:${id}.md`));
  return log.map(({ files: _f, ...c }, i) => ({ ...c, note: parse(texts[i], id) }));
}

// Who made a commit, as an agent id or "owner". pocketBrain commits as <agent>@pocketbrain.local
// and the owner as owner@ (louis@ in older brains); a commit made any other way (setup, an
// import, git by hand) is the owner's own.
export function actorOf(c: Pick<Commit, "author" | "email">): string {
  const [local, domain] = c.email.toLowerCase().split("@");
  if (domain !== "pocketbrain.local" || local === OWNER || local === "louis") return OWNER;
  return local;
}

const show = (v: unknown) => (typeof v === "object" ? JSON.stringify(v) : String(v ?? ""));
// One fact's value as a line: list items joined, a dispute as such.
export function factValue(f: Fact | undefined): string | undefined {
  if (f === undefined) return undefined;
  if (isDisputed(f)) return "(two answers disagree)";
  if (isList(f)) return f.items.filter((i) => !i.valid_to && !i.retired).map((i) => show(i.value)).join(", ");
  return show((f as FactRecord).value);
}
const recs = (f: Fact | undefined): FactRecord[] => !f || isDisputed(f) ? [] : isList(f) ? f.items.filter((i) => !i.valid_to && !i.retired) : [f as FactRecord];
const level = (f: Fact | undefined) => Math.max(-1, ...recs(f).map((r) => sensitivityRank(r.sensitivity)));
const shares = (f: Fact | undefined) => JSON.stringify(recs(f).map((r) => r.share_with ?? null));
const confirmed = (f: Fact | undefined) => recs(f).map((r) => r.last_confirmed ?? "").sort().at(-1) ?? "";

// What one save changed, fact by fact. `before` undefined means the note was created.
export function changesBetween(before: Note | undefined, after: Note | undefined): FactChange[] {
  if (!after) return before ? [{ type: "deleted" }] : [];
  if (!before) return [{ type: "created" }];
  const out: FactChange[] = [];
  const a = before.fm.facts ?? {}, b = after.fm.facts ?? {};
  for (const attr of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = factValue(a[attr]), y = factValue(b[attr]);
    const src = recs(b[attr]).flatMap((r) => r.sources ?? []);
    if (x !== y) {
      if (x === undefined) out.push({ type: "added", attr, to: y, sources: src });
      else if (y === undefined) out.push({ type: (after.fm.history?.[attr] ?? []).some((r) => r.retired && show(r.value) === x) ? "forgot" : "removed", attr, from: x });
      else out.push({ type: "changed", attr, from: x, to: y, sources: src });
      continue;
    }
    const fixed = (n: Note) => (n.fm.history?.[attr] ?? []).filter((r) => r.ended_by?.correction).length;
    if (fixed(after) > fixed(before)) { out.push({ type: "corrected", attr, from: show((after.fm.history![attr].filter((r) => r.ended_by?.correction).at(-1))!.value), to: y }); continue; }
    if (level(b[attr]) > level(a[attr])) out.push({ type: "private", attr, level: recs(b[attr]).map((r) => r.sensitivity).find(Boolean) });
    else if (shares(b[attr]) !== shares(a[attr])) out.push({ type: "shared", attr, to: [...new Set(recs(b[attr]).flatMap((r) => r.share_with ?? []))].join(",") });
    else if (confirmed(b[attr]) > confirmed(a[attr])) out.push({ type: "confirmed", attr });
  }
  if (sensitivityRank(after.fm.sensitivity) > sensitivityRank(before.fm.sensitivity)) out.push({ type: "note-private", level: after.fm.sensitivity });
  else if (sensitivityRank(after.fm.sensitivity) < sensitivityRank(before.fm.sensitivity)) out.push({ type: "note-open", level: after.fm.sensitivity });
  if (before.body.trim() !== after.body.trim()) out.push({ type: "text" });
  return out;
}

// A note's saves, oldest first, each with what it changed. Saves that changed nothing a reader
// sees (a timestamp, formatting) are dropped.
export function noteSaves(root: string, id: string, versions = noteVersions(root, id)): Save[] {
  const out: Save[] = [];
  let prev: Note | undefined;
  versions.forEach((v, i) => {
    const changes = changesBetween(prev, v.note);
    if (v.note) prev = v.note;
    if (changes.length) out.push({ ...v, id, actor: actorOf(v), changes, v: i + 1 });
  });
  return out;
}

// A moment from a URL: a bare date means the end of that day, on this computer's clock.
export function momentOf(at: string): number | undefined {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(at) ? `${at}T23:59:59` : at);
  return Number.isNaN(t) ? undefined : t;
}

// The note as it was at a moment: the last version saved at or before it. "v3" is the third
// saved version itself, for two saves in the same second.
export function versionAt(versions: Version[], at: string): Version | undefined {
  const n = at.match(/^v(\d+)$/)?.[1];
  if (n) return versions[Number(n) - 1];
  const t = momentOf(at);
  if (t === undefined) return undefined;
  return versions.filter((v) => Date.parse(v.at) <= t).at(-1);
}

// One value a fact held: from the brain's own records (the current value and its `history:`),
// so a value set before git saw the note still has its dates and source.
export interface Span { value: string; from?: string; until?: string; by: string; sources: SourceRef[]; verification: string; current: boolean; retired?: { at: string; why: string }; recorded?: string; sensitivity?: string; correction?: boolean }

export function spans(n: Note): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  const add = (attr: string, r: FactRecord, current: boolean) => {
    const list = out.get(attr) ?? [];
    list.push({
      value: show(r.value), from: r.as_of, until: r.valid_to ?? r.ended_by?.at ?? r.retired?.at, by: r.by,
      sources: r.sources ?? [], verification: r.verification, current: current && !r.retired && !r.valid_to,
      retired: r.retired ? { at: r.retired.at, why: r.retired.why } : undefined, recorded: r.recorded, sensitivity: r.sensitivity, correction: r.ended_by?.correction,
    });
    out.set(attr, list);
  };
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    if (isDisputed(f)) { for (const c of f.candidates) add(attr, c, true); continue; }
    if (isList(f)) { for (const i of f.items) add(attr, i, !i.valid_to && !i.retired); continue; }
    add(attr, f as FactRecord, true);
  }
  for (const [attr, rs] of Object.entries(n.fm.history ?? {})) for (const r of rs) add(attr, r, false);
  for (const list of out.values()) list.sort((a, b) => Number(b.current) - Number(a.current) || String(b.from ?? "").localeCompare(String(a.from ?? "")));
  return out;
}

// The save that first held a value of a fact, so its row can say who saved it and open that day.
export function firstSaveOf(saves: Save[], attr: string, value: string): Save | undefined {
  return saves.find((s) => s.changes.some((c) => c.attr === attr && (c.type === "added" || c.type === "changed") && c.to !== undefined && c.to.split(", ").includes(value)))
    ?? saves.find((s) => s.changes.some((c) => c.type === "created"));
}

// Commits a later `git revert` undid (owner-undo and commit-revert both make one).
export function revertedHashes(root: string): Set<string> {
  return new Set(git(root, ["log", "--format=%b", "--grep", "^This reverts commit "]).match(/[0-9a-f]{40}/g) ?? []);
}

// Which undo already exists for a save, if any: the owner's own dashboard edit, an outside
// agent's commit, or a night of upkeep (the whole run).
export type Undo = { action: "owner-undo"; hash: string } | { action: "commit-revert"; hash: string } | { action: "upkeep-undo"; run: string };
export function undoFor(rules: Rules, c: Save, reverted: Set<string>): Undo | undefined {
  if (reverted.has(c.hash)) return undefined;
  if (c.actor === OWNER) return c.kind === "owner-edit" && /^owner: /.test(c.message) ? { action: "owner-undo", hash: c.hash } : undefined;
  if (c.run && /^reflect-[0-9T-]+$/.test(c.run) && c.kind === "auto-fix") return { action: "upkeep-undo", run: c.run };
  const a = rules.policy.agents[c.author];
  if (a && !a.inside_wall && c.author === c.actor) return { action: "commit-revert", hash: c.hash };
  return undefined;
}

const CONTENT = CONTENT_DIRS.filter((d) => d !== "disputes");

// Every save to a content note since a date, newest first, with what it changed.
export function savesSince(root: string, since: string, limit = 200): Save[] {
  const log = parseLog(git(root, ["log", `-${limit}`, "--no-merges", `--since=${since}`, `--format=${FORMAT}`, "--name-only", "--", ...CONTENT]));
  const items = log.flatMap((c) => c.files.filter((f) => f.endsWith(".md") && CONTENT.includes(f.split("/")[0])).map((f) => ({ c, id: f.replace(/\.md$/, "") })));
  const texts = blobs(root, items.flatMap(({ c, id }) => [`${c.hash}^:${id}.md`, `${c.hash}:${id}.md`]));
  const out: Save[] = [];
  items.forEach(({ c, id }, i) => {
    const { files: _f, ...commit } = c;
    const changes = changesBetween(parse(texts[2 * i], id), parse(texts[2 * i + 1], id));
    if (changes.length) out.push({ ...commit, id, actor: actorOf(c), changes });
  });
  return out;
}

// The whole brain as it was at a moment: every content note in the last commit at or before it.
export function brainAt(root: string, at: string): { at: string; notes: Note[] } | undefined {
  const t = momentOf(at);
  if (t === undefined) return undefined;
  const commit = git(root, ["rev-list", "-1", "--first-parent", `--before=${new Date(t).toISOString()}`, "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(commit)) return undefined;
  const files = git(root, ["ls-tree", "-r", "--name-only", commit, "--", ...CONTENT]).split("\n").filter((f) => f.endsWith(".md"));
  const texts = blobs(root, files.map((f) => `${commit}:${f}`));
  const notes = files.map((f, i) => parse(texts[i], f.replace(/\.md$/, ""))).filter((n): n is Note => !!n);
  return { at: git(root, ["log", "-1", "--format=%aI", commit]), notes };
}
