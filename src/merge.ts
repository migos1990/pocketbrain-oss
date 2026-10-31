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
// Names and tags: the dropped title, aliases and tags go to the kept note, unless the dropped
// note is more sensitive than the kept one (a name can be the secret, a tag can widen a slice);
// those are listed.
// Refused, before anything is written (`mergeBlocked`): notes in different areas, a dropped note or
// fact that an exclude in the rules names, any open dispute on either note (list items included),
// two notes some agent sees differently (`carveParity`, the deciding rule), and any
// agent that would read on the kept note a value or name it can't read today
// (`mergeLeaks`: both notes carved for every agent before and after the merge).
import type { FactRecord, Fact, Note } from "./brain";
import { loadBrain, saveNote, today, isDisputed, isList, sensitivityRank } from "./brain";
import { loadRules, type Rules } from "./rules";
import { carve, grantFor, mergedTarget, records, valueStrings, visibleFacts, type CarveResult } from "./carve";
import { fgaConfirmsAll } from "./fga";
import { renderNote, needlesOf } from "./view";
import { cellText, mayReadDifferently } from "./cell";
import { withTokenRole, READER_CEILING } from "./tokenrole";
import { compareKey } from "./normalize";
import { squash } from "./match";
import { refString } from "./sources";
import { openDispute } from "./upkeep";
import { git } from "./git";
import { OWNER } from "./owner";

// Why `drop` can't merge into `keep`, in plain words, or undefined. A merge moves the dropped
// note's facts under the kept note's id, area and tags, so anything the rules keep apart would
// reach an agent the rules hide it from; and an open dispute (on a fact or a list item, G155)
// would be answered on a note that no longer exists. Areas and excludes by name (G150-G152) are
// named first in their own words; carveParity (G204-G206) decides, and the before/after render
// check (mergeLeaks, G168-G169, G199-G200) is a second layer.
// `notes`: the brain, for the merged notes that already point at either one (G246); the rendered
// check carves them with the pair, as the merge leaves them.
export function mergeBlocked(rules: Rules, keep: Note, drop: Note, rulesAfter?: Rules, notes: Note[] = []): string | undefined {
  if ((keep.fm.area ?? "") !== (drop.fm.area ?? ""))
    return `the notes are in different areas (${[keep.fm.area ?? "none", drop.fm.area ?? "none"].sort().join(", ")}); move one first`;
  const names = (ex?: string[]) => (ex ?? []).some((x) => x === drop.fm.id || x.startsWith(`${drop.fm.id}#`));
  const where = [
    ...Object.entries(rules.policy.agents ?? {}).filter(([, a]) => names(a.exclude)).map(([n]) => `${n}'s exclude in policy.yaml`),
    ...Object.entries(rules.slices ?? {}).filter(([, s]) => names(s.exclude)).map(([n]) => `slice ${n}`),
  ];
  if (where.length)
    return `your rules hide ${drop.fm.title} or one of its facts by name (${where.join(", ")}), and a merge would show it under ${keep.fm.title}; change the exclude first`;
  const open = [keep, drop].flatMap((n) => Object.entries(n.fm.facts ?? {})
    .filter(([, f]) => isDisputed(f) || (isList(f) && f.items.some((i) => typeof (i as FactRecord & { dispute?: unknown }).dispute === "string")))
    .map(([a]) => `${n.fm.title}'s ${a}`));
  if (open.length) return `${[...new Set(open)].join(", ")} ${open.length === 1 ? "is" : "are"} disputed; settle it first`;
  return fgaUnconfirmed([rules, rulesAfter ?? rules]) ?? carveParity(rules, keep, drop) ?? mergeLeaks(rules, keep, drop, rulesAfter, pointersInto(notes, keep, drop), elsewhere(notes, keep, drop), otherTitleWords(notes, keep, drop));
}

// The merge checks carve as each agent reads now, and with OpenFGA on that read goes through the
// hub's FGA copy (src/fga.ts), which fails closed to no slices when stale. An agent left with no
// slices would look like one that sees neither note and pass. So unless FGA confirms every slice
// policy.yaml gives every agent the checks cover, the merge refuses until it catches up (G226).
function fgaUnconfirmed(sets: Rules[]): string | undefined {
  const behind = new Set<string>();
  for (const rules of sets) {
    const extra = [rules.policy.resolver, rules.policy.owner_channel].filter((x): x is string => !!x);
    for (const agent of new Set([...Object.keys(rules.policy.agents ?? {}), ...extra])) {
      const a = rules.policy.agents?.[agent];
      if (a && !fgaConfirmsAll(agent, a.slices ?? [], a.inside_wall)) behind.add(agent);
    }
  }
  if (!behind.size) return undefined;
  const who = [...behind].sort();
  return `OpenFGA hasn't confirmed lately what ${who.join(", ")} may read, so these checks can't tell who sees the notes; try again once it has caught up`;
}

// The rule that decides a merge (round-3 audit, G204-G206): every assistant must see the two notes
// the same way. For each agent in policy.yaml (the resolver and the owner's text channel too):
// it sees both notes or neither; if both, with the same body access and the same attribute set,
// and nothing hidden on either note except attributes that set leaves out of both (which stay out
// of the merged note the same way). Hidden by name, by share_with or by a fact's sensitivity
// refuses, and so does a name the merge would hold back (the notes differ in sensitivity). When
// the merge would open a dispute, the resolver and the owner's text channel must see both notes
// whole: the packet shows them both values. An agent that sees neither note is untouched: links
// to either stay [[redacted]] after upkeep repoints them, and aliases of either stay scrubbed.
// mergeLeaks then checks the rendered views as a second layer.
// Who reads the brain, for the merge checks: every agent in policy.yaml (and the resolver and the
// owner's text channel), each also as a reader token (G218), which reads its slice capped below
// private (src/tokenrole.ts); a reader view that can't differ from the agent's own is skipped.
interface Viewer { agent: string; label: string; role?: "reader" }
function viewers(rules: Rules, extra: string[] = []): Viewer[] {
  const out: Viewer[] = [];
  for (const agent of [...new Set([...Object.keys(rules.policy.agents ?? {}), ...extra])]) {
    out.push({ agent, label: agent });
    const own = grantFor(rules, agent).ceiling;
    if (sensitivityRank(own) > sensitivityRank(READER_CEILING)) out.push({ agent, label: `${agent} (reader token)`, role: "reader" });
  }
  return out;
}
const asViewer = <T>(v: Viewer, fn: () => T): T => withTokenRole(v.agent, v.role, fn);

export function carveParity(rules: Rules, keep: Note, drop: Note): string | undefined {
  const { r } = planMerge(keep, drop, () => "c-merge-check");
  const resolvers = new Set([rules.policy.resolver, rules.policy.owner_channel ?? rules.policy.resolver].filter((x): x is string => !!x));
  const attrNames = [...new Set([keep, drop].flatMap((n) => Object.keys(n.fm.facts ?? {})))];
  const uneven: string[] = [];
  const limited = new Set<string>(); // notes holding a private or share_with-limited fact some viewer can't see
  for (const viewer of viewers(rules, [...resolvers])) {
    const agent = viewer.agent;
    let ok = true;
    try {
      const res = asViewer(viewer, () => carve([keep, drop], rules, grantFor(rules, agent), { flags: false }));
      const a = res.visible.get(keep.fm.id), b = res.visible.get(drop.fm.id);
      const hidden = (id: string) => res.hiddenFacts.filter((h) => h.key.startsWith(`${id}#`));
      const attrs = (v: typeof a) => v!.attributes === "all" ? "all" : [...v!.attributes].sort().join(",");
      // An attribute the slices leave out of a note (only_attributes, exclude_attributes), whether
      // the note holds it or not: the same names on both notes (G219), so nothing hidden on one
      // lands where the same attribute shows.
      const scopedOut = (v: NonNullable<typeof a>) => attrNames.filter((x) => (v.attributes !== "all" && !v.attributes.has(x))
        || v.slices.some((sn) => rules.slices[sn]?.exclude_attributes?.includes(x))).sort().join(",");
      if (!a !== !b) ok = false;
      else if (a && b) {
        const hid = [...hidden(keep.fm.id), ...hidden(drop.fm.id)];
        const other = hid.filter((h) => !/^attribute (not in slice|excluded in slice)/.test(h.reason));
        if (a.body !== b.body || attrs(a) !== attrs(b) || scopedOut(a) !== scopedOut(b)) ok = false;
        else if (other.length) {
          // A fact hidden by its sensitivity or share_with is named as the note's fact, not as this viewer.
          for (const h of other) if (/^(do not share|fact is )/.test(h.reason)) limited.add(h.key.startsWith(`${keep.fm.id}#`) ? keep.fm.title : drop.fm.title);
          if (other.some((h) => !/^(do not share|fact is )/.test(h.reason))) ok = false;
          else continue;
        }
        else if (r.namesHeld.length) ok = false;
        else if (r.disputes.length && resolvers.has(agent) && hid.length) ok = false;
      } else if (r.disputes.length && resolvers.has(agent)) ok = false; // the resolver must see the packet's notes
    } catch { ok = false; } // a grant that can't be carved fails closed
    if (!ok) uneven.push(viewer.label);
  }
  // The usual cause, named plainly: a fact kept from some assistants (private, or share_with) can't
  // be shown under the merged note to exactly those who saw it before, so the pair waits for the owner.
  const parts: string[] = [];
  if (limited.size) {
    const t = [...limited].sort();
    parts.push(`${t.join(" and ")} ${t.length === 1 ? "has a fact" : "have facts"} some assistants can't see (private or shared with only some); the owner can merge these by hand later`);
  }
  if (uneven.length) parts.push(`${uneven.join(", ")} ${uneven.length === 1 ? "sees" : "see"} one of these notes but not the other (or not all of it); make their access the same first`);
  return parts.length ? parts.join("; also, ") : undefined;
}

export interface MergeResult { ok: boolean; message: string; moved: string[]; merged: string[]; disputes: string[]; namesHeld: string[]; tagsHeld: string[] }

// The merge itself, on copies: the kept note with the dropped note's facts, names and tags, and
// the dropped note as a pointer. Pure apart from `dispute`, which names the packet for a fact the
// two notes disagree on (mergeNotes opens a real one; the leak check uses a placeholder), so the
// check and the real merge build exactly the same notes.
export function planMerge(keepIn: Note, dropIn: Note, dispute: (keep: Note, attr: string, cands: FactRecord[]) => string): { keep: Note; drop: Note; r: MergeResult } {
  const keep = structuredClone(keepIn), drop = structuredClone(dropIn);
  const keepId = keep.fm.id, dropId = drop.fm.id;
  const r: MergeResult = { ok: true, message: "", moved: [], merged: [], disputes: [], namesHeld: [], tagsHeld: [] };
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
    const id = dispute(keep, attr, [a, b]);
    facts[attr] = { dispute: id, candidates: [a, b] };
    r.disputes.push(`${key} -> ${id}`);
  }

  const names = [drop.fm.title, ...(drop.fm.aliases ?? [])].filter((n) => ![keep.fm.title, ...(keep.fm.aliases ?? [])].some((k) => compareKey(k) === compareKey(n)));
  const tags = (drop.fm.tags ?? []).filter((t) => !(keep.fm.tags ?? []).includes(t));
  // A more private note's tags stay behind with its names (G153): a slice selecting the tag would
  // otherwise start showing the kept note. (A slice that excludes the tag is the leak check's job.)
  if (dropHigher) { r.namesHeld = names; r.tagsHeld = tags; }
  else {
    if (names.length) keep.fm.aliases = [...(keep.fm.aliases ?? []), ...names];
    if (tags.length) keep.fm.tags = [...(keep.fm.tags ?? []), ...tags];
  }
  keep.fm.updated = today();
  drop.fm.status = "merged";
  drop.fm.merged_into = keepId;
  drop.fm.updated = today();
  return { keep, drop, r };
}

// What an agent reads of a note, from the same render agents get (renderNote in src/view.ts), as
// units to compare. The note-level lines (heading, type, area, aliases, banners, the standing
// line) and the body are compared line by line, with only what the merge itself renames ignored:
// either note's id and title in the heading, and the updated date. Facts are compared record by
// record keyed by their attribute (value, as_of, valid_to and each source ref separately), so a
// record whose sources the merge combined still matches what was read on the two notes, and a
// value shown under one attribute never vouches for another (G199).
const valueKey = (v: unknown) => typeof v === "string" ? compareKey(v) : JSON.stringify(v);
function factTokens(attr: string, f: Fact): string[] {
  const out: string[] = [];
  for (const r of records(f)) {
    const k = `fact:${attr}=${valueKey(r.value)}`;
    out.push(k, `${k}|as_of:${r.as_of ?? ""}`, `${k}|valid_to:${r.valid_to ?? ""}`, `${k}|verification:${r.verification ?? ""}`, ...(r.sources ?? []).map((x) => `${k}|src:${refString(x)}`));
  }
  return out;
}
function seenUnits(res: CarveResult, rules: Rules, id: string, pair: Note[]): Set<string> {
  const v = res.visible.get(id);
  const out = new Set<string>();
  if (!v) return out;
  const lines = renderNote(v, res, rules);
  const facts = visibleFacts(v, res);
  // renderNote: [heading, meta, ...banners, standing?] then "" + fact lines, then "" + the body.
  const firstGap = lines.indexOf("");
  const head = firstGap < 0 ? lines : lines.slice(0, firstGap);
  const rest = firstGap < 0 ? [] : lines.slice(firstGap + 1);
  const bodyAt = facts.length ? rest.indexOf("") : 0;
  const body = facts.length ? (bodyAt < 0 ? [] : rest.slice(bodyAt + 1)) : rest;
  const renamed = (l: string) => pair.reduce((x, n) => x.split(`\`${n.fm.id}\``).join("`_`").split(`### ${n.fm.title} `).join("### _ "), l);
  head.forEach((l, i) => {
    if (i === 0) { out.add(`line:${renamed(l)}`); return; }
    if (i === 1) {
      // The meta line: one unit per alias (the merge appends names), the updated date ignored.
      const [main, also] = l.split(" · also: ");
      out.add(`line:${main.replace(/ · updated [^ ·]*/, " · updated _")}`);
      for (const a of also ? also.split(", ") : []) out.add(`name:${compareKey(a)}`);
      return;
    }
    out.add(`line:${l}`);
  });
  out.add(`name:${compareKey(v.note.fm.title)}`);
  for (const l of body.join("\n").split("\n")) out.add(`body:${l}`);
  for (const [attr, f] of facts) for (const t of factTokens(attr, f)) out.add(t);
  return out;
}

// The second layer (G168, G169, G199, G200), after carveParity: carve both notes for every agent in policy.yaml
// (collaborators included) before the merge and after it, built by planMerge, and render what
// each agent would read. Refused when the kept note comes into an agent's view that couldn't see
// it before (its id, links, dates, body and standing with it), or when anything in the merged
// note's render isn't in what the agent read of the two notes today; whatever made the difference
// (areas, tags and exclude_tags, include, since/until, excludes, share_with, ceilings).
// `rulesAfter`: the rules as the merge leaves them (sameperson.ts moves a standing entry).
// Merged notes whose chain ends at either note (the pointers a merge of the two carries along).
export function pointersInto(notes: Note[], keep: Note, drop: Note): Note[] {
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  byId.set(keep.fm.id, keep); byId.set(drop.fm.id, drop);
  return notes.filter((n) => n.fm.status === "merged" && n.fm.id !== keep.fm.id && n.fm.id !== drop.fm.id
    && [keep.fm.id, drop.fm.id].includes(mergedTarget(n, byId) ?? ""));
}
// Every value and alias, lowercased, on notes other than the pair: the strings carve may take out
// of an agent's prose when it no longer sees them shown (G261).
const elsewhereCache = new WeakMap<Note[], Map<string, number>>();
function elsewhere(notes: Note[], keep: Note, drop: Note): Set<string> {
  let counts = elsewhereCache.get(notes);
  if (!counts) {
    counts = new Map();
    for (const n of notes) for (const x of noteStrings(n)) counts.set(x, (counts.get(x) ?? 0) + 1);
    elsewhereCache.set(notes, counts);
  }
  // Strings held by the pair itself (as the brain has them) don't count as elsewhere.
  const own = new Map<string, number>();
  for (const n of notes) if (n.fm.id === keep.fm.id || n.fm.id === drop.fm.id) for (const x of noteStrings(n)) own.set(x, (own.get(x) ?? 0) + 1);
  return new Set([...counts].filter(([x, c]) => c > (own.get(x) ?? 0)).map(([x]) => x));
}
function noteStrings(n: Note): Set<string> {
  const out = new Set<string>();
  for (const a of n.fm.aliases ?? []) out.add(a.toLowerCase());
  for (const f of Object.values(n.fm.facts ?? {})) for (const v of valueStrings(f)) out.add(v.toLowerCase());
  return out;
}
// The words (squashed, as shownWords in carve.ts counts them) of other notes' multi-word values and
// aliases: a carved one whose words are all shown gets no word-pair parts (needleFor), so a word
// leaving the shown set can make it withhold whole lines of prose it didn't before (G265).
function elsewhereWords(others: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const x of others) { const ws = x.split(/[^\p{L}\p{N}]+/u).filter(Boolean); if (ws.length > 1) for (const w of ws) out.add(squash(w)); }
  return out;
}
// Words in other notes' titles. A word one of them holds most likely stays shown after the merge,
// so the proposal doesn't name it; the backstop in mergeNotes checks what each agent really reads.
const titleCache = new WeakMap<Note[], Map<string, number>>();
function otherTitleWords(notes: Note[], keep: Note, drop: Note): Set<string> {
  let counts = titleCache.get(notes);
  const words = (n: Note) => new Set(n.fm.title.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(squash));
  if (!counts) {
    counts = new Map();
    for (const n of notes) if (n.fm.status !== "merged") for (const w of words(n)) counts.set(w, (counts.get(w) ?? 0) + 1);
    titleCache.set(notes, counts);
  }
  const own = new Map<string, number>();
  for (const n of notes) if ((n.fm.id === keep.fm.id || n.fm.id === drop.fm.id) && n.fm.status !== "merged") for (const w of words(n)) own.set(w, (own.get(w) ?? 0) + 1);
  return new Set([...counts].filter(([w, c]) => c > (own.get(w) ?? 0)).map(([w]) => w));
}
// The words a note counts toward shownWords for an agent: its title and the facts it is shown.
function titleFactWords(res: CarveResult, id: string): Set<string> {
  const v = res.visible.get(id);
  const out = new Set<string>();
  if (!v) return out;
  const add = (t: string) => { for (const w of t.split(/[^\p{L}\p{N}]+/u)) if (w) out.add(squash(w)); };
  add(v.note.fm.title);
  for (const [, f] of visibleFacts(v, res)) for (const x of valueStrings(f)) add(x);
  return out;
}

// The values and names an agent reads on a note, each as written (lowercased only).
function shownStrings(res: CarveResult, id: string): Set<string> {
  const v = res.visible.get(id);
  const out = new Set<string>();
  if (!v) return out;
  for (const [, f] of visibleFacts(v, res)) for (const x of valueStrings(f)) out.add(x.toLowerCase());
  for (const a of [v.note.fm.title, ...(v.note.fm.aliases ?? [])]) out.add(a.toLowerCase());
  return out;
}

// A pointer into the dropped note points at the kept one after the merge (mergeNotes rewrites it).
function repointed(p: Note, dropId: string, keepId: string): Note {
  if (String(p.fm.merged_into ?? "") !== dropId) return p;
  const c = structuredClone(p);
  c.fm.merged_into = keepId;
  return c;
}

export function mergeLeaks(rules: Rules, keep: Note, drop: Note, rulesAfter: Rules = rules, pointers: Note[] = [], others: Set<string> = new Set(), titled: Set<string> = new Set()): string | undefined {
  const { keep: after, drop: pointer } = planMerge(keep, drop, () => "c-merge-check");
  const ptrsAfter = pointers.map((p) => repointed(p, drop.fm.id, keep.fm.id));
  const fromDrop = new Set([`name:${compareKey(drop.fm.title)}`, ...(drop.fm.aliases ?? []).map((a) => `name:${compareKey(a)}`), ...Object.entries(drop.fm.facts ?? {}).flatMap(([a, f]) => factTokens(a, f))]);
  const pair = [keep, drop];
  const newlyShown: string[] = [], sees: string[] = [], scrubs: string[] = [], spelled = new Set<string>(), wordsGone = new Set<string>();
  const otherWords = elsewhereWords(others);
  let ownToo = false;
  for (const viewer of viewers(rules)) {
    const agent = viewer.agent;
    let wasKeep: Set<string>, was: Set<string>, now: Set<string>, unscrubbed: string[], newlyScrubbed: string[];
    try {
      const before = asViewer(viewer, () => carve([keep, drop, ...pointers], rules, grantFor(rules, agent), { flags: false }));
      const afterRes = asViewer(viewer, () => carve([after, pointer, ...ptrsAfter], rulesAfter, grantFor(rulesAfter, agent), { flags: false }));
      wasKeep = asViewer(viewer, () => seenUnits(before, rules, keep.fm.id, pair));
      was = new Set([...wasKeep, ...asViewer(viewer, () => seenUnits(before, rules, drop.fm.id, pair))]);
      now = asViewer(viewer, () => seenUnits(afterRes, rulesAfter, keep.fm.id, pair));
      // What was scrubbed from the agent's prose before stays scrubbed (G217): a value carved
      // out of the two notes today must still be carved out after the merge.
      const still = new Set(afterRes.carvedValues);
      unscrubbed = before.carvedValues.filter((x) => !still.has(x));
      // Nor is anything scrubbed after that wasn't before (G247): a name or value the agent reads
      // in other notes today never turns into [withheld] because two notes it may not read merged.
      const was0 = new Set(before.carvedValues);
      newlyScrubbed = afterRes.carvedValues.filter((x) => !was0.has(x));
      // The merge keeps one spelling of values equal under compareKey ("Café Roy", "Cafe Roy").
      // A spelling the agent reads on the pair today and won't after stops counting as shown, so the
      // same string elsewhere in the brain (another note's alias, a hidden fact) could start being
      // withheld from its prose (G261). mergeNotes checks the whole brain before it writes.
      const shownAfter = shownStrings(afterRes, keep.fm.id);
      const lost = [...shownStrings(before, keep.fm.id), ...shownStrings(before, drop.fm.id)].filter((x) => !shownAfter.has(x) && others.has(x));
      if (lost.length) { for (const x of lost) spelled.add(x); newlyScrubbed.push(...lost); }
      // A title's words count as shown; the dropped title becomes only an alias of the kept note,
      // and aliases don't (shownWords). A word another note's name holds stops being shown (G265).
      const wordsAfter = titleFactWords(afterRes, keep.fm.id);
      const gone = [...new Set([...titleFactWords(before, keep.fm.id), ...titleFactWords(before, drop.fm.id)])].filter((w) => !wordsAfter.has(w) && otherWords.has(w) && !titled.has(w));
      if (gone.length) { for (const w of gone) wordsGone.add(w); newlyScrubbed.push(...gone); }
    } catch { sees.push(viewer.label); continue; } // a grant that can't be carved fails closed
    if (newlyScrubbed.length) scrubs.push(viewer.label);
    if (now.size && !wasKeep.size) { newlyShown.push(viewer.label); continue; }
    const fresh = [...now].filter((x) => !was.has(x));
    if (!fresh.length && !unscrubbed.length) continue;
    sees.push(viewer.label);
    // A moved standing line travels with the dropped note's entry; anything else new that the
    // dropped note doesn't hold comes from the kept note itself.
    if (fresh.some((x) => /^(fact|name|body):/.test(x) && !fromDrop.has(x))) ownToo = true;
  }
  const they = (xs: string[]) => (xs.length === 1 ? "it" : "they");
  const parts = [
    newlyShown.length ? `${newlyShown.join(", ")} would see ${keep.fm.title}, which ${they(newlyShown)} can't see today` : "",
    sees.length ? `${sees.join(", ")} would see facts or names from ${drop.fm.title}${ownToo && keep.fm.title !== drop.fm.title ? ` or ${keep.fm.title}` : ""} ${they(sees)} can't see today` : "",
    scrubs.length ? `${scrubs.join(", ")} would find names or values of these notes newly [withheld] in notes ${scrubs.length === 1 ? "it reads" : "they read"} today${spelled.size ? ` (the merge keeps one spelling of ${[...spelled].map((x) => `"${x}"`).join(", ")}, which other notes also hold; make the two notes spell it the same first)` : ""}${wordsGone.size ? ` (${drop.fm.title} would be only a name on ${keep.fm.title}, so ${[...wordsGone].map((x) => `"${x}"`).join(", ")} would no longer count as shown, and another note's name holds ${wordsGone.size === 1 ? "it" : "them"})` : ""}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join("; ")}; change the slices or move the note first` : undefined;
}

// The backstop, run by mergeNotes before it writes anything (G261, G265): for every agent (and its
// reader token, the resolver and the owner's text channel), carve the whole brain as it is and as
// the merge would leave it, and render every other note it reads both ways, as the view and read
// path give it (renderNote) and as its cell holds it (cellText), each note the cell update test
// says could change (mayReadDifferently; all of them when it can't tell). Any difference refuses;
// so does a change in the prose needles (needlesOf, with their word-pair parts). Links to the
// dropped note count as links to the kept one, which is what the merge (and upkeep) makes them.
export function brainChanges(rules: Rules, notes: Note[], keep: Note, drop: Note): string | undefined {
  const plan = planMerge(keep, drop, () => "c-merge-check");
  const after = notes.map((n) => n.fm.id === keep.fm.id ? plan.keep : n.fm.id === drop.fm.id ? plan.drop : n.fm.status === "merged" ? repointed(n, drop.fm.id, keep.fm.id) : n);
  const extra = [rules.policy.resolver, rules.policy.owner_channel].filter((x): x is string => !!x);
  const pair = new Set([keep.fm.id, drop.fm.id]);
  const relink = (t: string) => t.split(`[[${drop.fm.id}]]`).join(`[[${keep.fm.id}]]`).split(`[[${drop.fm.id}|`).join(`[[${keep.fm.id}|`).split(`[[${drop.fm.id}#`).join(`[[${keep.fm.id}#`)
    .split(`"${drop.fm.id}"`).join(`"${keep.fm.id}"`);
  const changed: string[] = [];
  const forms = new WeakMap<Note, unknown>();
  for (const viewer of viewers(rules, extra)) {
    try {
      const differs = asViewer(viewer, () => {
        const a = carve(notes, rules, grantFor(rules, viewer.agent), { flags: false });
        const b = carve(after, rules, grantFor(rules, viewer.agent), { flags: false });
        const needles = (r: CarveResult) => needlesOf(r).map((n) => JSON.stringify([n.value, n.squashed, n.digits ?? "", n.parts])).sort().join("\n");
        if (needles(a) !== needles(b)) return true;
        if ([...a.carvedValues].sort().join("\0") !== [...b.carvedValues].sort().join("\0")) return true;
        const ids = new Set([...a.visible.keys(), ...b.visible.keys()].filter((id) => !pair.has(id)));
        // Only notes that can read differently are rendered (the same test that keeps cells in
        // step with the brain, src/cell.ts); a change it can't bound renders them all.
        const may = mayReadDifferently(a, b, forms);
        for (const id of ids) {
          const va = a.visible.get(id), vb = b.visible.get(id);
          if (!va || !vb) return true;
          if (!may(id, va.note)) continue;
          if (relink(renderNote(va, a, rules).join("\n")) !== renderNote(vb, b, rules).join("\n")) return true;
          if (relink(cellText(va, viewer.agent, a)) !== cellText(vb, viewer.agent, b)) return true;
        }
        return false;
      });
      if (differs) changed.push(viewer.label);
    } catch { changed.push(viewer.label); }
  }
  return changed.length ? `${changed.join(", ")} would find other notes changed (a name or value newly [withheld], or no longer); nothing was merged` : undefined;
}

export function mergeNotes(root: string, keepId: string, dropId: string, by = OWNER, opts: { also?: string[] } = {}): MergeResult {
  const notes = loadBrain(root);
  const keep0 = notes.find((n) => n.fm.id === keepId), drop0 = notes.find((n) => n.fm.id === dropId);
  const fail = (message: string): MergeResult => ({ ok: false, message, moved: [], merged: [], disputes: [], namesHeld: [], tagsHeld: [] });
  if (!keep0 || !drop0) return fail(`no note ${!keep0 ? keepId : dropId}`);
  if (keepId === dropId) return fail("a note can't merge into itself");
  if (keep0.fm.type !== drop0.fm.type) return fail(`different types (${keep0.fm.type}, ${drop0.fm.type}); merge only the same kind of thing`);
  if (drop0.fm.status !== "active" || keep0.fm.status !== "active") return fail("both notes must be active");

  const rules = loadRules(root);
  const blocked = mergeBlocked(rules, keep0, drop0, undefined, notes) ?? brainChanges(rules, notes, keep0, drop0);
  if (blocked) return fail(`can't merge: ${blocked}`);

  const { keep, drop, r } = planMerge(keep0, drop0, (k, attr, cands) => openDispute(root, k, attr, cands, `Merging ${dropId} into ${keepId}: the two notes disagree.`));
  saveNote(root, keep);
  saveNote(root, drop);
  // Earlier pointers into the dropped note now point at the kept one, in the same commit (so Undo
  // puts them back with it), unless the file has changes of its own not yet committed (G246; carve
  // follows a chain either way).
  const moved = pointersInto(notes, keep0, drop0).filter((p) => String(p.fm.merged_into ?? "") === dropId
    && !git(root, ["status", "--porcelain", "--", p.path]).trim());
  for (const p of moved) saveNote(root, repointed(p, dropId, keepId));
  // `also`: owner files that change with the merge (standing that follows the person, src/sameperson.ts).
  git(root, ["add", "-A", keep.path, drop.path, ...moved.map((p) => p.path), ...(r.disputes.length ? ["disputes"] : []), ...(opts.also ?? [])]);
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["commit", "-q", "-m", `merge ${dropId} into ${keepId}\n\nKind: merge\nFact-Keys: ${[...r.moved, ...r.merged].join(", ")}`], by);
  if (git(root, ["rev-parse", "HEAD"]) === head) {
    // The commit failed: the notes and the repointed pointers go back to the last commit (G262).
    const paths = [keep.path, drop.path, ...moved.map((p) => p.path)];
    git(root, ["reset", "-q", "--", ...paths]);
    git(root, ["checkout", "--", ...paths]);
    return fail("the merge wasn't saved; nothing changed");
  }
  r.message = `merged ${dropId} into ${keepId}: ${r.moved.length} moved, ${r.merged.length} combined, ${r.disputes.length} disputed${r.namesHeld.length ? `; names not added (the dropped note is ${drop.fm.sensitivity}): ${r.namesHeld.join(", ")}` : ""}${r.tagsHeld.length ? `; tags not added (the dropped note is ${drop.fm.sensitivity}): ${r.tagsHeld.join(", ")}` : ""}. Upkeep repoints links on its next run.`;
  return r;
}
