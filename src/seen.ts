// SPDX-License-Identifier: AGPL-3.0-only
// The owner has seen it (phone UI spec §7, owner 2026-10-26): an assistant's private, money-,
// health- or legal-shaped value is held from every agent (`unseen`, set by write(), hidden by carve.ts
// factHiddenReason) until the owner taps Show on the home. This takes the mark off the fact's live
// records in one owner commit, adds a `seen` diary row, and has the page writer say it at once.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadBrain, saveNote, today, isList, type FactRecord } from "./brain";
import { records } from "./carve";
import { commitPaths } from "./git";
import { clock } from "./clock";
import { OWNER, approvedRef } from "./owner";
import { sha256 } from "./util";
import { refString } from "./sources";
import { appendDiary, diaryRow, shownValue } from "./diary";
import { logWrite } from "./write";
import { pageTextSoon } from "./wiki";
import { lineState } from "./sources";

// unknownSender: a held record came from a mail whose sender no page holds (`sender: "unknown"`,
// never the address; src/sender.ts).
export interface Unseen { fact_key: string; page: string; title: string; attr: string; value: unknown; sensitivity: string; unknownSender: boolean; yours?: boolean }

const liveUnseen = (f: unknown): FactRecord[] => (f ? records(f as never).filter((r) => r.unseen && !r.valid_to && !r.retired) : []);

const unseenOf = (n: { fm: { id: string; title?: unknown; sensitivity: string } }, attr: string, f: unknown, recs: FactRecord[]): Unseen =>
  ({ fact_key: `${n.fm.id}#${attr}`, page: n.fm.id, title: String(n.fm.title ?? n.fm.id), attr, value: shownValue(f as never), sensitivity: recs.map((r) => r.sensitivity).find(Boolean) ?? n.fm.sensitivity, unknownSender: recs.some((r) => (r as { sender?: unknown }).sender === "unknown") });

// A held value that is only a stranger's claim (G883): every record of it that waits came from a
// sender no person page holds and nobody vouched for it since, so each is a guess (lineState,
// G868). One record from anyone else and the value waits like any held value.
const strangerGuess = (recs: FactRecord[]) => recs.length > 0 && recs.every((r) => (r as { sender?: unknown }).sender === "unknown" && lineState(r) === "guess");

function held(root: string, pick: "waits" | "guess"): Unseen[] {
  const out: Unseen[] = [];
  for (const n of loadBrain(root, { shared: true })) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
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

// What the owner read on a held card, bound to its bytes: It's right keeps only a value that is
// still the one the card showed (as Keep binds a proposal's bytes, src/keep-guess.ts).
export const heldSeen = (u: Pick<Unseen, "fact_key" | "value">) => sha256(`${u.fact_key}\n${JSON.stringify(u.value ?? null)}`).slice(0, 16);

// It's right (G945): the owner read a stranger's held guess and says it is right. The value gets an
// approved: ref, so it is his (sources.ts lineState "yours") and ranks as the mail it came from,
// never as his own typed word (owner's choice 2026-10-25: a tap is an approval). The hold is left as
// it is: still `unseen`, so no assistant gets it, and kept private, so it waits for nothing and is
// listed with what he keeps to himself, where Let them have it (markSeen) is the separate step that
// lets it out. Only a value that is a held guess now, and only the bytes he read. One owner commit,
// a `confirmed` diary row per fact whose Undo takes the ref and the kept mark back out (undo.ts).
export function confirmHeld(root: string, picks: { key: string; seen: string }[]): { confirmed: number; message: string } {
  const open = new Map(heldGuesses(root).map((u) => [u.fact_key, heldSeen(u)]));
  const want = picks.slice(0, 50).filter((p) => open.get(p.key) === p.seen);
  if (!want.length) return { confirmed: 0, message: "Nothing to confirm there any more." };
  const notes = loadBrain(root), d = today(), at = clock().toISOString(), ref = approvedRef(d, "held");
  const paths = new Set<string>(), rows: string[] = [], keys: string[] = [];
  for (const p of want) {
    const hash = p.key.lastIndexOf("#");
    const note = notes.find((n) => n.fm.id === p.key.slice(0, hash));
    const attr = p.key.slice(hash + 1), f = note?.fm.facts?.[attr];
    // A single value only, as Not right: its Undo puts back one record (undo.ts).
    const recs = isList(f) ? [] : liveUnseen(f).filter((r) => !r.kept_private);
    // Checked again on the copy it changes, bytes included: a write between the two loads keeps nothing.
    if (!note || !recs.length || !existsSync(join(root, note.path)) || heldSeen({ fact_key: p.key, value: shownValue(f) }) !== p.seen) continue;
    for (const r of recs) {
      if (!(r.sources ?? []).some((x) => refString(x) === ref)) r.sources = [...(r.sources ?? []), ref];
      r.kept_private = d;
    }
    note.fm.updated = d;
    saveNote(root, note);
    paths.add(note.path);
    rows.push(appendDiary(root, { ...diaryRow({ at, factKey: p.key, title: String(note.fm.title ?? note.fm.id), kind: "confirmed", from: undefined, to: shownValue(f), incoming: { ...recs[0]!, by: OWNER }, acceptedBy: OWNER, rank: 5, sensitivity: recs[0]!.sensitivity ?? note.fm.sensitivity }), added: [ref], held_right: true }, d.slice(0, 7)));
    keys.push(p.key);
  }
  if (!keys.length) return { confirmed: 0, message: "Nothing to confirm there any more." };
  const unsaved = commitPaths(root, [...paths, ...new Set(rows)], `owner: it's right ${keys.join(", ")}\n\nWhy: the owner read it and says it is right; it stays held from their assistants.\nKind: owner-confirmed-held\nFact-Keys: ${keys.join(", ")}`, OWNER);
  if (unsaved) return { confirmed: 0, message: `not saved: ${unsaved}` };
  for (const k of keys) logWrite(root, { at, agent: OWNER, kind: "owner-confirmed-held", key: k, outcome: "committed" });
  return { confirmed: keys.length, message: keys.length === 1 ? "It's yours now. Only you see it until you let them have it." : `${keys.length} are yours now. Only you see them until you let them have them.` };
}

// Not right (G946): the owner read a stranger's held guess and it is wrong, or he doesn't want it.
// It leaves the list and his memory, and nothing is deleted: the record goes to history as never
// right (ended_by.correction, by the owner), so the same mail can't file it again, and a `retracted`
// diary row (why "not-right") whose Undo puts it back as the held guess it was (undo.ts). Only a
// value that is a held guess now, and only the bytes he read; a single value, never a list's item.
export function notRightHeld(root: string, picks: { key: string; seen: string }[]): { dropped: number; message: string } {
  const open = new Map(heldGuesses(root).map((u) => [u.fact_key, heldSeen(u)]));
  const want = picks.slice(0, 50).filter((p) => open.get(p.key) === p.seen);
  const none = { dropped: 0, message: "Nothing to take out there any more." };
  if (!want.length) return none;
  const notes = loadBrain(root), d = today(), at = clock().toISOString();
  const paths = new Set<string>(), rows: string[] = [], keys: string[] = [];
  for (const p of want) {
    const hash = p.key.lastIndexOf("#");
    const note = notes.find((n) => n.fm.id === p.key.slice(0, hash));
    const attr = p.key.slice(hash + 1), f = note?.fm.facts?.[attr] as FactRecord | undefined;
    if (!note || !f || isList(f) || !liveUnseen(f).length || !existsSync(join(root, note.path)) || heldSeen({ fact_key: p.key, value: shownValue(f) }) !== p.seen) continue;
    ((note.fm.history ??= {})[attr] ??= []).push({ ...f, valid_to: d, ended_by: { step: 0, at: d, by: OWNER, correction: true } });
    delete note.fm.facts![attr];
    note.fm.updated = d;
    saveNote(root, note);
    paths.add(note.path);
    rows.push(appendDiary(root, { ...diaryRow({ at, factKey: p.key, title: String(note.fm.title ?? note.fm.id), kind: "retracted", from: shownValue(f), to: undefined, incoming: { ...f, by: OWNER }, acceptedBy: OWNER, rank: 5, sensitivity: f.sensitivity ?? note.fm.sensitivity }), why: "not-right" }, d.slice(0, 7)));
    keys.push(p.key);
  }
  if (!keys.length) return none;
  const unsaved = commitPaths(root, [...paths, ...new Set(rows)], `owner: not right ${keys.join(", ")}\n\nWhy: the owner read it and it is not right; kept in history as never right, so the same source can't file it again.\nKind: owner-not-right\nFact-Keys: ${keys.join(", ")}`, OWNER);
  if (unsaved) return { dropped: 0, message: `not saved: ${unsaved}` };
  for (const k of keys) logWrite(root, { at, agent: OWNER, kind: "owner-not-right", key: k, outcome: "committed" });
  return { dropped: keys.length, message: keys.length === 1 ? "Taken out. Nothing was deleted, and Undo puts it back." : `${keys.length} taken out. Nothing was deleted, and Undo puts them back.` };
}

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
  try { pageTextSoon(root, at); } catch { /* the night run writes it */ }
  return { outcome: "seen", value, ...(shareWith ? { shareWith } : {}), message: "Seen" };
}

// The values the owner read and kept private: still held, waiting for nothing. The home's full list
// (/home?all=1) shows them, uncounted, each with Let them have it, so keeping one is never final.
export function keptFacts(root: string): Unseen[] {
  const out: Unseen[] = [];
  for (const n of loadBrain(root, { shared: true })) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
    const recs = liveUnseen(f);
    if (recs.length && recs.every((r) => r.kept_private)) out.push({ fact_key: `${n.fm.id}#${attr}`, page: n.fm.id, title: String(n.fm.title ?? n.fm.id), attr, value: shownValue(f), sensitivity: recs.map((r) => r.sensitivity).find(Boolean) ?? n.fm.sensitivity, unknownSender: recs.some((r) => (r as { sender?: unknown }).sender === "unknown"), ...(recs.every((r) => lineState(r) === "yours") ? { yours: true } : {}) });
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
