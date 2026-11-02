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

// unknownSender: a held record came from a mail whose sender no page holds (`sender: "unknown"`,
// never the address; src/sender.ts).
export interface Unseen { fact_key: string; page: string; title: string; attr: string; value: unknown; sensitivity: string; unknownSender: boolean }

const liveUnseen = (f: unknown): FactRecord[] => (f ? records(f as never).filter((r) => r.unseen && !r.valid_to && !r.retired) : []);

// Every fact with a value the owner hasn't seen yet. A value the owner read and kept private
// (keepPrivate) stays held from every agent but waits for nothing (G630).
export function unseenFacts(root: string): Unseen[] {
  const out: Unseen[] = [];
  for (const n of loadBrain(root)) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    const recs = liveUnseen(f).filter((r) => !r.kept_private);
    if (recs.length) out.push({ fact_key: `${n.fm.id}#${attr}`, page: n.fm.id, title: String(n.fm.title ?? n.fm.id), attr, value: shownValue(f), sensitivity: recs.map((r) => r.sensitivity).find(Boolean) ?? n.fm.sensitivity, unknownSender: recs.some((r) => (r as { sender?: unknown }).sender === "unknown") });
  }
  return out;
}

export function markSeen(root: string, factKey: string): { outcome: "seen" | "not_found" | "not_saved"; value?: unknown; message: string } {
  const hash = factKey.lastIndexOf("#");
  if (hash <= 0) return { outcome: "not_found", message: "nothing waiting to be seen there" };
  const id = factKey.slice(0, hash), attr = factKey.slice(hash + 1);
  const note = loadBrain(root).find((n) => n.fm.id === id);
  const recs = note && existsSync(join(root, note.path)) ? liveUnseen(note.fm.facts?.[attr]) : [];
  if (!note || !recs.length) return { outcome: "not_found", message: "nothing waiting to be seen there" };
  for (const r of recs) { delete r.unseen; delete r.kept_private; }
  const d = today(), at = clock().toISOString();
  note.fm.updated = d;
  saveNote(root, note);
  const value = shownValue(note.fm.facts![attr]);
  const rel = appendDiary(root, diaryRow({ at, factKey, title: String(note.fm.title ?? id), kind: "seen", from: undefined, to: value, incoming: { ...recs[0]!, by: OWNER }, rank: 5, sensitivity: recs[0]!.sensitivity ?? note.fm.sensitivity }), d.slice(0, 7));
  const unsaved = commitPaths(root, [note.path, rel], `owner: seen ${factKey}\n\nWhy: the owner has seen it, so their assistants get it now.\nKind: owner-seen\nFact-Keys: ${factKey}`, OWNER);
  if (unsaved) return { outcome: "not_saved", message: `not saved: ${unsaved}` };
  logWrite(root, { at, agent: OWNER, kind: "owner-seen", key: factKey, outcome: "committed" });
  try { renderTouchedPages(root, at); } catch { /* the night run writes it */ }
  return { outcome: "seen", value, message: "Seen" };
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
