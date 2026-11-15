// SPDX-License-Identifier: AGPL-3.0-only
// The owner has seen it (phone UI spec §7, owner 2026-10-26): an assistant's private, money-,
// health- or legal-shaped value is held from every agent (`unseen`, set by write(), hidden by carve.ts
// factHiddenReason) until the owner taps Show on the home. This takes the mark off the fact's live
// records in one owner commit, adds a `seen` diary row, and has the page writer say it at once.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadBrain, saveNote, today, type FactRecord } from "./brain";
import { records } from "./carve";
import { commitPaths } from "./git";
import { clock } from "./clock";
import { OWNER } from "./owner";
import { appendDiary, diaryRow, shownValue } from "./diary";
import { logWrite } from "./write";
import { renderTouchedPages } from "./wiki";
import { lineState } from "./sources";

// unknownSender: a held record came from a mail whose sender no page holds (`sender: "unknown"`,
// never the address; src/sender.ts).
export interface Unseen { fact_key: string; page: string; title: string; attr: string; value: unknown; sensitivity: string; unknownSender: boolean }

const liveUnseen = (f: unknown): FactRecord[] => (f ? records(f as never).filter((r) => r.unseen && !r.valid_to && !r.retired) : []);

const unseenOf = (n: { fm: { id: string; title?: unknown; sensitivity: string } }, attr: string, f: unknown, recs: FactRecord[]): Unseen =>
  ({ fact_key: `${n.fm.id}#${attr}`, page: n.fm.id, title: String(n.fm.title ?? n.fm.id), attr, value: shownValue(f as never), sensitivity: recs.map((r) => r.sensitivity).find(Boolean) ?? n.fm.sensitivity, unknownSender: recs.some((r) => (r as { sender?: unknown }).sender === "unknown") });

// A held value that is only a stranger's claim (G883): every record of it that waits came from a
// sender no person page holds and nobody vouched for it since, so each is a guess (lineState,
// G868). One record from anyone else and the value waits like any held value.
const strangerGuess = (recs: FactRecord[]) => recs.length > 0 && recs.every((r) => (r as { sender?: unknown }).sender === "unknown" && lineState(r) === "guess");

function held(root: string, pick: "waits" | "guess"): Unseen[] {
  const out: Unseen[] = [];
  for (const n of loadBrain(root)) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    const recs = liveUnseen(f).filter((r) => !r.kept_private);
    if (recs.length && strangerGuess(recs) === (pick === "guess")) out.push(unseenOf(n, attr, f, recs));
  }
  return out;
}

// Every fact with a value that waits for the owner to see it. A value the owner read and kept
// private (keepPrivate) stays held from every agent but waits for nothing (G630), and so does a
// stranger's guess (heldGuesses): the home asks only on a conflict (owner's pick, 2026-11-15).
export const unseenFacts = (root: string): Unseen[] => held(root, "waits");

// The held values that are only a stranger's guess: held from every agent exactly as before
// (carve.ts reads `unseen`), waiting for nothing and counted nowhere. The home's full list shows
// them, each with Let them have it and Keep it private (markSeen, keepPrivate).
export const heldGuesses = (root: string): Unseen[] => held(root, "guess");

// shareWith: the only assistants the value goes to after Show (another person's health, school,
// legal or money matter is kept for the resolver alone, src/write.ts), [] for none; undefined: all
// the assistants whose views reach it (audit v11, G645: the home said "Your assistants get it now").
export function markSeen(root: string, factKey: string): { outcome: "seen" | "not_found" | "not_saved"; value?: unknown; shareWith?: string[]; message: string } {
  const hash = factKey.lastIndexOf("#");
  if (hash <= 0) return { outcome: "not_found", message: "nothing waiting to be seen there" };
  const id = factKey.slice(0, hash), attr = factKey.slice(hash + 1);
  const note = loadBrain(root).find((n) => n.fm.id === id);
  const recs = note && existsSync(join(root, note.path)) ? liveUnseen(note.fm.facts?.[attr]) : [];
  if (!note || !recs.length) return { outcome: "not_found", message: "nothing waiting to be seen there" };
  for (const r of recs) { delete r.unseen; delete r.kept_private; }
  const shares = recs.map((r) => r.share_with).filter((l): l is string[] => Array.isArray(l));
  const shareWith = shares.length ? shares.reduce((a, l) => a.filter((x) => l.includes(x))) : undefined;
  const d = today(), at = clock().toISOString();
  note.fm.updated = d;
  saveNote(root, note);
  const value = shownValue(note.fm.facts![attr]);
  const rel = appendDiary(root, diaryRow({ at, factKey, title: String(note.fm.title ?? id), kind: "seen", from: undefined, to: value, incoming: { ...recs[0]!, by: OWNER }, rank: 5, sensitivity: recs[0]!.sensitivity ?? note.fm.sensitivity }), d.slice(0, 7));
  const unsaved = commitPaths(root, [note.path, rel], `owner: seen ${factKey}\n\nWhy: the owner has seen it, so ${shareWith ? (shareWith.length ? `${shareWith.join(", ")} gets it now` : "it stays with the owner") : "their assistants get it now"}.\nKind: owner-seen\nFact-Keys: ${factKey}`, OWNER);
  if (unsaved) return { outcome: "not_saved", message: `not saved: ${unsaved}` };
  logWrite(root, { at, agent: OWNER, kind: "owner-seen", key: factKey, outcome: "committed" });
  try { renderTouchedPages(root, at); } catch { /* the night run writes it */ }
  return { outcome: "seen", value, ...(shareWith ? { shareWith } : {}), message: "Seen" };
}

// The values the owner read and kept private: still held, waiting for nothing. The home's full list
// (/home?all=1) shows them, uncounted, each with Let them have it, so keeping one is never final.
export function keptFacts(root: string): Unseen[] {
  const out: Unseen[] = [];
  for (const n of loadBrain(root)) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    const recs = liveUnseen(f);
    if (recs.length && recs.every((r) => r.kept_private)) out.push({ fact_key: `${n.fm.id}#${attr}`, page: n.fm.id, title: String(n.fm.title ?? n.fm.id), attr, value: shownValue(f), sensitivity: recs.map((r) => r.sensitivity).find(Boolean) ?? n.fm.sensitivity, unknownSender: recs.some((r) => (r as { sender?: unknown }).sender === "unknown") });
  }
  return out;
}

// Keep it private (owner's phone, 2026-11-02, G630: he read a held value and wanted it kept from
// his assistants). The value stays held from every agent (carve.ts reads `unseen`), and no longer
// waits on the home; the full list (keptFacts) and markSeen can still let it out. One owner commit.
export function keepPrivate(root: string, factKey: string): { outcome: "kept" | "not_found" | "not_saved"; message: string } {
  const hash = factKey.lastIndexOf("#");
  if (hash <= 0) return { outcome: "not_found", message: "nothing waiting there" };
  const id = factKey.slice(0, hash), attr = factKey.slice(hash + 1);
  const note = loadBrain(root).find((n) => n.fm.id === id);
  const recs = note && existsSync(join(root, note.path)) ? liveUnseen(note.fm.facts?.[attr]).filter((r) => !r.kept_private) : [];
  if (!note || !recs.length) return { outcome: "not_found", message: "nothing waiting there" };
  const d = today();
  for (const r of recs) r.kept_private = d;
  saveNote(root, note);
  const unsaved = commitPaths(root, [note.path], `owner: kept private ${factKey}\n\nWhy: the owner read it and keeps it from their assistants.\nKind: owner-kept-private\nFact-Keys: ${factKey}`, OWNER);
  if (unsaved) return { outcome: "not_saved", message: `not saved: ${unsaved}` };
  logWrite(root, { at: clock().toISOString(), agent: OWNER, kind: "owner-kept-private", key: factKey, outcome: "committed" });
  return { outcome: "kept", message: "Kept private" };
}
