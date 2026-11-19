// SPDX-License-Identifier: AGPL-3.0-only
// A value the memory still holds that has the shape of a secret (a redeemable code, a password, a
// card number: filed before the write check knew the shape, G961, or put in by hand). No assistant
// is served it (G962, `secretShaped` in src/carve.ts) and the owner's screens show its characters as
// a mark (G991), but the record itself stayed live. This is the night step that sets it aside: a
// live record that is not the owner's own word, alone, one of several on a list, or one side of an
// open question with two sides, which closes as its other side. Each goes to history with a diary
// line (why "secret") whose Undo brings it back as it was; what the owner brought back is never
// taken again. A page is never removed by this step.
// Off until the owner says (`pocketbrain saved-codes on`, policy.yaml saved_codes.set_aside): until
// then upkeep only counts them, and nothing on a page, the home or a question changes.
import { loadBrain, saveNote, today, isList, isDisputed, type Note, type FactRecord } from "./brain";
import { refString, isExactLouisRef } from "./sources";
import { appendDiary, diaryRow, readDiary, shownValue, type DiaryRow } from "./diary";
import { commitPaths } from "./git";
import { clock, ownerDay } from "./clock";
import { loadRules, type Rules } from "./rules";
import { isOwnerId, isOwnerConfirmed } from "./owner";
import { secretShaped } from "./carve";
import { compareKey } from "./normalize";
import { setAsideSide } from "./core";

const live = (r: FactRecord) => !r.valid_to && !r.retired;
const ownerWord = (r: FactRecord) => isOwnerId(r.by) || isOwnerConfirmed(r.verification) || (r.sources ?? []).some((x) => isExactLouisRef(refString(x)));
const takes = (r: FactRecord) => live(r) && !ownerWord(r) && secretShaped(r);

export const savedCodesOn = (rules: Rules) => (rules.policy as { saved_codes?: { set_aside?: boolean } }).saved_codes?.set_aside === true;

// What the owner brought back with Undo is never taken again: a value by its fact and the value
// itself (`key value`), a question by its fact alone. Another code that later stands on the same
// fact is still this step's (code review of PR 240).
const valueKey = (key: string, v: unknown) => `${key} ${compareKey(v)}`;
function doneBefore(rows: DiaryRow[]): Set<string> {
  const undone = new Set(rows.map((r) => r.undoes).filter(Boolean));
  const out = new Set<string>();
  for (const r of rows) if (r.why === "secret" && undone.has(r.undo_token)) out.add(r.kind === "settled" ? r.fact_key : valueKey(r.fact_key, r.from));
  return out;
}

// item: the value of one list item; packet/keep: an open question and the side that stays.
export interface KeptSecret { id: string; attr: string; item?: unknown; packet?: string; keep?: number }
export function keptSecrets(notes: Note[], done: ReadonlySet<string> = new Set()): KeptSecret[] {
  const out: KeptSecret[] = [];
  const gone = (n: Note) => ["archived", "merged", "superseded"].includes(String(n.fm.status ?? ""));
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  // An open question on one fact with two sides, one of them secret-shaped: the other side stays.
  // Both: the first stays for now, and is set aside as a plain fact in the same run.
  for (const p of notes) {
    if (p.fm.type !== "dispute" || !["open", "escalated"].includes(String(p.fm.status)) || (p.fm as { other_key?: string }).other_key) continue;
    const key = String(p.fm.fact_key ?? ""), hash = key.lastIndexOf("#");
    const page = byId.get(key.slice(0, hash)), cands = (p.fm as { candidates?: FactRecord[] }).candidates ?? [];
    if (!page || gone(page) || done.has(key) || cands.length !== 2) continue;
    const m = cands.map((c) => !ownerWord(c) && secretShaped(c));
    if (!m[0] && !m[1]) continue;
    out.push({ id: page.fm.id, attr: key.slice(hash + 1), packet: String(p.fm.id).replace(/^disputes\//, ""), keep: m[0] && !m[1] ? 1 : 0 });
  }
  const asked = new Set(out.map((f) => `${f.id}#${f.attr}`));
  for (const n of notes) {
    if (n.fm.type === "dispute" || gone(n)) continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      const key = `${n.fm.id}#${attr}`;
      if (isDisputed(f) || asked.has(key)) continue;
      if (isList(f)) { for (const i of f.items) if (!i.contested && takes(i) && !done.has(valueKey(key, i.value))) out.push({ id: n.fm.id, attr, item: i.value }); continue; }
      const r = f as FactRecord;
      if (!r.contested && takes(r) && !done.has(valueKey(key, shownValue(r)))) out.push({ id: n.fm.id, attr });
    }
  }
  return out;
}

// Counts only: no value, page name or id leaves this function.
export function setAsideKeptSecrets(root: string, apply: boolean): { facts: number; pages: number } {
  const done = doneBefore(readDiary(root));
  const first = keptSecrets(loadBrain(root), done);
  if (!apply || !first.length) return { facts: first.length, pages: new Set(first.map((f) => f.id)).size };
  // Questions first, each its own commit with a line whose Undo opens it again; then the plain
  // facts and list items as they stand after that, in one commit.
  let n = 0;
  const touched = new Set<string>();
  for (const f of first) if (f.packet && setAsideSide(root, f.packet, f.keep!, { kind: "saved-code", why: "secret", reason: "the other side held a code or password" })) { n++; touched.add(f.id); }
  const notes = loadBrain(root);
  const found = keptSecrets(notes, done).filter((f) => !f.packet);
  if (!found.length) return { facts: n, pages: touched.size };
  const ids = new Set(found.map((f) => f.id));
  const rules = loadRules(root), at = clock().toISOString(), d = today(), month = ownerDay(rules, clock()).slice(0, 7);
  const paths: string[] = [];
  let rel = "";
  for (const note of notes.filter((x) => ids.has(x.fm.id))) {
    touched.add(note.fm.id);
    const facts = note.fm.facts ?? {}, hist = (note.fm.history ??= {});
    for (const { attr, item } of found.filter((f) => f.id === note.fm.id)) {
      const f = facts[attr]!;
      let rec: FactRecord;
      if (isList(f)) {
        rec = f.items.find((i) => live(i) && compareKey(i.value) === compareKey(item))!;
        Object.assign(rec, { valid_to: d, ended_by: { step: 0, at: d, by: "hub" } });
      } else {
        rec = f as FactRecord;
        (hist[attr] ??= []).push({ ...rec, valid_to: d, ended_by: { step: 0, at: d, by: "hub" } });
        delete facts[attr];
      }
      const { valid_to: _v, ended_by: _e, ...was } = rec;
      rel = appendDiary(root, { ...diaryRow({ at, factKey: `${note.fm.id}#${attr}`, title: String(note.fm.title ?? note.fm.id), kind: "retracted", from: isList(f) ? was.value : shownValue(was as FactRecord), to: undefined, incoming: was as FactRecord, acceptedBy: "hub", rank: 9, sensitivity: rec.sensitivity ?? note.fm.sensitivity }), why: "secret" }, month);
    }
    if (!Object.keys(hist).length) delete note.fm.history;
    note.fm.updated = d;
    paths.push(note.path);
    saveNote(root, note);
  }
  commitPaths(root, [...paths, rel], `hub: set aside ${found.length} saved value${found.length === 1 ? "" : "s"} that held a code or password\n\nWhy: a code or password is never kept as a memory (G961, G991). Each has a diary line with Undo.\nKind: saved-code`, "hub");
  return { facts: n + found.length, pages: touched.size };
}
