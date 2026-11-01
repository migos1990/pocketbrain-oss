// SPDX-License-Identifier: AGPL-3.0-only
// Undo from the owner's diary (phone UI spec §5, owner 2026-10-26): a forward write, never git
// revert, so it still works after the night's page text or any later commit touched the file. It
// puts back the record the diary line replaced, with its own verification and sources, and moves the
// undone record to history as never right (`ended_by.correction`, by the owner). That record keeps
// its value, date and sources, so the same value from the same source is a repeat the write path
// ignores (write_hash) instead of landing again tomorrow. A fact changed since the line says so and
// is left alone. The undo is a diary line of its own (`undone`, `undoes: <token>`).
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadBrain, saveNote, parseNote, today, isList, isDisputed, type FactRecord } from "./brain";
import { compareKey } from "./normalize";
import { refString } from "./sources";
import { commitPaths, gitRun } from "./git";
import { clock } from "./clock";
import { OWNER } from "./owner";
import { readDiary, appendDiary, diaryRow, shownValue, type DiaryRow } from "./diary";
import { logWrite } from "./write";
import { renderTouchedPages, MADE } from "./wiki";
import type { Note } from "./brain";

export type UndoOutcome = "undone" | "changed_since" | "already_undone" | "not_found" | "not_undoable" | "not_saved";
export interface UndoResult { outcome: UndoOutcome; fact_key?: string; row?: DiaryRow; message: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function undoFact(root: string, token: string): UndoResult {
  const rows = readDiary(root);
  const row = rows.find((r) => r.undo_token === token && r.kind !== "undone");
  if (!row) return { outcome: "not_found", message: "nothing to undo for that line" };
  if (rows.some((r) => r.undoes === token)) return { outcome: "already_undone", fact_key: row.fact_key, row, message: "already undone" };
  if (row.kind === "conflict" || row.to === undefined && row.kind !== "retracted") return { outcome: "not_undoable", fact_key: row.fact_key, row, message: "this line has nothing to undo" };
  if (row.kind === "settled") return reopen(root, row, token);
  const hash = row.fact_key.lastIndexOf("#");
  const id = row.fact_key.slice(0, hash), attr = row.fact_key.slice(hash + 1);
  const note = loadBrain(root).find((n) => n.fm.id === id);
  if (!note || !existsSync(join(root, note.path))) return { outcome: "changed_since", fact_key: row.fact_key, row, message: "Changed since" };
  const facts = (note.fm.facts ??= {}), hist = (note.fm.history ??= {});
  const live = facts[attr];
  if (live && isDisputed(live)) return { outcome: "changed_since", fact_key: row.fact_key, row, message: "Changed since" };
  const d = today(), at = clock().toISOString();
  const ended = { step: 0, at: d, by: OWNER, correction: true };
  const changed = (): UndoResult => ({ outcome: "changed_since", fact_key: row.fact_key, row, message: "Changed since" });
  // The record the line replaced: the newest ended one holding the line's earlier value.
  const replaced = (value: unknown) => {
    const hs = hist[attr] ?? [];
    for (let i = hs.length - 1; i >= 0; i--) if (!hs[i]!.retired && !hs[i]!.ended_by?.correction && compareKey(hs[i]!.value) === compareKey(value)) return i;
    return -1;
  };
  const restore = (i: number): FactRecord => {
    const [rec] = hist[attr]!.splice(i, 1);
    const { valid_to: _v, ended_by: _e, ...back } = rec!;
    if (!hist[attr]!.length) delete hist[attr];
    return back as FactRecord;
  };

  if (row.kind === "item_added") {
    if (!live || !isList(live)) return changed();
    const it = live.items.find((i) => !i.valid_to && compareKey(i.value) === compareKey(row.to));
    if (!it) return changed();
    it.valid_to = d; it.ended_by = ended;
  } else if (row.kind === "confirmed") {
    // The hub filed a value the page held: Undo takes out the sources that filing added (G524).
    if (!row.added?.length) return { outcome: "not_undoable", fact_key: row.fact_key, row, message: "this line has nothing to undo" };
    if (!live || isList(live) || !same(shownValue(live), row.to)) return changed();
    const cur = live as FactRecord;
    const left = (cur.sources ?? []).filter((x) => !row.added!.includes(refString(x)));
    if (left.length === (cur.sources ?? []).length || !left.length) return changed();
    cur.sources = left;
  } else if (row.kind === "retracted") {
    if (live) return changed();
    const i = replaced(row.from);
    if (i < 0) return changed();
    facts[attr] = restore(i);
  } else {
    if (!live || isList(live) || !same(shownValue(live), row.to)) return changed();
    const cur = live as FactRecord;
    const i = row.kind === "changed" ? replaced(row.from) : -1;
    if (row.kind === "changed" && i < 0) return changed();
    (hist[attr] ??= []).push({ ...cur, valid_to: d, ended_by: ended });
    if (i >= 0) facts[attr] = restore(i); else delete facts[attr];
  }
  if (note.fm.history && !Object.keys(note.fm.history).length) delete note.fm.history;
  note.fm.updated = d;
  // A page whose every fact the owner has now undone, with no words but the hub's and nothing
  // linking to it (one just started from the box), goes with its last fact: an empty page would
  // still carry the hub's text about the value just undone (use-it check, 2026-10-27).
  const gone = emptied(root, note);
  if (gone) rmSync(join(root, note.path)); else saveNote(root, note);
  const back = shownValue(facts[attr]);
  const undo = { ...diaryRow({ at, factKey: row.fact_key, title: row.title, kind: "undone", from: row.to, to: back, incoming: { value: back, as_of: d, sources: [], verification: "confirmed-by-owner", by: OWNER, recorded: d }, rank: 5, sensitivity: row.sensitivity }), undoes: token };
  const rel = appendDiary(root, undo, d.slice(0, 7));
  const unsaved = commitPaths(root, [note.path, rel], `owner: undo ${row.fact_key}\n\nWhy: the owner undid "${row.kind}" from ${row.at.slice(0, 10)}; ${gone ? "it was the page's only fact, so the page goes too" : "the value before it is back, and the undone one is kept in history as never right"}.\nKind: owner-edit\nFact-Keys: ${row.fact_key}`, OWNER);
  if (unsaved) return { outcome: "not_saved", fact_key: row.fact_key, row, message: `not saved: ${unsaved}` };
  logWrite(root, { at, agent: OWNER, kind: "owner-edit", op: "undo", key: row.fact_key, outcome: "committed" });
  // The page's text follows its facts (the page writer, its own hub commit).
  try { renderTouchedPages(root, at); } catch { /* the night run writes it */ }
  return { outcome: "undone", fact_key: row.fact_key, row, message: "Undone" };
}

function emptied(root: string, note: Note): boolean {
  if (Object.keys(note.fm.facts ?? {}).length) return false;
  if (!Object.values(note.fm.history ?? {}).flat().every((r) => (r as FactRecord).ended_by?.correction)) return false;
  // The writer's own text is no one's words: the made-by paragraph and the opening it follows (G559).
  const paras = note.body.split(/\n\s*\n/);
  const words = paras.filter((p, i) => !p.includes(MADE) && paras[i + 1]?.trim() !== MADE).join("\n").split("\n").filter((l) => !/^\[\^[^\]]+\]:/.test(l)).join("").trim();
  if (words) return false;
  return !loadBrain(root).some((n) => n.fm.id !== note.fm.id && JSON.stringify([n.fm, n.body]).includes(note.fm.id));
}

// Undo of a settled conflict opens it again (spec §5: the inverse write of the settle). The fact and
// its history, and the conflict, go back to how they stood just before the answer, read from the
// answer's own commit; nothing else on the page moves. Only while the answer is still the live value
// and the conflict is still answered.
function reopen(root: string, row: DiaryRow, token: string): UndoResult {
  const changed: UndoResult = { outcome: "changed_since", fact_key: row.fact_key, row, message: "Changed since" };
  const hash = row.fact_key.lastIndexOf("#");
  const id = row.fact_key.slice(0, hash), attr = row.fact_key.slice(hash + 1);
  const rel = `disputes/${row.settles}.md`;
  const note = loadBrain(root).find((n) => n.fm.id === id);
  if (!note || !row.settles || !existsSync(join(root, rel))) return changed;
  if (!same(shownValue(note.fm.facts?.[attr]), row.to)) return changed;
  const packet = parseNote(readFileSync(join(root, rel), "utf8"), rel);
  if (packet.fm.status !== "resolved") return changed;
  // Any month's file: the row sits in the owner's day's month, which isn't the UTC month of
  // row.at for a few hours at each month boundary (main's CI, 2026-11-01).
  const sha = gitRun(root, ["log", "-1", "--format=%H", `-S${token}`, "--", "diary/"]).out.trim();
  if (!sha) return changed;
  const show = (path: string) => { const r = gitRun(root, ["show", `${sha}^:${path}`]); return r.ok ? r.out : undefined; };
  const oldNote = show(note.path), oldPacket = show(rel);
  if (oldNote === undefined || oldPacket === undefined) return changed;
  const was = parseNote(oldNote, note.path);
  const facts = (note.fm.facts ??= {}), hist = (note.fm.history ??= {});
  if (was.fm.facts?.[attr] !== undefined) facts[attr] = was.fm.facts[attr]; else delete facts[attr];
  if (was.fm.history?.[attr]) hist[attr] = was.fm.history[attr]; else delete hist[attr];
  if (!Object.keys(hist).length) delete note.fm.history;
  const d = today(), at = clock().toISOString();
  note.fm.updated = d;
  saveNote(root, note);
  writeFileSync(join(root, rel), `${oldPacket}\n`);
  const back = shownValue(facts[attr]);
  const undo = { ...diaryRow({ at, factKey: row.fact_key, title: row.title, kind: "undone", from: row.to, to: back, incoming: { value: back, as_of: d, sources: [], verification: "confirmed-by-owner", by: OWNER, recorded: d }, rank: 5, sensitivity: row.sensitivity }), undoes: token };
  const diary = appendDiary(root, undo, d.slice(0, 7));
  const unsaved = commitPaths(root, [note.path, rel, diary], `owner: undo the answer to ${row.settles}\n\nWhy: the owner undid their answer from ${row.at.slice(0, 10)}; the conflict is open again with its sides as they were.\nKind: owner-edit\nFact-Keys: ${row.fact_key}`, OWNER);
  if (unsaved) return { outcome: "not_saved", fact_key: row.fact_key, row, message: `not saved: ${unsaved}` };
  logWrite(root, { at, agent: OWNER, kind: "owner-edit", op: "undo", key: row.fact_key, outcome: "committed", dispute: row.settles });
  try { renderTouchedPages(root, at); } catch { /* the night run writes it */ }
  return { outcome: "undone", fact_key: row.fact_key, row, message: "Undone" };
}
