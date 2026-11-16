// SPDX-License-Identifier: AGPL-3.0-only
// Keep a guess with one tap (owner's yes, 2026-11-16; plan instant-value F2, G941).
//
// A "Not confirmed" line on the owner's home (src/dashboard/home.ts unconfirmedLines) is an outside
// assistant's save the hub leaves to expire: no assistant reads it. The owner keeps one with Keep, or
// every line of one page with Keep all. Keeping is the accept that already exists (decideProposal,
// by the owner, bound to the bytes the home showed): the value gets an approved: ref, so the page
// says it as the owner's (sources.ts lineState "yours") and it is served by the usual carve to every
// assistant whose slice reaches it, at the rank of the source it cites, never above it (owner's
// choice 2026-10-25: a tap is an approval, not their own typed word). The write path's checks all
// run again; a value that differs from the page's becomes a conflict, as any accept does. Undo is
// the diary's own (the write's diary row).
//
// What is kept is decided here, not by the form: only a proposal that is a Not confirmed line right
// now, as the home builds them (so never private, money, health or legal, never one that carried a
// value its assistant can't see, never a capture, a source's or the owner's), and only when its file
// still holds the bytes the home hashed. Anything else is left exactly as it was.
import { loadBrain } from "./brain";
import { loadRules } from "./rules";
import { decideProposal, inboxCards } from "./write";
import { OWNER } from "./owner";
import { ownerAsks } from "./waiting";
import { unconfirmedLines } from "./dashboard/home";
import { sensitiveShape } from "./shape";

export interface KeepPick { file: string; seen: string }
export interface KeepResult { kept: number; conflicts: number; gone: number; message: string }

// One tap keeps at most a page's worth; a longer list is cut, never kept unseen.
export const KEEP_MAX = 50;
const FILE = /^[A-Za-z0-9._-]+\.yaml$/, SEEN = /^[0-9a-f]{16}$/;

const GONE = "Nothing to keep there any more.";
// One fixed sentence per outcome: what the owner's tap did, and who gets it now.
export function keptWords(kept: number, conflicts: number): string {
  const k = kept === 1 ? "Kept. Your assistants that can see that page get it now." : kept > 1 ? `Kept ${kept}. Your assistants that can see those pages get them now.` : "";
  const c = conflicts === 1 ? "One differs from what your memory held, so it waits on your home to settle." : conflicts > 1 ? `${conflicts} differ from what your memory held, so they wait on your home to settle.` : "";
  return [k, c].filter(Boolean).join(" ") || GONE;
}

export function keepGuesses(root: string, picks: KeepPick[], now = new Date()): KeepResult {
  const asked = picks.filter((p) => FILE.test(p.file) && SEEN.test(p.seen)).slice(0, KEEP_MAX);
  if (!asked.length) return { kept: 0, conflicts: 0, gone: picks.length, message: GONE };
  const rules = loadRules(root);
  const asks = ownerAsks(root, now);
  const lines = unconfirmedLines(root, rules, new Map(loadBrain(root).map((n) => [n.fm.id, n])), asks);
  const open = new Map(lines.flatMap((l) => (l.keep ? [[l.keep.file, l.keep.seen] as const] : [])));
  let kept = 0, conflicts = 0, gone = 0;
  for (const p of asked) {
    // Not a line now, or not the bytes the home showed: left as it is.
    if (open.get(p.file) !== p.seen) { gone++; continue; }
    // The same value proposed again (a twin on the same card) is answered with it, each weighed
    // with every check, so the line doesn't come back as another Not confirmed line.
    // Only a twin the same assistant saved, not a capture or a pull, its own words not shaped like
    // health, legal or money (slice audit of G941): what the line said, said again.
    const card = inboxCards(root).find((c) => c.file === p.file);
    const twins = (card?.twins ?? []).filter((t) => {
      const d = t.doc as { by?: unknown; capture?: unknown; pulled_from?: unknown; request?: { id?: string; title?: string; attribute?: string; value?: unknown; text?: unknown } };
      const r = d.request ?? {};
      return d.by !== undefined && d.by === (card!.doc as { by?: unknown }).by && d.capture === undefined && d.pulled_from === undefined && !sensitiveShape(rules, r.id, r.title, r.attribute ?? "", r.value, typeof r.text === "string" ? r.text : undefined);
    }).map((t) => t.file);
    const r = decideProposal(root, p.file, "accept", OWNER, twins, { seen: p.seen });
    if (r.outcome === "committed" || r.outcome === "noop") kept++;
    else if (r.outcome === "disputed") conflicts++;
    else gone++;
  }
  gone += picks.length - asked.length;
  return { kept, conflicts, gone, message: keptWords(kept, conflicts) };
}
