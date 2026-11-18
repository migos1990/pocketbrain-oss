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
import { compareKey } from "./normalize";
import { setAsideSide } from "./core";
import { fetchOne } from "./pull";
import { appendJsonl, readJsonl } from "./util";
import { existsSync } from "node:fs";

const live = (r: FactRecord) => !r.valid_to && !r.retired;

// What was set aside once, from the diary: a fact by its key (why "machine"), a whole page by its id
// (why "receipt", the old step). Either is left alone from then on, so the owner's Undo holds. A
// value the owner read and let out (a "seen" line) is theirs to keep the same way.
export function setAsideBefore(rows: DiaryRow[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.why === "machine" || r.kind === "seen") out.add(r.fact_key);
    else if (r.why === "receipt") out.add(r.fact_key.slice(0, r.fact_key.lastIndexOf("#")));
  }
  return out;
}

// Facts an assistant filed from machine mail (owner's phone, 2026-11-03: a ride receipt became an
// org page with two held rows and nothing else; G668). Machine mail is never read for facts: write()
// refuses it now, and these are the ones filed before. A record qualifies when it is live, written
// by someone other than the owner with no owner's word on it, and every source is mail the hub saw
// was machine-sent (src/louis.ts machineMail). Held or already given to assistants, alone or one of
// several on a list, or one side of an open question (G964, the owner's typed yes, 2026-11-16).
// Each goes to history with a diary line (why "machine") whose Undo brings it back as it was. A
// question with one such side closes as its other side, and its Undo opens the question again. A
// page left with nothing live, no one's words but the hub's and no page naming it goes too, in the
// same commit; Undo brings it back from that commit.
// Off until the owner says (`pocketbrain machine-mail on`, policy.yaml machine_mail.set_aside): then
// upkeep only counts them. `done` (setAsideBefore) is what was set aside once, or what the owner
// read and let out: never taken.
// item: the value of one list item; packet/keep: an open question and the side that stays.
export interface MachineFact { id: string; attr: string; item?: unknown; packet?: string; keep?: number }
export const fromMachine = (r: FactRecord, machine: ReadonlySet<string>) => {
  const keys = (r.sources ?? []).map((x) => mailKey(refString(x)));
  return !isOwnerId(r.by) && !isOwnerConfirmed(r.verification) && !(r.sources ?? []).some((x) => isExactLouisRef(refString(x)))
    && keys.length > 0 && keys.every((k) => !!k && machine.has(k));
};
export function machineFacts(notes: Note[], machine: ReadonlySet<string>, done: ReadonlySet<string> = new Set()): MachineFact[] {
  if (!machine.size) return [];
  const out: MachineFact[] = [];
  const gone = (n: Note) => ["archived", "merged", "superseded"].includes(String(n.fm.status ?? ""));
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  // Open questions on one fact with two sides, one of them machine mail only: the other side stays.
  // Two machine sides: the first stays for now, and is set aside as a plain fact in the same run.
  for (const p of notes) {
    if (p.fm.type !== "dispute" || !["open", "escalated"].includes(String(p.fm.status)) || (p.fm as { other_key?: string }).other_key) continue;
    const key = String(p.fm.fact_key ?? ""), hash = key.lastIndexOf("#");
    const page = byId.get(key.slice(0, hash)), attr = key.slice(hash + 1);
    const cands = (p.fm as { candidates?: FactRecord[] }).candidates ?? [];
    if (!page || gone(page) || done.has(page.fm.id) || done.has(key) || cands.length !== 2) continue;
    const m = cands.map((c) => fromMachine(c, machine));
    if (!m[0] && !m[1]) continue;
    out.push({ id: page.fm.id, attr, packet: String(p.fm.id).replace(/^disputes\//, ""), keep: m[0] && !m[1] ? 1 : 0 });
  }
  const asked = new Set(out.map((f) => `${f.id}#${f.attr}`));
  for (const n of notes) {
    if (done.has(n.fm.id) || n.fm.type === "dispute" || gone(n)) continue;
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      const key = `${n.fm.id}#${attr}`;
      if (isDisputed(f) || done.has(key) || asked.has(key)) continue;
      if (isList(f)) { for (const i of f.items) if (live(i) && !i.contested && fromMachine(i, machine)) out.push({ id: n.fm.id, attr, item: i.value }); continue; }
      const r = f as FactRecord;
      if (live(r) && !r.contested && fromMachine(r, machine)) out.push({ id: n.fm.id, attr });
    }
  }
  return out;
}

export function setAsideMachineMail(root: string, apply: boolean): { facts: number; pages: number; removed: string[] } {
  const machine = machineMail(root), done = setAsideBefore(readDiary(root));
  const first = machineFacts(loadBrain(root), machine, done);
  if (!apply || !first.length) return { facts: first.length, pages: new Set(first.map((f) => f.id)).size, removed: [] };
  // Questions first, each its own commit with a "settled" line whose Undo opens it again; then the
  // plain facts and list items as they stand after that, in one commit.
  let n = 0;
  const touched = new Set<string>();
  for (const f of first) if (f.packet && setAsideSide(root, f.packet, f.keep!)) { n++; touched.add(f.id); }
  const notes = loadBrain(root);
  const found = machineFacts(notes, machine, done).filter((f) => !f.packet);
  const ids = new Set(found.map((f) => f.id));
  for (const id of ids) touched.add(id);
  if (!found.length) return { facts: n, pages: touched.size, removed: [] };
  const rules = loadRules(root), at = clock().toISOString(), d = today(), month = ownerDay(rules, clock()).slice(0, 7);
  const paths: string[] = [], removed: string[] = [];
  let rel = "";
  for (const n of notes.filter((x) => ids.has(x.fm.id))) {
    const facts = n.fm.facts ?? {}, hist = (n.fm.history ??= {});
    for (const { attr, item } of found.filter((f) => f.id === n.fm.id)) {
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
      rel = appendDiary(root, { ...diaryRow({ at, factKey: `${n.fm.id}#${attr}`, title: String(n.fm.title ?? n.fm.id), kind: "retracted", from: isList(f) ? was.value : shownValue(was as FactRecord), to: undefined, incoming: was as FactRecord, acceptedBy: "hub", rank: 9, sensitivity: rec.sensitivity ?? n.fm.sensitivity }), why: "machine" }, month);
    }
    if (!Object.keys(hist).length) delete n.fm.history;
    n.fm.updated = d;
    paths.push(n.path);
    const nothingLive = !Object.values(facts).some((f) => isDisputed(f) || (isList(f) ? f.items.some(live) : live(f as FactRecord)));
    if (nothingLive && !isOwnerId(n.fm.by) && n.fm.type !== "person" && noOwnWords(root, n, notes)) { rmSync(join(root, n.path)); removed.push(n.fm.id); }
    else saveNote(root, n);
  }
  commitPaths(root, [...paths, rel], `hub: set aside ${found.length} fact${found.length === 1 ? "" : "s"} filed from machine mail\n\nWhy: an assistant filed ${found.length === 1 ? "it" : "them"} from mail a machine sent (a no-reply, list or billing sender); machine mail is never read for facts (G668, G964). Each has a diary line with Undo.${removed.length ? ` ${removed.length} page${removed.length === 1 ? "" : "s"} left with nothing on ${removed.length === 1 ? "it goes" : "them go"} too; Undo brings ${removed.length === 1 ? "it" : "them"} back.` : ""}\nKind: machine-mail`, "hub");
  return { facts: n + found.length, pages: touched.size, removed };
}

// Mail read before the hub skipped machine senders (G980): the ledger (src/louis.ts machineMail)
// holds only what a pull skipped or a recheck read since, so a no-reply mail filed from earlier was
// never in it and the set-aside above passed its facts by. Each mail ref a live fact (or a side of
// an open question) cites, on a record that is not the owner's and cites mail only, is classified
// once by the hub's own read-one path (fetchOne in src/pull.ts, the same header rule as the pull;
// it records a machine's mail in the ledger, and nothing of the mail is kept but its ref). With the
// owner's switch off (`pocketbrain machine-mail on`) nothing is read: the refs are only counted.
// What was read is remembered by ref in log/machine-mail-checked.jsonl; a mail the hub could not
// reach is noted as failed and tried again another night, after the mail never tried, so mail
// that can never be read does not hold up the rest. A night reads `max` at most.
export const machineMailOn = (root: string) => (loadRules(root).policy as { machine_mail?: { set_aside?: boolean } }).machine_mail?.set_aside === true;
const CHECKED_FILE = ["log", "machine-mail-checked.jsonl"] as const;
export const OLD_MAIL_MAX = 200;
export function oldMailRefs(root: string): string[] {
  const machine = machineMail(root);
  const f = join(root, ...CHECKED_FILE);
  const rows = existsSync(f) ? readJsonl<{ ref: string; failed?: boolean }>(f) : [];
  const seen = new Set(rows.filter((o) => !o.failed).map((o) => mailKey(String(o.ref ?? ""))));
  // A read that failed is tried again, after the mail never tried: least often failed first.
  const fails = new Map<string, number>();
  for (const o of rows) if (o.failed) { const k = mailKey(String(o.ref ?? "")); if (k) fails.set(k, (fails.get(k) ?? 0) + 1); }
  const out = new Map<string, string>();
  const take = (r: FactRecord) => {
    if (!live(r) || isOwnerId(r.by) || isOwnerConfirmed(r.verification)) return;
    const refs = (r.sources ?? []).map((x) => refString(x));
    if (!refs.length || refs.some((x) => !mailKey(x) || isExactLouisRef(x))) return;
    for (const x of refs) { const k = mailKey(x)!; if (!machine.has(k) && !seen.has(k) && !out.has(k)) out.set(k, x); }
  };
  for (const n of loadBrain(root)) {
    if (["archived", "merged", "superseded"].includes(String(n.fm.status ?? ""))) continue;
    if (n.fm.type === "dispute") { if (["open", "escalated"].includes(String(n.fm.status))) for (const c of (n.fm as { candidates?: FactRecord[] }).candidates ?? []) take(c); continue; }
    for (const f of Object.values(n.fm.facts ?? {})) { if (isList(f)) f.items.forEach(take); else take(f as FactRecord); }
  }
  return [...out.entries()].sort((x, y) => (fails.get(x[0]) ?? 0) - (fails.get(y[0]) ?? 0)).map((e) => e[1]);
}
export async function classifyOldMail(root: string, on: boolean, opts: { max?: number; fetch?: typeof fetchOne } = {}): Promise<{ waiting: number; checked: number; found: number }> {
  const refs = oldMailRefs(root);
  const out = { waiting: refs.length, checked: 0, found: 0 };
  if (!on) return out;
  const fetch = opts.fetch ?? fetchOne;
  for (const ref of refs.slice(0, opts.max ?? OLD_MAIL_MAX)) {
    const it = await fetch(root, ref).catch((e) => String(e));
    // Read, or the mailbox says it is gone: settled either way. Anything else is tried again.
    if (typeof it !== "object" && !/not found in the/.test(it)) { appendJsonl(join(root, ...CHECKED_FILE), { ref, at: new Date().toISOString(), failed: true }); continue; }
    appendJsonl(join(root, ...CHECKED_FILE), { ref, at: new Date().toISOString() });
    out.checked++;
    if (typeof it === "object" && it.bulk) out.found++;
  }
  return out;
}
export const oldMailLine = (on: boolean, r: { waiting: number; checked: number; found: number }) => on
  ? `machine mail: ${r.checked} of ${r.waiting} earlier mail${r.waiting === 1 ? "" : "s"} read, ${r.found} from a machine`
  : `machine mail: ${r.waiting} earlier mail${r.waiting === 1 ? "" : "s"} never classified (read once \`pocketbrain machine-mail on\` is set)`;
