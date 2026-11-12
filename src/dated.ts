// SPDX-License-Identifier: AGPL-3.0-only
// Dates that end on their day (G799): a due date, a deadline, any attribute the schema says ends on
// the date it names (`ends_on_date`, set by attributeSpec for DATED, or `shelf_life: until_date`).
// A page can hold many of them: a course has a report, a midterm and a final; a trip has a check-in
// and a flight. Two different days from two different source items (two calendar events, two mails)
// are two things that each end on their day, so both hold and neither is a conflict. The same item
// giving another day is that item's date moving. Decided by structure only: the schema's flag, the
// value's shape (a whole day), and which source items each side cites; never by what a word means.
// Money, health and legal keep asking (invariant 6), and so does any side that cites no item (the
// owner's typed word, an assistant's own word): nothing then says the two dates are two things.
import { saveNote, today, type FactRecord, type Note } from "./brain";
import { attributeSpec, type AttributeSpec, type Rules } from "./rules";
import { refString } from "./sources";
import { sensitiveShape } from "./shape";
import { clock, ownerDay } from "./clock";
import { commitPaths } from "./git";
import { appendDiary, diaryRow } from "./diary";
import { logWrite } from "./write";
import { hubReadRefs } from "./pull";

// A source the hub can read item by item: a mail, an event, a message, a document.
const ITEM = /^(gmail|gmail-thread|gcal|mail|imessage|granola|gdoc|discord|slack|zoom):/;
// One item whatever its version: a calendar event's ref carries `@<etag>`, which changes when it moves.
export const itemOf = (ref: string) => ref.replace(/@[^@/]*$/, "");
const DAY = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;

export const endsOnDate = (spec: AttributeSpec) => !!spec.ends_on_date || spec.shelf_life === "until_date";
export const wholeDay = (v: unknown) => typeof v === "string" && DAY.test(v.trim());

// The source items a record cites, by item (versions folded), and only ones the hub read itself
// when `read` (item ids) is given: a ref the writer merely names says nothing (slice audit F3).
export function itemsOf(r: Pick<FactRecord, "sources">, read?: Set<string>): Set<string> {
  return new Set((r.sources ?? []).map(refString).filter((x) => ITEM.test(x)).map(itemOf).filter((x) => !read || read.has(x)));
}

// Whether two records of one fact are two dated things on the page: the attribute ends on its date,
// both values are whole days and differ, each side cites a source item, they share none, and nothing
// about them is money, health or legal (by the page's type or the values' shape).
// `read`: item ids the hub read (any version); `exact`, when given, the refs it read as written: the
// new side `b` then counts an item only at a version the hub read, so a writer can't make a date
// another item's by naming a real event at a version nobody read (slice audit N2). The night pass
// weighs old packets by item alone: the events have moved on since.
export function twoDatedThings(rules: Rules, note: Note, attr: string, spec: AttributeSpec, a: FactRecord, b: FactRecord, read?: Set<string>, exact?: Set<string>): boolean {
  if (!endsOnDate(spec) || !wholeDay(a.value) || !wholeDay(b.value)) return false;
  if (String(a.value).slice(0, 10) === String(b.value).slice(0, 10)) return false;
  if (note.fm.type === "money" || note.fm.id.startsWith("money/") || sensitiveShape(rules, attr, note.fm.title)) return false;
  const x = itemsOf(a, read), y = exact ? newItems(b, exact) : itemsOf(b, read);
  if (!x.size || !y.size) return false;
  for (const i of x) if (y.has(i)) return false;
  return true;
}

// The items a new record cites at a version the hub read itself, by item.
export function newItems(r: Pick<FactRecord, "sources">, exact: Set<string>): Set<string> {
  return new Set((r.sources ?? []).map(refString).filter((x) => ITEM.test(x) && exact.has(x)).map(itemOf));
}

// A list of such dates in day order, so a page says them soonest first.
export const byDay = <T extends Pick<FactRecord, "value">>(items: T[]): T[] => items.sort((a, b) => String(a.value).localeCompare(String(b.value)));

// The live record of a list that is the same source item as `r` (its date moving), if any.
export function sameItem<T extends Pick<FactRecord, "sources">>(items: T[], r: Pick<FactRecord, "sources">, read?: Set<string>): T | undefined {
  const y = itemsOf(r, read);
  if (!y.size) return undefined;
  return items.find((i) => [...itemsOf(i, read)].some((x) => y.has(x)));
}

// ---------- the night pass (G800) ----------
// Conflicts opened before G799 on two such dates still ask the owner to pick. Upkeep step 8c closes
// each one whose every pair of sides is two dated things: both dates stay live side by side, the
// packet is closed as `both-hold` (no side picked, nothing deleted), and the date that was waiting
// gets a diary line with Undo. On from the first night by the owner's own answer (2026-11-12, "Yes,
// retire them by itself"); `both_dates: false` in policy.yaml (`pocketbrain filing dates off`) makes it a count. Only conflicts on one record's two sides; a third side, a
// side the live record no longer holds, or a fact that changed since leaves the conflict as it is.
export const bothDatesOn = (rules: Rules) => (rules.policy as { both_dates?: boolean }).both_dates !== false;

export interface BothDates { packet: Note; page: Note; attr: string; live: FactRecord; other: FactRecord; list?: FactRecord[] }

export function bothDatesPlan(root: string, rules: Rules, notes: Note[]): BothDates[] {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const read = new Set([...hubReadRefs(root)].map(itemOf));
  const out: BothDates[] = [];
  const day = (r: FactRecord) => String(r.value).slice(0, 10);
  for (const p of notes) {
    if (p.fm.type !== "dispute" || !["open", "escalated"].includes(String(p.fm.status))) continue;
    const key = String(p.fm.fact_key ?? ""), hash = key.lastIndexOf("#"), pid = String(p.fm.id).replace(/^disputes\//, "");
    const page = byId.get(key.slice(0, hash)), attr = key.slice(hash + 1);
    const cands = (p.fm as { candidates?: FactRecord[] }).candidates ?? [];
    if (!page || cands.length !== 2) continue;
    const f = page.fm.facts?.[attr];
    if (!f) continue;
    // The fact as the conflict left it: the live value with the packet beside it (G425), alone or as
    // one item of a list that another date joined since; or a fact holding both sides as a dispute
    // (before G425).
    const list = "items" in f ? (f.items as FactRecord[]) : undefined;
    const beside = list ? list.find((i) => !i.valid_to && !i.retired && i.contested === pid)
      : !("dispute" in f) && (f as FactRecord).contested === pid ? f as FactRecord : undefined;
    const held = !list && "dispute" in f && (f as { dispute?: string }).dispute === pid ? f as { candidates?: FactRecord[] } : undefined;
    if (!beside && !held) continue;
    const spec = attributeSpec(rules, page.fm.type, attr);
    if (!twoDatedThings(rules, page, attr, spec, cands[0]!, cands[1]!, read)) continue;
    const live = beside ?? held!.candidates?.find((c) => day(c) === day(cands[0]!)) ?? cands[0]!;
    const other = cands.find((c) => day(c) !== day(live));
    // A live value that changed since the conflict opened is not one of its sides: left as it is.
    if (!other || (beside && !cands.some((c) => day(c) === day(beside)))) continue;
    out.push({ packet: p, page, attr, live, other, ...(list ? { list } : {}) });
  }
  return out;
}

// Closes them: one hub commit with a why; returns the fact keys closed.
export function closeBothDates(root: string, rules: Rules, plan: BothDates[]): string[] {
  if (!plan.length) return [];
  const at = clock().toISOString(), d = today(), month = ownerDay(rules, clock()).slice(0, 7);
  const paths: string[] = [], keys: string[] = [];
  let rel = "";
  for (const x of plan) {
    const { contested: _o, ...other } = x.other as FactRecord & { contested?: string };
    if (x.list) {
      delete (x.live as FactRecord & { contested?: string }).contested;
      const live = x.list.filter((i) => !i.valid_to && !i.retired);
      if (!live.some((i) => String(i.value).slice(0, 10) === String(other.value).slice(0, 10))) x.list.push(other as FactRecord);
      byDay(x.list);
    } else {
      const { contested: _c, ...live } = x.live as FactRecord & { contested?: string };
      (x.page.fm.facts ??= {})[x.attr] = { items: byDay([live as FactRecord, other as FactRecord]) };
    }
    x.page.fm.updated = d;
    saveNote(root, x.page);
    Object.assign(x.packet.fm, { status: "both-hold", answer: { by: "hub", at: d, keep: "both", why: "two dates from two items" }, updated: d });
    saveNote(root, x.packet);
    const key = `${x.page.fm.id}#${x.attr}`;
    paths.push(x.page.path, x.packet.path);
    keys.push(key);
    rel = appendDiary(root, { ...diaryRow({ at, factKey: key, title: String(x.page.fm.title ?? x.page.fm.id), kind: "item_added", from: undefined, to: other.value, incoming: other as FactRecord, acceptedBy: "hub", rank: 0, sensitivity: other.sensitivity ?? x.page.fm.sensitivity }), why: "both-dates" }, month);
  }
  const unsaved = commitPaths(root, [...paths, rel], `hub: ${keys.length} date conflict${keys.length === 1 ? "" : "s"} closed as both kept\n\nWhy: each one's two dates came from two different calendar events or mails, so they are two dated things on the page, not one value in doubt (G800). Both stay live; nothing was picked or deleted; the date that was waiting has a diary line with Undo.\nKind: upkeep\nFact-Keys: ${keys.join(", ")}`, "hub");
  if (unsaved) return [];
  for (const x of plan) logWrite(root, { at, agent: "hub", kind: "both-dates", key: `${x.page.fm.id}#${x.attr}`, outcome: "committed", dispute: String(x.packet.fm.id) });
  return keys;
}
