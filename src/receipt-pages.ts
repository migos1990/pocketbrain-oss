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
