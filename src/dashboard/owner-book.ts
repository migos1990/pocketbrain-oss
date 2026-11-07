// SPDX-License-Identifier: AGPL-3.0-only
// The owner's own page as the first page of a book about them (Louis, 2026-11-03;
// plans/owner-page-wiki.md): under its prose, what's new across the brain, what they are on right
// now, who matters to them and what waits on them, every page a link. Owner-only and on the owner's
// own page only. A page's title is read from the page as it is now: a private or secret one is
// named only right after a sign-in (invariant 16); what waits is the home's own count (count rule
// v2). The summary itself is the page's prose, written by the page writer (src/wiki.ts).
// Right now is the owner's week (Louis 2026-11-06, decision card: "Yes, Right now is the week"):
// src/week.ts over every page the owner may see now and the calendar's coming events, a private
// page, fact or event only right after a sign-in, as the rest of the book.
import type { Fact, FactRecord, Note } from "../brain";
import { isList, isDisputed } from "../brain";
import { weekOf, type Week } from "../week";
import { loadUpcoming } from "../upcoming";
import { ownerDay } from "../clock";
import { sensitivityRank } from "../brain";
import type { State } from "./data";
import { latestLines, waitingCount, type HomeLine } from "./home";
import { whoMatters } from "./people";

export interface OwnerBook { news: HomeLine[]; now: Note[]; week: Week; matters: Note[]; waiting: number }

export const BOOK_NEWS = 4, BOOK_NOW = 5, BOOK_MATTERS = 8;
const DONE = /^(done|closed|archived|cancelled|canceled|finished|retired)$/i;

export function ownerBook(s: State, fresh: boolean): OwnerBook {
  const shown = (n: Note | undefined): n is Note => !!n && (fresh || sensitivityRank(n.fm.sensitivity) < sensitivityRank("private"));
  const byId = new Map(s.notes.map((n) => [n.fm.id, n]));
  // Projects still going, the most recently touched first.
  const now = s.notes.filter((n) => n.fm.type === "project" && String(n.fm.status ?? "active") === "active" && !DONE.test(String((n.fm.facts?.status as { value?: unknown } | undefined)?.value ?? "")) && shown(n))
    .sort((a, b) => String(b.fm.updated ?? "").localeCompare(String(a.fm.updated ?? "")) || String(a.fm.title).localeCompare(String(b.fm.title)))
    .slice(0, BOOK_NOW);
  // A fact the owner marked private, or a page's private item, is the owner's after a sign-in only.
  const open = (f: Fact) => fresh || ![isList(f) ? f.items : isDisputed(f) ? [] : [f as FactRecord]].flat().some((r) => sensitivityRank(r.sensitivity) >= sensitivityRank("private"));
  const pages = s.notes.filter(shown);
  const day = ownerDay(s.rules, s.now);
  const events = loadUpcoming(s.root, day).filter((e) => fresh || sensitivityRank(e.sensitivity) < sensitivityRank("private"));
  const title = (id: string) => { const n = byId.get(id); return shown(n) ? String(n.fm.title ?? id) : undefined; };
  const week = weekOf(pages.map((n) => ({ id: n.fm.id, title: String(n.fm.title ?? n.fm.id), type: n.fm.type, status: n.fm.status, aliases: n.fm.aliases, facts: Object.entries(n.fm.facts ?? {}).filter(([, f]) => open(f)) })), s.rules, events, day, title);
  const matters = whoMatters(s.root).map((id) => byId.get(id)).filter(shown).slice(0, BOOK_MATTERS);
  return { news: latestLines(s.root, s.rules, s.notes, BOOK_NEWS), now, week, matters, waiting: waitingCount(s.root, s.now) };
}
