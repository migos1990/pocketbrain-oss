// SPDX-License-Identifier: AGPL-3.0-only
// The owner's own page as the first page of a book about them (Louis, 2026-11-03;
// plans/owner-page-wiki.md): under its prose, what's new across the brain, what they are on right
// now, who matters to them and what waits on them, every page a link. Owner-only and on the owner's
// own page only. A page's title is read from the page as it is now: a private or secret one is
// named only right after a sign-in (invariant 16); what waits is the home's own count (count rule
// v2). The summary itself is the page's prose, written by the page writer (src/wiki.ts).
import type { Note } from "../brain";
import { sensitivityRank } from "../brain";
import type { State } from "./data";
import { latestLines, waitingCount, type HomeLine } from "./home";
import { whoMatters } from "./people";

export interface OwnerBook { news: HomeLine[]; now: Note[]; matters: Note[]; waiting: number }

export const BOOK_NEWS = 4, BOOK_NOW = 5, BOOK_MATTERS = 8;
const DONE = /^(done|closed|archived|cancelled|canceled|finished|retired)$/i;

export function ownerBook(s: State, fresh: boolean): OwnerBook {
  const shown = (n: Note | undefined): n is Note => !!n && (fresh || sensitivityRank(n.fm.sensitivity) < sensitivityRank("private"));
  const byId = new Map(s.notes.map((n) => [n.fm.id, n]));
  // Projects still going, the most recently touched first.
  const now = s.notes.filter((n) => n.fm.type === "project" && String(n.fm.status ?? "active") === "active" && !DONE.test(String((n.fm.facts?.status as { value?: unknown } | undefined)?.value ?? "")) && shown(n))
    .sort((a, b) => String(b.fm.updated ?? "").localeCompare(String(a.fm.updated ?? "")) || String(a.fm.title).localeCompare(String(b.fm.title)))
    .slice(0, BOOK_NOW);
  const matters = whoMatters(s.root).map((id) => byId.get(id)).filter(shown).slice(0, BOOK_MATTERS);
  return { news: latestLines(s.root, s.rules, s.notes, BOOK_NEWS), now, matters, waiting: waitingCount(s.root, s.now) };
}
