// SPDX-License-Identifier: AGPL-3.0-only
// Receipts that became held pages (the owner's phone, 2026-10-29: Apple order and Apple Services
// payment rows filled Waiting on you). Since G506 a no-reply sender's mail is never read; the pages
// it made before stay held for the owner's Show. The owner left them to us ("i trust u"): upkeep
// sets each such page's held facts aside, once, as a take-back with a diary line and Undo
// (src/undo.ts restores the record, held as it was). Only a page whose title reads like a receipt
// and whose every live fact is still held from an unknown sender; nothing else is touched.
// A receipt is a money page whose every live fact came from mail, never a person's page, whatever
// its name ("Bill Harper"), and a page set aside once is never set aside again: its Undo holds
// (audit v6, 2026-10-30; G537).
import { loadBrain, saveNote, today, isList, isDisputed, type Note, type FactRecord } from "./brain";
import { records } from "./carve";
import { refString } from "./sources";
import { appendDiary, diaryRow, readDiary, shownValue } from "./diary";
import { commitPaths } from "./git";
import { clock, ownerDay } from "./clock";
import { loadRules } from "./rules";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { machineMail, mailKey } from "./louis";
import { isOwnerId, isOwnerConfirmed } from "./owner";
import { isExactLouisRef } from "./sources";
import { noOwnWords } from "./undo";

const RECEIPT = /\b(?:order|payment|invoice|receipt|billing|bill|subscription|purchase)\b/i;
const live = (r: FactRecord) => !r.valid_to && !r.retired;

const fromMail = (r: FactRecord) => (r.sources ?? []).length > 0 && (r.sources ?? []).every((x) => /^(?:gmail|mail):/.test(refString(x)));

// `done`: pages upkeep already set aside once (their diary lines), left alone from then on.
export function receiptPages(notes: Note[], done: ReadonlySet<string> = new Set()): string[] {
  return notes.filter((n) => {
    if (n.fm.type !== "money" || done.has(n.fm.id) || !RECEIPT.test(String(n.fm.title ?? "")) || n.fm.status === "archived") return false;
    const recs = Object.values(n.fm.facts ?? {}).flatMap((f) => (isDisputed(f) ? [] : records(f))).filter(live);
    return recs.length > 0 && recs.every((r) => r.unseen && r.sender === "unknown" && fromMail(r));
  }).map((n) => n.fm.id);
}

// Sets them aside; returns the pages. One hub commit with a why.
export function setAsideReceipts(root: string): string[] {
  const notes = loadBrain(root);
  const done = new Set(readDiary(root).filter((r) => r.why === "receipt").map((r) => r.fact_key.slice(0, r.fact_key.lastIndexOf("#"))));
  const ids = new Set(receiptPages(notes, done));
  if (!ids.size) return [];
  const rules = loadRules(root), at = clock().toISOString(), d = today();
  const paths: string[] = [];
  let rel = "";
  for (const n of notes.filter((x) => ids.has(x.fm.id))) {
    const facts = n.fm.facts ?? {}, hist = (n.fm.history ??= {});
    for (const [attr, f] of Object.entries(facts)) {
      if (isDisputed(f) || isList(f)) continue;
      const rec = f as FactRecord;
      if (!live(rec)) continue;
      (hist[attr] ??= []).push({ ...rec, valid_to: d, ended_by: { step: 0, at: d, by: "hub" } });
      delete facts[attr];
      rel = appendDiary(root, { ...diaryRow({ at, factKey: `${n.fm.id}#${attr}`, title: String(n.fm.title ?? n.fm.id), kind: "retracted", from: shownValue(rec), to: undefined, incoming: rec, acceptedBy: "hub", rank: 9, sensitivity: rec.sensitivity ?? n.fm.sensitivity }), why: "receipt" }, ownerDay(rules, clock()).slice(0, 7));
    }
    n.fm.updated = d;
    saveNote(root, n);
    paths.push(n.path);
  }
  commitPaths(root, [...paths, rel], `hub: set aside ${ids.size} receipt page${ids.size === 1 ? "" : "s"}\n\nWhy: these pages were started from receipts sent by a no-reply address and were still held for the owner, never seen; receipts are not facts (G506). Each has a diary line with Undo.\nKind: receipts`, "hub");
  return [...ids];
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
// upkeep only counts them.
export interface MachineFact { id: string; attr: string }
export function machineFacts(notes: Note[], machine: ReadonlySet<string>): MachineFact[] {
  if (!machine.size) return [];
  const out: MachineFact[] = [];
  for (const n of notes) {
    if (n.fm.type === "dispute" || ["archived", "merged", "superseded"].includes(String(n.fm.status ?? ""))) continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (isDisputed(f) || isList(f)) continue;
      const r = f as FactRecord;
      const keys = (r.sources ?? []).map((x) => mailKey(refString(x)));
      if (live(r) && r.unseen && !isOwnerId(r.by) && !isOwnerConfirmed(r.verification) && !(r.sources ?? []).some((x) => isExactLouisRef(refString(x)))
        && keys.length > 0 && keys.every((k) => !!k && machine.has(k))) out.push({ id: n.fm.id, attr });
    }
  }
  return out;
}

export function setAsideMachineMail(root: string, apply: boolean): { facts: number; pages: number; removed: string[] } {
  const notes = loadBrain(root);
  const found = machineFacts(notes, machineMail(root));
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
