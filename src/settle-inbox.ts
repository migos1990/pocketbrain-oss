// SPDX-License-Identifier: AGPL-3.0-only
// Conflicts that wait in the inbox (review thread, audit v4): the write path hands some
// contradictions to the owner as a proposal instead of a dispute (a page holding a private record,
// a value the owner confirmed, a capture that changes one). Each open proposal whose value differs
// from the fact's live value is a conflict on the owner's home and settle screen, in the same shape
// as a dispute (core.ts SettleCase). Picking the live value drops the proposal, picking the new one
// accepts it (at its source's rank, with the tap recorded), and a typed value is the owner's word.
import { loadBrain, isDisputed, isList, sensitivityRank, type FactRecord } from "./brain";
import { records } from "./carve";
import { compareKey } from "./normalize";
import { sourceKind } from "./diary";
import { inboxCards, decideProposal, write } from "./write";
import { OWNER, OWNER_CONFIRMED, ownerRef } from "./owner";
import { today } from "./brain";
import { CoreError, type SettleCase } from "./core";

export interface InboxConflict extends SettleCase { file: string }

const idOf = (file: string) => `p-${file.replace(/\.yaml$/, "")}`;

export function inboxConflicts(root: string): InboxConflict[] {
  const notes = loadBrain(root, { shared: true });
  const out: InboxConflict[] = [];
  for (const card of inboxCards(root)) {
    const req = card.doc.request;
    if (!req?.id || !req.attribute || (req as { retract?: boolean }).retract || req.value === undefined) continue;
    const note = notes.find((n) => n.fm.id === req.id);
    const f = note?.fm.facts?.[req.attribute];
    if (!note || !f || isDisputed(f) || isList(f)) continue;
    const live = records(f).find((r) => !r.valid_to && !r.retired);
    if (!live || compareKey(live.value) === compareKey(req.value)) continue;
    const incoming = { sources: req.sources ?? [], verification: req.verification } as Pick<FactRecord, "sources" | "verification">;
    out.push({
      ...(sensitivityRank(live.sensitivity ?? note.fm.sensitivity) >= sensitivityRank("private") || sensitivityRank(req.sensitivity ?? note.fm.sensitivity) >= sensitivityRank("private") ? { private: true } : {}),
      id: idOf(card.file), file: card.file, fact_key: `${note.fm.id}#${req.attribute}`, page: note.fm.id, title: String(note.fm.title ?? note.fm.id), attr: req.attribute,
      sides: [
        { n: 1, value: live.value, as_of: live.as_of, source_word: sourceKind(live), by: String(live.by ?? ""), sources: Math.max(1, (live.sources ?? []).length) },
        { n: 2, value: req.value, as_of: req.as_of, source_word: sourceKind(incoming), by: String(req.agent ?? card.doc.by ?? ""), sources: Math.max(1, (req.sources ?? []).length) },
      ],
    });
  }
  return out;
}

export const inboxConflict = (root: string, id: string) => inboxConflicts(root).find((c) => c.id === id);

// n 1 keeps the live value (the proposal is dropped), n 2 takes the new one; a typed value is the
// owner's own word and the proposal is dropped.
export function settleInbox(root: string, id: string, choice: { n?: number; typed?: string }): void {
  const c = inboxConflict(root, id);
  if (!c) throw new CoreError(409, "nothing to settle there any more");
  if (choice.typed) {
    const r = write(root, { agent: OWNER, id: c.page, attribute: c.attr, value: choice.typed, as_of: today(), sources: [ownerRef(today(), `settle-${id}`)], verification: OWNER_CONFIRMED } as never, { owner: true });
    if (r.outcome !== "committed" && r.outcome !== "noop") throw new CoreError(409, r.message);
    decideProposal(root, c.file, "reject");
    return;
  }
  const r = decideProposal(root, c.file, choice.n === 2 ? "accept" : "reject");
  if (r.outcome === "refused") throw new CoreError(409, r.message);
}
