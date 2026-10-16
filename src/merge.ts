// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain merge <keep> <drop>`: Louis's yes to a possible duplicate (upkeep or the judge
// step). Rules only. The dropped note becomes a pointer (status merged, merged_into), which
// views never show and upkeep's link pass repoints to. Its facts move across:
//   - a fact the kept note lacks moves as-is, with every flag kept, and raised to the dropped
//     note's level when that is higher (a private note's facts never land in a personal note
//     at personal);
//   - the same value merges sources, like a same-value write (conflict step 1);
//   - list items are unioned by value;
//   - a different single value opens a dispute. Merging never picks a winner.
// Names: the dropped title and aliases become aliases of the kept note, unless the dropped
// note is more sensitive than the kept one (a name can be the secret); those are listed.
import type { FactRecord, Fact } from "./brain";
import { loadBrain, saveNote, today, isDisputed, isList, sensitivityRank } from "./brain";
import { compareKey } from "./normalize";
import { refString } from "./sources";
import { openDispute } from "./upkeep";
import { git } from "./git";
import { OWNER } from "./owner";

export interface MergeResult { ok: boolean; message: string; moved: string[]; merged: string[]; disputes: string[]; namesHeld: string[] }

export function mergeNotes(root: string, keepId: string, dropId: string, by = OWNER): MergeResult {
  const notes = loadBrain(root);
  const keep = notes.find((n) => n.fm.id === keepId), drop = notes.find((n) => n.fm.id === dropId);
  const fail = (message: string): MergeResult => ({ ok: false, message, moved: [], merged: [], disputes: [], namesHeld: [] });
  if (!keep || !drop) return fail(`no note ${!keep ? keepId : dropId}`);
  if (keepId === dropId) return fail("a note can't merge into itself");
  if (keep.fm.type !== drop.fm.type) return fail(`different types (${keep.fm.type}, ${drop.fm.type}); merge only the same kind of thing`);
  if (drop.fm.status !== "active" || keep.fm.status !== "active") return fail("both notes must be active");

  const open = Object.keys(drop.fm.facts ?? {}).filter((a) => isDisputed(drop.fm.facts![a]) || (keep.fm.facts?.[a] && isDisputed(keep.fm.facts[a])));
  if (open.length) return fail(`can't merge yet: ${open.map((a) => `${a} is disputed`).join(", ")}; settle it first`);

  const r: MergeResult = { ok: true, message: "", moved: [], merged: [], disputes: [], namesHeld: [] };
  const dropHigher = sensitivityRank(drop.fm.sensitivity) > sensitivityRank(keep.fm.sensitivity);
  const raise = (rec: FactRecord): FactRecord => {
    const lvl = [rec.sensitivity, dropHigher ? drop.fm.sensitivity : undefined].filter(Boolean).sort((a, b) => sensitivityRank(b) - sensitivityRank(a))[0];
    return { ...rec, ...(lvl && sensitivityRank(lvl) > sensitivityRank(keep.fm.sensitivity) ? { sensitivity: lvl } : {}) };
  };
  const addSources = (into: FactRecord, from: FactRecord) => {
    const have = new Set(into.sources.map(refString));
    for (const s of from.sources) if (!have.has(refString(s))) into.sources.push(s);
    if (from.sensitivity && sensitivityRank(from.sensitivity) > sensitivityRank(into.sensitivity ?? keep.fm.sensitivity)) into.sensitivity = from.sensitivity;
    if (from.share_with) into.share_with = into.share_with ? into.share_with.filter((a) => from.share_with!.includes(a)) : from.share_with;
  };
  const facts = (keep.fm.facts ??= {});
  for (const [attr, f] of Object.entries(drop.fm.facts ?? {})) {
    const key = `${keepId}#${attr}`;
    const have: Fact | undefined = facts[attr];
    if (!have) { facts[attr] = isList(f) ? { items: f.items.map(raise) } : raise(f as FactRecord); r.moved.push(key); continue; }
    if (isList(have) && isList(f)) {
      for (const it of f.items) {
        const same = have.items.find((x) => compareKey(x.value) === compareKey(it.value));
        if (same) addSources(same, raise(it)); else have.items.push(raise(it));
      }
      r.merged.push(key);
      continue;
    }
    const a = have as FactRecord, b = raise(f as FactRecord);
    if (compareKey(a.value) === compareKey(b.value)) { addSources(a, b); r.merged.push(key); continue; }
    const id = openDispute(root, keep, attr, [a, b], `Merging ${dropId} into ${keepId}: the two notes disagree.`);
    facts[attr] = { dispute: id, candidates: [a, b] };
    r.disputes.push(`${key} -> ${id}`);
  }

  const names = [drop.fm.title, ...(drop.fm.aliases ?? [])].filter((n) => ![keep.fm.title, ...(keep.fm.aliases ?? [])].some((k) => compareKey(k) === compareKey(n)));
  if (dropHigher) r.namesHeld = names;
  else if (names.length) keep.fm.aliases = [...(keep.fm.aliases ?? []), ...names];
  if ((drop.fm.tags ?? []).length) keep.fm.tags = [...new Set([...(keep.fm.tags ?? []), ...drop.fm.tags!])];
  keep.fm.updated = today();
  drop.fm.status = "merged";
  drop.fm.merged_into = keepId;
  drop.fm.updated = today();
  saveNote(root, keep);
  saveNote(root, drop);
  git(root, ["add", "-A", keep.path, drop.path, ...(r.disputes.length ? ["disputes"] : [])]);
  git(root, ["commit", "-q", "-m", `merge ${dropId} into ${keepId}\n\nKind: merge\nFact-Keys: ${[...r.moved, ...r.merged].join(", ")}`], by);
  r.message = `merged ${dropId} into ${keepId}: ${r.moved.length} moved, ${r.merged.length} combined, ${r.disputes.length} disputed${r.namesHeld.length ? `; names not added (the dropped note is ${drop.fm.sensitivity}): ${r.namesHeld.join(", ")}` : ""}. Upkeep repoints links on its next run.`;
  return r;
}
