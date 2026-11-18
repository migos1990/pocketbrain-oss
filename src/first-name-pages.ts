// SPDX-License-Identifier: AGPL-3.0-only
// Person pages named only by the owner's first name (owner's phone, 2026-11-16: a shop's mail greeted
// its customer as "Robin", and the pull started a page for "a" Robin who "works at" the shop). The
// capture check files nothing for that name now (G976, `ownerFirstNameAlone` in src/capture.ts);
// these are the pages it made before. A page qualifies when it is a person page titled with the
// owner's given name alone, not the owner's own page, started by someone other than the owner, every
// fact on it a plain value that no one but a source or an assistant wrote (no owner's word, no owner
// ref), and none set aside once already (G978). Each live fact goes to history with a diary line (why
// "first-name") whose Undo brings it back; the page itself goes in the same commit when it has no
// one's words but the hub's and no page links to it, and that Undo brings it back as it was.
// Off until the owner says (`pocketbrain first-name-pages on`, policy.yaml first_name_pages.set_aside):
// until then upkeep only counts them, and `pocketbrain first-name-pages` lists their ids.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadBrain, saveNote, today, isList, isDisputed, type Note, type FactRecord } from "./brain";
import { refString, isExactLouisRef } from "./sources";
import { appendDiary, diaryRow, readDiary, shownValue, type DiaryRow } from "./diary";
import { commitPaths } from "./git";
import { clock, ownerDay } from "./clock";
import { loadRules, type Rules } from "./rules";
import { isOwnerId, isOwnerConfirmed } from "./owner";
import { ownerFirstNameAlone } from "./capture";
import { ownerPageOf } from "./dashboard/home";
import { noOwnWords } from "./undo";

export const FIRST_NAME_KIND = "Kind: first-name-page";
const live = (r: FactRecord) => !r.valid_to && !r.retired;
const ownerWord = (r: FactRecord) => isOwnerId(r.by) || isOwnerConfirmed(r.verification) || (r.sources ?? []).some((x) => isExactLouisRef(refString(x)));

export const firstNameOn = (rules: Rules) => (rules.policy as { first_name_pages?: { set_aside?: boolean } }).first_name_pages?.set_aside === true;

// Pages set aside once, by the diary: never again, so the owner's Undo holds.
function doneBefore(rows: DiaryRow[]): Set<string> {
  return new Set(rows.filter((r) => r.why === "first-name").map((r) => r.fact_key.slice(0, r.fact_key.lastIndexOf("#"))));
}

export function firstNamePages(rules: Rules, notes: Note[], done: ReadonlySet<string> = new Set()): Note[] {
  const own = ownerPageOf(rules, notes)?.fm.id;
  return notes.filter((n) => {
    if (n.fm.type !== "person" || n.fm.id === own || done.has(n.fm.id) || isOwnerId(n.fm.by)) return false;
    if (["archived", "merged", "superseded"].includes(String(n.fm.status ?? ""))) return false;
    if (!ownerFirstNameAlone(rules, String(n.fm.title ?? ""))) return false;
    const facts = Object.values(n.fm.facts ?? {});
    if (!facts.length || facts.some((f) => isDisputed(f) || isList(f))) return false;
    const recs = facts.map((f) => f as FactRecord);
    return recs.some(live) && !recs.some(ownerWord) && !Object.values(n.fm.history ?? {}).flat().some((r) => ownerWord(r as FactRecord));
  });
}

export function setAsideFirstNamePages(root: string, apply: boolean): { pages: string[]; facts: number; removed: string[] } {
  const notes = loadBrain(root), rules = loadRules(root);
  const found = firstNamePages(rules, notes, doneBefore(readDiary(root)));
  const facts = found.reduce((s, n) => s + Object.values(n.fm.facts ?? {}).filter((f) => live(f as FactRecord)).length, 0);
  const pages = found.map((n) => n.fm.id);
  if (!apply || !found.length) return { pages, facts, removed: [] };
  const at = clock().toISOString(), d = today(), month = ownerDay(rules, clock()).slice(0, 7);
  const paths: string[] = [], removed: string[] = [];
  let rel = "";
  for (const n of found) {
    const fs = n.fm.facts ?? {}, hist = (n.fm.history ??= {});
    for (const [attr, f] of Object.entries(fs)) {
      const rec = f as FactRecord;
      if (!live(rec)) continue;
      (hist[attr] ??= []).push({ ...rec, valid_to: d, ended_by: { step: 0, at: d, by: "hub" } });
      delete fs[attr];
      rel = appendDiary(root, { ...diaryRow({ at, factKey: `${n.fm.id}#${attr}`, title: String(n.fm.title ?? n.fm.id), kind: "retracted", from: shownValue(rec), to: undefined, incoming: rec, acceptedBy: "hub", rank: 9, sensitivity: rec.sensitivity ?? n.fm.sensitivity }), why: "first-name" }, month);
    }
    n.fm.updated = d;
    paths.push(n.path);
    if (noOwnWords(root, n, notes)) { rmSync(join(root, n.path)); removed.push(n.fm.id); }
    else saveNote(root, n);
  }
  const s = (k: number, one: string, many: string) => (k === 1 ? one : many);
  commitPaths(root, [...paths, rel], `hub: set aside ${found.length} ${s(found.length, "page", "pages")} named only by the owner's first name\n\nWhy: a first name alone could be the owner or anyone, so a source's facts filed under it are a guess (G976, G978). Each fact has a diary line with Undo.${removed.length ? ` ${removed.length} ${s(removed.length, "page", "pages")} left with nothing ${s(removed.length, "goes", "go")} too; Undo brings ${s(removed.length, "it", "them")} back.` : ""}\n${FIRST_NAME_KIND}`, "hub");
  return { pages, facts, removed };
}
