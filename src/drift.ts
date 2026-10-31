// SPDX-License-Identifier: AGPL-3.0-only
// A change reaches its neighbours (memory-graph.md item 3, docs/wiki.md "When a fact changes"): a
// fact's earlier value lives on in history, and any note that links to the page, or the page's own
// text and summary, that still states it gets a review line. No model: the earlier value is
// matched as whole words, the same way names are. A value still true today (part of a current
// value) is never flagged. Nothing is rewritten here; the Gardener refreshes pages from facts.
import { linksIn, isList, isDisputed, type Note, type FactRecord } from "./brain";

export interface Drift { note: string; page: string; attr: string; since: string }

const fold = (s: string) => [...s].map((c) => { const f = c.normalize("NFKD").replace(/\p{M}/gu, ""); return f.length === 1 ? f : c; }).join("").toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The words an earlier value is stated with: its text, or for a link the title of the note it named.
function said(v: unknown, titles: Map<string, string>): string | undefined {
  if (typeof v !== "string") return undefined;
  const link = v.trim().match(/^\[\[([^\]|#]+)(?:[^\]]*)?\]\]$/);
  const t = (link ? titles.get(link[1].trim()) : v)?.trim();
  return t && t.length >= 4 && /[\p{L}\p{N}]/u.test(t) ? t : undefined;
}

function currentValues(n: Note, attr: string): unknown[] {
  const f = n.fm.facts?.[attr];
  if (!f) return [];
  if (isDisputed(f)) return f.candidates.map((c) => c.value);
  if (isList(f)) return f.items.filter((i) => !i.valid_to).map((i) => i.value);
  return [(f as FactRecord).value];
}

// Earlier values: every replaced or ended value (history:) and ended list items (valid_to), with
// the day it stopped being true.
const ended = (r: FactRecord) => String(r.valid_to ?? (r.ended_by as { at?: string } | undefined)?.at ?? r.as_of);
function earlier(n: Note): { attr: string; r: FactRecord }[] {
  const out: { attr: string; r: FactRecord }[] = [];
  for (const [attr, rs] of Object.entries(n.fm.history ?? {})) for (const r of rs ?? []) out.push({ attr, r });
  for (const [attr, f] of Object.entries(n.fm.facts ?? {})) if (isList(f)) for (const r of f.items) if (r.valid_to) out.push({ attr, r });
  return out;
}

export function staleMentions(notes: Note[]): Drift[] {
  const titles = new Map(notes.map((n) => [n.fm.id, String(n.fm.title ?? "")]));
  const linkers = new Map<string, Note[]>();
  for (const n of notes) for (const to of new Set([...linksIn(n.body), ...linksIn(JSON.stringify(n.fm.facts ?? {}))])) if (to !== n.fm.id) (linkers.get(to) ?? linkers.set(to, []).get(to)!).push(n);
  const out: Drift[] = [], seen = new Set<string>();
  for (const page of notes) {
    if (page.fm.status === "merged") continue;
    for (const { attr, r } of earlier(page)) {
      const old = said(r.value, titles);
      if (!old) continue;
      const now = currentValues(page, attr).map((v) => said(v, titles) ?? (typeof v === "string" ? v : "")).map(fold);
      if (now.some((v) => v.includes(fold(old)))) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${esc(fold(old))}(?![\\p{L}\\p{N}_])`, "u");
      for (const n of [page, ...(linkers.get(page.fm.id) ?? [])]) {
        if (n.fm.status === "merged") continue;
        const text = fold([typeof n.fm.summary === "string" ? n.fm.summary : "", n.body].join("\n"));
        const k = `${n.fm.id}\u0000${page.fm.id}\u0000${attr}`;
        if (seen.has(k) || !re.test(text)) continue;
        seen.add(k);
        out.push({ note: n.fm.id, page: page.fm.id, attr, since: ended(r) });
      }
    }
  }
  return out;
}
