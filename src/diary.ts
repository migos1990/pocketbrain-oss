// SPDX-License-Identifier: AGPL-3.0-only
// The owner's diary (phone UI spec §6, owner 2026-10-26): one row per fact change, appended by
// write() to diary/YYYY-MM.jsonl and committed with the change itself. The owner's home renders what
// the brain learned from these rows, never from git log. Hub-only commits (page text, name keys,
// re-ranks, backups) don't go through write() and add no row. diary/ is not a content folder, so no
// carve, cell or agent view ever reads it, and no agent can write it (checks.ts protected_paths).
import { join } from "node:path";
import type { FactRecord, Sensitivity } from "./brain";
import { sensitivityRank } from "./brain";
import { refString, schemeOf, isExactLouisRef } from "./sources";
import { isOwnerConfirmed } from "./owner";
import { readJsonl, appendJsonl, sha256 } from "./util";
import { readdirSync, existsSync } from "node:fs";

// held: an assistant's proposal waiting for the day its hold ends (`until`); set_aside: an
// assistant's open question or take-back the hub set aside, since only a conflict asks (src/filing.ts).
// confirmed: the hub filed a value the page already held; `added` names the sources it added (G524).
export type DiaryKind = "new" | "changed" | "retracted" | "item_added" | "conflict" | "settled" | "kept" | "seen" | "undone" | "held" | "set_aside" | "confirmed";

export interface DiaryRow {
  at: string;
  fact_key: string;
  title: string;
  kind: DiaryKind;
  from?: unknown; // left out for a new fact and for any secret row
  to?: unknown;
  // Where the value came from, as a kind the owner's screens turn into words: you, email, calendar,
  // notion, assistant, or the source's scheme.
  source_word: string;
  by: string;
  accepted_by?: string;
  confidence: "stated" | "inferred";
  rank: number; // the source's rank in the conflict order; the home orders lines by it, lowest first
  sources: number;
  sensitivity: Sensitivity;
  undo_token: string;
  undoes?: string; // on an `undone` row: the line it undid (src/undo.ts)
  commit?: string; // a caught-up row: the commit that made the change (src/diary-catchup.ts)
  settles?: string; // on a `settled` row: the conflict it answered (its Undo opens it again)
  ref?: string; // on a `held` or `set_aside` row: the proposal's file under inbox/
  until?: string; // on a `held` row: the owner's day the hold ends
  why?: "receipt" | "family"; // a held receipt page upkeep set aside (src/receipt-pages.ts), Undo brings it back; or a page upkeep linked as maybe family (src/family.ts)
  added?: string[]; // on a `confirmed` row: the source refs the filing added (Undo takes them out)
}

export const DIARY_DIR = "diary";
export const diaryRel = (month: string) => `${DIARY_DIR}/${month}.jsonl`;
export const diaryPath = (root: string, month: string) => join(root, diaryRel(month));

export function sourceKind(r: Pick<FactRecord, "sources" | "verification">): string {
  if (isOwnerConfirmed(r.verification)) return "you";
  // A tap's own record (approved:) says only that the owner picked it; the value came from the rest.
  const refs = (r.sources ?? []).map(refString).filter((x) => schemeOf(x) !== "approved");
  if (refs.some(isExactLouisRef)) return "you";
  const s = refs.map((x) => schemeOf(x)).find(Boolean);
  if (!s) return "none";
  if (s === "gmail" || s === "gmail-thread" || s === "mail") return "email";
  if (s === "gcal") return "calendar";
  if (s === "agent" || s === "agent-relay" || s === "agent-log" || s === "instinct-mem" || s === "town-wiki" || s === "town-routine") return "assistant";
  return s;
}

// What the owner's line shows for a fact: one value, or a list's live items.
export function shownValue(f: unknown): unknown {
  if (f === undefined || f === null) return undefined;
  const o = f as { items?: FactRecord[]; dispute?: string; candidates?: FactRecord[]; value?: unknown };
  if (Array.isArray(o.items)) return o.items.filter((i) => !i.valid_to).map((i) => i.value);
  if (o.dispute) return undefined;
  return o.value;
}

export function diaryRow(p: { at: string; factKey: string; title: string; kind: DiaryKind; from: unknown; to: unknown; incoming: FactRecord; acceptedBy?: string; rank: number; sensitivity: Sensitivity; settles?: string }): DiaryRow {
  const secret = sensitivityRank(p.sensitivity) >= sensitivityRank("secret");
  return {
    at: p.at,
    fact_key: p.factKey,
    title: p.title,
    kind: p.kind,
    ...(secret || p.from === undefined ? {} : { from: p.from }),
    ...(secret || p.to === undefined ? {} : { to: p.to }),
    source_word: sourceKind(p.incoming),
    by: p.incoming.by,
    ...(p.acceptedBy && p.acceptedBy !== p.incoming.by ? { accepted_by: p.acceptedBy } : {}),
    confidence: p.incoming.confidence === "inferred" ? "inferred" : "stated",
    rank: p.rank,
    sources: p.incoming.sources.length,
    sensitivity: p.sensitivity,
    ...(p.settles ? { settles: p.settles } : {}),
    undo_token: sha256(`${p.factKey}\n${p.at}\n${JSON.stringify(p.to ?? null)}\n${p.kind}`).slice(0, 16),
  };
}

// Appends the row and returns the path (relative to the brain) to commit with the change.
export function appendDiary(root: string, row: DiaryRow, month: string): string {
  appendJsonl(diaryPath(root, month), row);
  return diaryRel(month);
}

// Every row, oldest first; `since` (an ISO time) keeps later ones only.
export function readDiary(root: string, opts: { since?: string } = {}): DiaryRow[] {
  const dir = join(root, DIARY_DIR);
  if (!existsSync(dir)) return [];
  const months = readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  // In time order: a caught-up row (src/diary-catchup.ts) is appended after newer ones.
  const rows = months.flatMap((f) => readJsonl<DiaryRow & { request_id?: string }>(join(dir, f))).sort((a, b) => a.at.localeCompare(b.at));
  return opts.since ? rows.filter((r) => r.at > opts.since!) : rows;
}

// A page as the owner reads its name: its title, or, when it has none or the title is just its
// slug ("harbour-club"), the slug in words ("Harbour club"). Never an id.
// lowercase words joined by hyphens, as an id's last part is written ("gone-person-old").
export const SLUG_LIKE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+$/;
// A date as the owner says it: "2026-10-12" is "12 Oct 2026". Anything else is left as it is.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function sayDay(text: string): string {
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : text;
}
// Every day inside a text, the same way; a date joined to a time or a range is left alone.
export const sayDays = (text: string) => text.replace(/(?<![\w/-])\d{4}-\d{2}-\d{2}(?![\w-])/g, sayDay);
export function displayName(id: string, title?: unknown): string {
  const slug = id.split("/").pop() ?? id;
  const t = typeof title === "string" ? title.trim() : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(t || slug)) return sayDay(t || slug);
  if (t && t !== slug && t !== id && !SLUG_LIKE.test(t)) return sayDays(t);
  // No title, or a title that is itself a slug (a page renamed or gone): its words, a day in it as a day.
  const words = (t && SLUG_LIKE.test(t) ? t : slug).replace(/(\d{4}-\d{2}-\d{2})|[-_]+/g, (m, d?: string) => d ? sayDay(d) : " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}
// A page id written into text ("orgs/bay-institute"), as the owner reads it.
export const ID_IN_TEXT = /\b(?:people|orgs|projects|decisions|notes|money|agents|disputes)\/[a-z0-9][a-z0-9-]*\b/g;

// The hub's filings in the last day whose commits left no diary line (6e15f795 live, 2026-10-30:
// two filings showed nowhere on the owner's home; G524). Keys only, for the self-check.
const FILED_PICKS = new Set(["saved it", "held it as a conflict"]);
export function filedWithoutLine(root: string, now = new Date()): string[] {
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const rows = readJsonl<{ key?: string; picked?: string; at?: string; commit?: string; commits?: string[]; undo_of?: string }>(join(root, "log", "auto-decisions.jsonl"))
    .filter((r) => !r.undo_of && FILED_PICKS.has(String(r.picked)) && String(r.at ?? "") >= since);
  const touched = (c: string) => Bun.spawnSync(["git", "-C", root, "show", "--name-only", "--format=", c], { stdout: "pipe", stderr: "pipe" }).stdout.toString().split("\n").some((f) => f.startsWith(`${DIARY_DIR}/`));
  return rows.filter((r) => !(r.commits ?? (r.commit ? [r.commit] : [])).some(touched)).map((r) => String(r.key));
}
