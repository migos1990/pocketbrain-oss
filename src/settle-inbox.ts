// SPDX-License-Identifier: AGPL-3.0-only
// Conflicts that wait in the inbox (review thread, audit v4): the write path hands some
// contradictions to the owner as a proposal instead of a dispute (a page holding a private record,
// a value the owner confirmed, a capture that changes one). Each open proposal whose value differs
// from the fact's live value is a conflict on the owner's home and settle screen, in the same shape
// as a dispute (core.ts SettleCase). Picking the live value drops the proposal, picking the new one
// accepts it (at its source's rank, with the tap recorded), and a typed value is the owner's word.
import { loadBrain, isDisputed, isList, sensitivityRank, type FactRecord } from "./brain";
import { followArea } from "./area-follow";
import { records } from "./carve";
import { sensitiveShape } from "./shape";
import { loadRules } from "./rules";
import { compareKey } from "./normalize";
import { refString } from "./sources";
import { sourceKind } from "./diary";
import { inboxCards, decideProposal, resolveEntity, write } from "./write";
import { OWNER, OWNER_CONFIRMED, ownerRef } from "./owner";
import { today } from "./brain";
import { CoreError, type SettleCase } from "./core";

export interface InboxConflict extends SettleCase { file: string }

const idOf = (file: string) => `p-${file.replace(/\.yaml$/, "")}`;

export function inboxConflicts(root: string): InboxConflict[] {
  const notes = loadBrain(root, { shared: true }), rules = loadRules(root);
  const out: InboxConflict[] = [];
  for (const card of inboxCards(root)) {
    const req = card.doc.request;
    if (!req?.attribute || (req as { retract?: boolean }).retract || req.value === undefined) continue;
    // A proposal by name lands where the write path would put it, as filing weighs it (G622); a
    // name that fits no page or more than one is no conflict here.
    const named = req as { title?: unknown; type?: unknown };
    const id = req.id ?? (typeof named.title === "string" && typeof named.type === "string" ? resolveEntity(notes, named.type, named.title).id : undefined);
    if (!id) continue;
    const note = notes.find((n) => n.fm.id === id);
    const f = note?.fm.facts?.[req.attribute];
    if (!note || !f || isDisputed(f) || isList(f)) continue;
    const live = records(f).find((r) => !r.valid_to && !r.retired);
    if (!live || compareKey(live.value) === compareKey(req.value)) continue;
    const incoming = { sources: req.sources ?? [], verification: req.verification } as Pick<FactRecord, "sources" | "verification">;
    out.push({
      // Private as the page and the fact are now (G583 and its slice audit): the page, any live
      // record, the proposal's level, or a value or attribute shaped like money, health or legal.
      ...([note.fm.sensitivity, live.sensitivity, req.sensitivity].some((x) => !!x && sensitivityRank(x) >= sensitivityRank("private")) || records(f).some((r) => !r.valid_to && (r.unseen || (!!r.sensitivity && sensitivityRank(r.sensitivity) >= sensitivityRank("private")))) || !!sensitiveShape(rules, req.attribute, live.value, req.value) ? { private: true } : {}),
      id: idOf(card.file), file: card.file, fact_key: `${note.fm.id}#${req.attribute}`, page: note.fm.id, title: String(note.fm.title ?? note.fm.id), attr: req.attribute,
      sides: [
        { n: 1, value: live.value, as_of: live.as_of, source_word: sourceKind(live), by: String(live.by ?? ""), sources: Math.max(1, (live.sources ?? []).length), refs: (live.sources ?? []).map(refString) },
        { n: 2, value: req.value, as_of: req.as_of, source_word: sourceKind(incoming), by: String(req.agent ?? card.doc.by ?? ""), sources: Math.max(1, (req.sources ?? []).length), refs: (req.sources ?? []).map(refString) },
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
    // A value the owner typed is the owner's word: a workplace moves the page with it (G664).
    if (r.outcome === "committed") followArea(root, loadRules(root), r.fact_key);
    decideProposal(root, c.file, "reject");
    return;
  }
  const r = decideProposal(root, c.file, choice.n === 2 ? "accept" : "reject");
  if (r.outcome === "refused") throw new CoreError(409, r.message);
}
