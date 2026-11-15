// SPDX-License-Identifier: AGPL-3.0-only
// Held facts that came only from machine mail (receipts, no-reply and bulk senders), set aside on the
// owner's switch. There was a second, always-on step here for "receipt pages" (the owner's phone,
// 2026-10-29; G511): first a word in the page's title decided, which set aside a landlord's own mail
// titled "Billing dispute" (G862). What a page is called decides nothing, and what is left of that
// rule without the title is this file's one rule, so the step is gone and the owner's switch
// (`pocketbrain machine-mail on`) governs every set-aside. Its old diary lines (why "receipt") still
// undo, and a page or fact whose set-aside the owner undid is never set aside again (G537, G867).
import { loadBrain, saveNote, today, isList, isDisputed, type Note, type FactRecord } from "./brain";
import { refString } from "./sources";
import { appendDiary, diaryRow, readDiary, shownValue, type DiaryRow } from "./diary";
import { commitPaths } from "./git";
import { clock, ownerDay } from "./clock";
import { loadRules } from "./rules";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { machineMail, mailKey } from "./louis";
import { isOwnerId, isOwnerConfirmed } from "./owner";
import { isExactLouisRef } from "./sources";
import { noOwnWords } from "./undo";

const live = (r: FactRecord) => !r.valid_to && !r.retired;

// What was set aside once, from the diary: a fact by its key (why "machine"), a whole page by its id
// (why "receipt", the old step). Either is left alone from then on, so the owner's Undo holds.
export function setAsideBefore(rows: DiaryRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.why === "machine") out.add(r.fact_key);
    else if (r.why === "receipt") out.add(r.fact_key.slice(0, r.fact_key.lastIndexOf("#")));
  }
  return out;
}

// Facts an assistant filed from machine mail (owner's phone, 2026-11-03: a ride receipt became an
// org page with two held rows and nothing else; G668). Machine mail is never read for facts: write()
// refuses it now, and these are the ones filed before. A record qualifies when it is live, still
// held (`unseen`: no assistant has it, the owner never let it out), written by someone other than the
// owner with no owner's word on it, and every source is mail the hub saw was machine-sent
// (src/louis.ts machineMail). Each goes to history with a diary line (why "machine") whose Undo brings
// it back held as it was. A page left with nothing live, no one's words but the hub's and no page
// naming it goes too, in the same commit; Undo brings it back from that commit.
// Off until the owner says (`pocketbrain machine-mail on`, policy.yaml machine_mail.set_aside): then
// upkeep only counts them. `done` (setAsideBefore) is what was set aside once: never again.
export interface MachineFact { id: string; attr: string }
export function machineFacts(notes: Note[], machine: ReadonlySet<string>, done: ReadonlySet<string> = new Set()): MachineFact[] {
  if (!machine.size) return [];
  const out: MachineFact[] = [];
  for (const n of notes) {
    if (done.has(n.fm.id) || n.fm.type === "dispute" || ["archived", "merged", "superseded"].includes(String(n.fm.status ?? ""))) continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (isDisputed(f) || isList(f)) continue;
      const r = f as FactRecord;
      const keys = (r.sources ?? []).map((x) => mailKey(refString(x)));
      if (!done.has(`${n.fm.id}#${attr}`) && live(r) && r.unseen && !isOwnerId(r.by) && !isOwnerConfirmed(r.verification) && !(r.sources ?? []).some((x) => isExactLouisRef(refString(x)))
        && keys.length > 0 && keys.every((k) => !!k && machine.has(k))) out.push({ id: n.fm.id, attr });
    }
  }
  return out;
}

export function setAsideMachineMail(root: string, apply: boolean): { facts: number; pages: number; removed: string[] } {
  const notes = loadBrain(root);
  const found = machineFacts(notes, machineMail(root), setAsideBefore(readDiary(root)));
  const ids = new Set(found.map((f) => f.id));
  if (!apply || !found.length) return { facts: found.length, pages: ids.size, removed: [] };
  const rules = loadRules(root), at = clock().toISOString(), d = today(), month = ownerDay(rules, clock()).slice(0, 7);
  const paths: string[] = [], removed: string[] = [];
  let rel = "";
  for (const n of notes.filter((x) => ids.has(x.fm.id))) {
    const facts = n.fm.facts ?? {}, hist = (n.fm.history ??= {});
    for (const { attr } of found.filter((f) => f.id === n.fm.id)) {
      const rec = facts[attr] as FactRecord;
      (hist[attr] ??= []).push({ ...rec, valid_to: d, ended_by: { step: 0, at: d, by: "hub" } });
      delete facts[attr];
      rel = appendDiary(root, { ...diaryRow({ at, factKey: `${n.fm.id}#${attr}`, title: String(n.fm.title ?? n.fm.id), kind: "retracted", from: shownValue(rec), to: undefined, incoming: rec, acceptedBy: "hub", rank: 9, sensitivity: rec.sensitivity ?? n.fm.sensitivity }), why: "machine" }, month);
    }
    n.fm.updated = d;
    paths.push(n.path);
    const nothingLive = !Object.values(facts).some((f) => isDisputed(f) || (isList(f) ? f.items.some(live) : live(f as FactRecord)));
    if (nothingLive && !isOwnerId(n.fm.by) && n.fm.type !== "person" && noOwnWords(root, n, notes)) { rmSync(join(root, n.path)); removed.push(n.fm.id); }
    else saveNote(root, n);
  }
  commitPaths(root, [...paths, rel], `hub: set aside ${found.length} fact${found.length === 1 ? "" : "s"} filed from machine mail\n\nWhy: an assistant filed ${found.length === 1 ? "it" : "them"} from mail a machine sent (a no-reply, list or billing sender), still held for the owner and never seen; machine mail is never read for facts (G668). Each has a diary line with Undo.${removed.length ? ` ${removed.length} page${removed.length === 1 ? "" : "s"} left with nothing on ${removed.length === 1 ? "it goes" : "them go"} too; Undo brings ${removed.length === 1 ? "it" : "them"} back.` : ""}\nKind: machine-mail`, "hub");
  return { facts: found.length, pages: ids.size, removed };
}
