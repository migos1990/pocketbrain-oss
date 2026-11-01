// SPDX-License-Identifier: AGPL-3.0-only
// The slice compiler (architecture 0.7): an agent's grant is the union of its slices,
// minus agent-level excludes, capped by its tier's sensitivity ceiling. The result is a
// list of visible notes, each with the attributes and body it may show.
import type { Note, Fact, FactRecord, Sensitivity } from "./brain";
import { isDisputed, isList, sensitivityRank, linksIn, deepFreeze } from "./brain";
import type { Rules, Slice } from "./rules";
import { tierOf, attributeSpec } from "./rules";
import { factFreshness } from "./freshness";
import { confirmSlices } from "./fga";
import { refString } from "./sources";
import { squash, distinctive, needleFor, findCarried, withholdIn, type Needle } from "./match";
import { categoryWords } from "./checks";
import { escapeRe, hasWord, tokenIndex, wordSet, dateWordForms } from "./util";
import { capForRole } from "./tokenrole";

export interface Grant {
  agent: string;
  slices: string[];
  exclude_types: string[];
  exclude: string[];
  ceiling: Sensitivity;
}

export interface Visible {
  note: Note;
  attributes: Set<string> | "all";
  body: boolean;
  slices: string[];
}

export interface Excluded {
  id: string;
  reason: string;
  purposeful?: true; // left out on purpose (type, name, sensitivity), not just outside the grant; its values are carved
}

export interface Flag {
  id: string;
  kind: "links-to-excluded" | "carved-value-in-view" | "category-mention";
  detail: string;
}

export interface CarveResult {
  grant: Grant;
  visible: Map<string, Visible>;
  excluded: Excluded[];
  hiddenFacts: { key: string; reason: string }[];
  flags: Flag[];
  notShared: string[]; // excluded types to announce in the view header
  carvedValues: string[]; // values carved out on purpose; scrubbed from any prose the agent gets
  // Each merged note's final target (mergedTarget), so a link to the pointer renders as a link to
  // the note it became when the agent sees that note, and [[redacted]] otherwise (linkFor).
  mergedTo?: Map<string, string>;
}

// The id a link to `id` shows the agent: the note itself when it is in view, the note a merged
// note finally became when that one is, else nothing ([[redacted]]).
export function linkFor(id: string, res: CarveResult): string | undefined {
  if (res.visible.has(id)) return id;
  const t = res.mergedTo?.get(id);
  return t && res.visible.has(t) ? t : undefined;
}

// Notes that are never handed out: merge pointers. A superseded or stalled decision stays in
// views (the owner's call, 2026-10-08: "what did I decide in September" must work), ranked down
// and labelled with the decision that replaced it (view.ts statusBanner).
const NEVER_IN_VIEWS = new Set(["merged"]);

// Decoy notes for leak probes (src/canary.ts) live here. Only a slice that names this area (or
// lists the note) reaches them: never `all`, a type, tag or sensitivity slice.
export const PROBE_AREA = "probe";
// A slice that picks notes by area, kind, tag or name. One with no such selector is "all" under
// another name, and the canary area is never handed out. A list of names counts only alone: with
// any filter beside it (max_sensitivity, since, only_attributes…) sliceRejects lets every note
// through (G245). Used by consent (what a sentence may grant) and by the CLI's token gate (G184).
const FILTERS = ["max_sensitivity", "since", "until", "only_attributes", "exclude_attributes"];
export const narrowSlice = (name: string, s: Record<string, unknown> | undefined) => !!s && name !== "all"
  && !!(s.areas || s.types || s.tags || (s.include && !FILTERS.some((k) => s[k] !== undefined)))
  && !(s.areas as string[] | undefined)?.includes(PROBE_AREA);

export function folderOf(note: Note): string {
  const id = note.fm.id, i = id.indexOf("/");
  return i < 0 ? id : id.slice(0, i);
}

export function grantFor(rules: Rules, agent: string, overrideSlices?: string[]): Grant {
  const a = rules.policy.agents[agent] ?? { tier: "trial" as const };
  const tier = rules.policy.agents[agent] ? tierOf(rules, agent) : { max_sensitivity: "personal" as Sensitivity };
  return {
    agent,
    // OpenFGA, when the hub has it on, can only drop slices here (src/fga.ts).
    slices: confirmSlices(agent, overrideSlices ?? a.slices ?? [], a.inside_wall),
    exclude_types: a.exclude_types ?? [],
    exclude: a.exclude ?? [],
    // A reader token sees its slice below private, whatever the agent's own ceiling (tokenrole.ts).
    ceiling: capForRole(agent, a.max_sensitivity ?? tier.max_sensitivity),
  };
}

function matchesType(note: Note, types: string[]): boolean {
  return types.includes(folderOf(note)) || types.includes(note.fm.type);
}

function latestDate(note: Note): string {
  let d = note.fm.updated ?? note.fm.created ?? "";
  for (const f of Object.values(note.fm.facts ?? {})) {
    for (const r of records(f)) if (r.as_of > d) d = r.as_of;
  }
  return d;
}

export function records(f: Fact): FactRecord[] {
  if (isList(f)) return f.items;
  if (isDisputed(f)) return f.candidates;
  return [f as FactRecord];
}

// Rejections that leave a note out on purpose, as opposed to it just being outside the slice.
const PURPOSEFUL_REJECTS = new Set(["excluded by name", "excluded tag"]);
// Does one slice select this note? Returns undefined if yes, or the reason it doesn't.
function sliceRejects(note: Note, s: Slice): string | undefined {
  const id = note.fm.id;
  if (s.exclude?.includes(id)) return "excluded by name";
  if (s.include?.includes(id)) return undefined;
  if (note.fm.area === PROBE_AREA && !s.areas?.includes(PROBE_AREA)) return "probe area (only a slice that names it)";
  const hasSelectors = s.areas || s.types || s.tags || s.max_sensitivity || s.since || s.until || s.only_attributes || s.exclude_attributes;
  if (s.include && !hasSelectors) return "not listed";
  if (s.areas && !s.areas.includes(note.fm.area)) return `area ${note.fm.area}`;
  if (s.types && !matchesType(note, s.types)) return `type ${folderOf(note)}`;
  if (s.tags && !(note.fm.tags ?? []).some((t) => s.tags!.includes(t))) return "tag";
  if (s.exclude_tags && (note.fm.tags ?? []).some((t) => s.exclude_tags!.includes(t))) return "excluded tag";
  if (s.max_sensitivity && sensitivityRank(note.fm.sensitivity) > sensitivityRank(s.max_sensitivity))
    return `${note.fm.sensitivity} above slice limit`;
  if (s.since && latestDate(note) < s.since) return `older than ${s.since}`;
  if (s.until && (note.fm.created ?? "") > s.until) return `newer than ${s.until}`;
  return undefined;
}

function attributesFor(s: Slice): Set<string> | "all" {
  if (s.only_attributes) return new Set(s.only_attributes);
  return "all";
}

// Where one note goes in an agent's carve: excluded (and why) or visible (with what).
function place(note: Note, rules: Rules, grant: Grant): { excluded?: Excluded; visible?: Visible } {
  const id = note.fm.id;
  const folder = folderOf(note);
  if (NEVER_IN_VIEWS.has(note.fm.status)) return { excluded: { id, reason: `status ${note.fm.status}` } };
  if (folder === "disputes") return { excluded: { id, reason: "conflict packet (owner and resolver only)" } };
  if (grant.exclude_types.some((t) => matchesType(note, [t]))) return { excluded: { id, reason: `type ${folder} not shared`, purposeful: true } };
  if (grant.exclude.includes(id)) return { excluded: { id, reason: "excluded by name", purposeful: true } };
  if (sensitivityRank(note.fm.sensitivity) > sensitivityRank(grant.ceiling)) {
    return { excluded: { id, reason: `${note.fm.sensitivity}, above ${grant.agent}'s ceiling (${grant.ceiling})`, purposeful: true } };
  }
  // An agent always sees its own capability notes (agents/<agent>/) and what it wrote itself in
  // the area named after it (write.ts lets it write there directly). G176: the name alone
  // isn't enough. An area added later under an agent's name (a policy.areas key, a note's area:
  // edited by hand) would otherwise hand that agent every note in it; those go through its
  // slices like any other note. Fails closed: the agent sees less, the brain still loads.
  const own = note.fm.area === grant.agent && (note.fm.by === grant.agent || id.startsWith(`agents/${grant.agent}/`));
  let attrs: Set<string> | "all" | undefined = own ? "all" : undefined;
  let body = own;
  const by: string[] = own ? ["own"] : [];
  const reasons: string[] = [];
  let purposeful = false;
  for (const name of grant.slices) {
    const s = rules.slices[name];
    const r = sliceRejects(note, s);
    if (r) { reasons.push(`${name}: ${r}`); if (PURPOSEFUL_REJECTS.has(r) || r.endsWith(" above slice limit")) purposeful = true; continue; }
    by.push(name);
    const a = attributesFor(s);
    if (a === "all" || attrs === "all") attrs = "all";
    else attrs = new Set([...(attrs ?? []), ...a]);
    if (s.bodies === true || (s.bodies !== false && !s.only_attributes)) body = true;
  }
  if (!attrs) return { excluded: { id, reason: reasons.length ? `no slice selects it (${reasons.join("; ")})` : "no slices granted", ...(purposeful ? { purposeful: true as const } : {}) } };
  return { visible: { note, attributes: attrs, body, slices: by } };
}

// flags: false skips the preview's leak flags (the write path and cells don't show them); the
// carved values the scrub needs are computed either way.
// `names: false` skips withholding carved values in visible titles and aliases (the merge backstop
// compares only what is carved, not the copies).
export function carve(notes: Note[], rules: Rules, grant: Grant, opts: { flags?: boolean; names?: boolean } = {}): CarveResult {
  const visible = new Map<string, Visible>();
  const excluded: Excluded[] = [];
  const hiddenFacts: CarveResult["hiddenFacts"] = [];
  const unknown = grant.slices.filter((s) => !rules.slices[s]);
  if (unknown.length) throw new Error(`unknown slice(s): ${unknown.join(", ")} (see rules/slices.yaml)`);

  const memo = opts.flags === false ? memoFor(notes, rules, grant) : undefined;
  if (memo) return carveFromMemo(notes, rules, grant, memo, opts.names !== false);

  for (const note of notes) {
    const p = place(note, rules, grant);
    if (p.excluded) excluded.push(p.excluded);
    else visible.set(note.fm.id, p.visible!);
  }

  // Fact-level carving: attribute lists, per-fact sensitivity, single-fact excludes, time windows.
  for (const v of visible.values()) {
    for (const [attr, f] of Object.entries(v.note.fm.facts ?? {})) {
      const key = `${v.note.fm.id}#${attr}`;
      const reason = factHiddenReason(v, attr, f, grant, rules);
      if (reason) hiddenFacts.push({ key, reason });
    }
  }

  const notShared = [...new Set(grant.exclude_types)].filter((t) =>
    notes.some((n) => matchesType(n, [t])) && rules.slices[t]?.announce !== false);
  const result: CarveResult = { grant, visible, excluded, hiddenFacts, flags: [], notShared, carvedValues: [] };
  const merged = notes.filter((n) => n.fm.status === "merged");
  if (merged.length) {
    const byId = new Map(notes.map((n) => [n.fm.id, n]));
    result.mergedTo = new Map();
    for (const n of merged) { const t = mergedTarget(n, byId); if (t) result.mergedTo.set(n.fm.id, t); }
  }
  result.flags = leakFlags(notes, rules, result, opts.flags !== false);
  // A note's name is prose too: a carved value in a visible note's title or aliases ("Joe at
  // <bank>") is withheld like one in its body, on every path that reads the carve (view, read,
  // search, context_pack, cells). The agent gets a copy; the brain's note is untouched (bug hunt
  // A2, eval gap G56). Ids can't be rewritten: leakFlags flags them for the owner and new ids
  // leave carved values out (write.ts safeSlug).
  if (opts.names === false) return result;
  const needles = nameNeedles(result);
  for (const [id, v] of visible) {
    const fm = v.note.fm;
    const title = withholdName(fm.title, result.carvedValues, needles);
    const aliases = fm.aliases?.map((a) => withholdName(a, result.carvedValues, needles));
    if (title !== fm.title || aliases?.some((a, i) => a !== fm.aliases![i])) {
      visible.set(id, { ...v, note: { ...v.note, fm: { ...fm, title, ...(aliases ? { aliases } : {}) } } });
      if (opts.flags !== false) result.flags.push({ id, kind: "carved-value-in-view", detail: `title or alias carries a carved value; shown as "${title}"${aliases?.length ? ` (also: ${aliases.join(", ")})` : ""}` });
    }
  }
  return result;
}

// The deep matcher's needles for names (spacing, dashes, case, look-alikes; view.ts needlesOf
// for prose). Words count as shown only from visible fact values, never from titles, which any
// writer can set. A single carved word is left to the exact pass, as in prose.
// Per carve result (and its carved values), the needles without `from`: the write path asks for
// them once per title and value, and each call walked every visible fact (docs/perf.md).
const nameNeedlesOf = new WeakMap<CarveResult, { values: string[]; needles: Needle[] }>();
export function nameNeedles(res: CarveResult, from?: Map<string, string>): Needle[] {
  const hit = from ? undefined : nameNeedlesOf.get(res);
  if (hit && hit.values === res.carvedValues) return hit.needles;
  const needles = needlesWith(res, from);
  if (!from) nameNeedlesOf.set(res, { values: res.carvedValues, needles });
  return needles;
}
// Whole values only (squashed, or an amount's digits): a two-word fragment ("Trust Bank") would
// withhold innocent names ("Trust Banking 101"). With no parts, the words the reader is shown
// (which only decide parts) don't matter.
function needlesWith(res: CarveResult, from?: Map<string, string>): Needle[] {
  return res.carvedValues.filter((v) => !/^\p{L}+$/u.test(v.trim())).map((v) => needleFor(v, from?.get(v) ?? v)).filter((x): x is Needle => !!x).map((n) => ({ ...n, parts: [] }));
}

// A note's title or alias with carved values withheld: exact words first, then disguised forms.
export function withholdName(name: string, values: string[], needles: Needle[]): string {
  return withholdIn(scrubExact(name, values), needles);
}

// Per value list (a carve's carvedValues): lower-cased values, their patterns (compiled on first use), and
// an index by first word (tokenIndex), so a name tries only the values whose first word it holds.
// A value holding "withheld" could match only after an earlier replacement: always tried.
const exactLists = new WeakMap<string[], { lows: string[]; each: (RegExp | undefined)[]; candidates: (text: string) => number[]; always: number[] }>();
function exactList(values: string[]) {
  let e = exactLists.get(values);
  if (!e) {
    const always = values.flatMap((v, i) => /withheld/i.test(v) ? [i] : []);
    e = { lows: values.map((v) => v.toLowerCase()), each: [], candidates: tokenIndex(values), always }; // patterns compiled on first use
    exactLists.set(values, e);
  }
  return e;
}
// Each carved value, as a whole word, replaced by [withheld] (the exact pass of view.ts scrubCarved),
// in the order given. The same answers as trying every value: a value that matches as a whole word
// holds its first word as a token of the text (test/name-withhold.test.ts).
export function scrubExact(text: string, values: string[]): string {
  let out = text;
  const low = text.toLowerCase();
  const e = exactList(values);
  const todo = [...new Set([...e.candidates(text), ...e.always])].sort((x, y) => x - y);
  for (const i of todo) if (low.includes(e.lows[i])) out = out.replace(e.each[i] ??= new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(values[i])}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1[withheld]");
  return out;
}

export const HELD_REASON = "waiting for the owner to see it";

export function factHiddenReason(v: Visible, attr: string, f: Fact, grant: Grant, rules: Rules): string | undefined {
  const key = `${v.note.fm.id}#${attr}`;
  if (grant.exclude.includes(key)) return "excluded by name";
  if (v.attributes !== "all" && !v.attributes.has(attr)) return "attribute not in slice";
  const recs = records(f);
  // Every record counts: a list item or dispute candidate limited to other agents hides the whole
  // fact, not only when it happens to be the first record (G170).
  const allow = recs.find((r) => r.share_with && !r.share_with.includes(grant.agent))?.share_with;
  if (allow) return `do not share (only ${allow.join(", ") || "the owner"})`;
  const sens = recs.map((r) => r.sensitivity).filter(Boolean) as Sensitivity[];
  if (sens.some((s) => sensitivityRank(s) > sensitivityRank(grant.ceiling))) return `fact is ${sens[0]}`;
  for (const name of v.slices) {
    const s = rules.slices[name];
    if (!s) continue;
    if (s.exclude?.includes(key)) return `excluded in slice ${name}`;
    if (s.exclude_attributes?.includes(attr)) return `attribute excluded in slice ${name}`;
  }
  // The only serving hold (phone UI spec §7): a live value the owner hasn't seen yet goes to no agent.
  // Last, so a fact hidden for any other reason keeps that reason (write.ts reads it).
  if (recs.some((r) => r.unseen && !r.valid_to && !r.retired)) return HELD_REASON;
  return undefined;
}

// The hidden attributes by note, rebuilt only when the list grows: visibleFacts runs once per
// note and per string, and a set per call made large carves quadratic (docs/perf.md).
const hiddenCache = new WeakMap<CarveResult["hiddenFacts"], { n: number; byNote: Map<string, Set<string>> }>();
function hiddenByNote(res: CarveResult): Map<string, Set<string>> {
  const c = hiddenCache.get(res.hiddenFacts);
  if (c && c.n === res.hiddenFacts.length) return c.byNote;
  const byNote = new Map<string, Set<string>>();
  for (const h of res.hiddenFacts) {
    const i = h.key.indexOf("#"), id = h.key.slice(0, i);
    (byNote.get(id) ?? byNote.set(id, new Set()).get(id)!).add(h.key.slice(i + 1));
  }
  hiddenCache.set(res.hiddenFacts, { n: res.hiddenFacts.length, byNote });
  return byNote;
}

// The updated date an agent is shown. `updated` moves on every write, a hidden fact's included, so
// in a note with a hidden fact it would tell the agent that a fact it can't see just changed. The
// body's own change date isn't tracked, so such a note shows the newest date among its visible facts
// (as_of or last_confirmed), else `created`. A note with nothing
// hidden keeps its updated: every write to it is one the agent can see (G222).
export function shownUpdated(v: Visible, res: CarveResult): string {
  const fm = v.note.fm;
  if (!hiddenByNote(res).has(fm.id)) return String(fm.updated ?? "");
  const dates = [String(fm.created ?? "")];
  for (const [, f] of visibleFacts(v, res)) for (const r of records(f)) dates.push(String(r.last_confirmed ?? r.as_of ?? ""));
  const newest = dates.filter((d) => /^\d{4}/.test(d)).sort().at(-1) ?? "";
  return newest;
}

// A frozen note's facts can't change (src/brain.ts), so their entries are listed once.
const entriesOf = new WeakMap<object, readonly [string, Fact][]>();
export function visibleFacts(v: Visible, res: CarveResult): [string, Fact][] {
  const facts = v.note.fm.facts ?? {};
  let all = entriesOf.get(facts);
  if (!all) { all = Object.entries(facts); if (Object.isFrozen(facts)) entriesOf.set(facts, all); }
  const hidden = hiddenByNote(res).get(v.note.fm.id);
  return hidden ? all.filter(([a]) => !hidden.has(a)) : [...all];
}

// A fact's value strings. A frozen fact (a note loaded shared, src/brain.ts) can't change, so its
// strings are remembered: carves read every visible fact's values several times.
const strings = new WeakMap<Fact, readonly string[]>();
export function valueStrings(f: Fact): readonly string[] {
  const hit = strings.get(f);
  if (hit) return hit;
  const out = valueStringsOf(f);
  if (Object.isFrozen(f)) strings.set(f, Object.freeze(out));
  return out;
}
function valueStringsOf(f: Fact): string[] {
  const out: string[] = [];
  for (const r of records(f)) {
    const v = r.value;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number") out.push(String(v));
    else if (v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "string") out.push(x);
  }
  return out;
}

const STOP_VALUES = new Set(["active", "ended", "done", "open", "closed", "true", "false", "yes", "no", "unknown", "daily", "weekly"]);

// The active note a merged note finally points at, following merged_into through any chain of
// merges (G246). Undefined when the chain loops or leaves the notes given.
export function mergedTarget(n: Note, byId: Map<string, Note>): string | undefined {
  const seen = new Set([n.fm.id]);
  let id = String(n.fm.merged_into ?? "");
  for (;;) {
    const t = byId.get(id);
    if (!id || !t || seen.has(id)) return undefined;
    if (t.fm.status !== "merged") return id;
    seen.add(id);
    id = String(t.fm.merged_into ?? "");
  }
}

// ---------- the incremental carve ----------
// A carve without the preview's flags (cells, snapshots, the write path) remembers, per note and
// per grant, what the note gave the last carve: where it went, its hidden facts, and what it adds
// to the carve-wide sets (carved values, shown values). A note loaded shared is
// frozen and stays the same object while its file is unchanged (src/brain.ts), so a carve after
// one write works out only the notes the write touched, and walks the rest as remembered lists,
// in note order, so every list comes out in the order the full carve gives (docs/perf.md).
// test/carve-memo.test.ts compares it with the full carve.
interface NoteCarve {
  excluded?: Excluded;
  visible?: Omit<Visible, "note">;
  hidden: { key: string; reason: string }[];
  carvedEx: [string, string][]; // excluded on purpose: its values and aliases, with their source
  carvedHid: [string, string][]; // its hidden facts' values
  shown: string[]; // its visible fact values, lower case
  named?: { sig: number; note?: Note }; // its title and aliases withheld, for one name signature
}
// The last carve's carved values (frozen: every carve with the same values shares them, and the
// caches keyed on the array) and their name needles.
interface Memo { notes: WeakMap<Note, NoteCarve>; sig: string; sigId: number; values: string[]; needles: Needle[] }
const memos = new Map<string, Memo>();
export const carveStats = { placed: 0 };

// The memo for this grant, or undefined when this carve must be the full one: a note that isn't
// frozen can change under the memo, and a duplicate id or an id holding "#" (fact keys split on
// it) is answered by the full carve's own lookups.
function memoFor(notes: Note[], rules: Rules, grant: Grant): Memo | undefined {
  const ids = new Set<string>();
  for (const n of notes) { if (!Object.isFrozen(n) || n.fm.id.includes("#") || ids.has(n.fm.id)) return undefined; ids.add(n.fm.id); }
  // place() and factHiddenReason read the grant, the slices it names and the `own` slice (an
  // agent's own notes are shown through it), nothing else.
  const key = JSON.stringify([grant, grant.slices.map((s) => rules.slices[s]), rules.slices.own]);
  let m = memos.get(key);
  if (!m) { if (memos.size >= 256) memos.clear(); memos.set(key, m = { notes: new WeakMap(), sig: "", sigId: 0, values: [], needles: [] }); }
  return m;
}

function noteCarve(note: Note, rules: Rules, grant: Grant): NoteCarve {
  carveStats.placed++;
  const p = place(note, rules, grant);
  const id = note.fm.id;
  const facts = Object.entries(note.fm.facts ?? {});
  if (p.excluded) {
    const carvedEx: [string, string][] = [];
    // Only a purposeful exclusion carves (leakFlags, backlog 181): an area named like a reason does not.
    if (p.excluded.purposeful && folderOf(note) !== "agents") {
      for (const [attr, f] of facts) for (const s of valueStrings(f)) carvedEx.push([s, `${id}#${attr}`]);
      for (const a of note.fm.aliases ?? []) carvedEx.push([a, id]);
    }
    return { excluded: p.excluded, hidden: [], carvedEx, carvedHid: [], shown: [] };
  }
  const v = p.visible!;
  const hidden: NoteCarve["hidden"] = [];
  for (const [attr, f] of facts) {
    const reason = factHiddenReason(v, attr, f, grant, rules);
    if (reason) hidden.push({ key: `${id}#${attr}`, reason });
  }
  const carvedHid: [string, string][] = [];
  for (const h of hidden) { const f = note.fm.facts?.[h.key.split("#")[1]]; if (f) for (const s of valueStrings(f)) carvedHid.push([s, h.key]); }
  const gone = new Set(hidden.map((h) => h.key.slice(h.key.indexOf("#") + 1)));
  const shown: string[] = [];
  for (const [attr, f] of facts) if (!gone.has(attr)) for (const s of valueStrings(f)) shown.push(s.toLowerCase());
  return { visible: { attributes: v.attributes, body: v.body, slices: v.slices }, hidden, carvedEx: [], carvedHid, shown };
}

function carveFromMemo(notes: Note[], rules: Rules, grant: Grant, memo: Memo, names: boolean): CarveResult {
  const visible = new Map<string, Visible>();
  const excluded: Excluded[] = [];
  const hiddenFacts: CarveResult["hiddenFacts"] = [];
  const per: NoteCarve[] = [];
  for (const note of notes) {
    let nc = memo.notes.get(note);
    if (!nc) memo.notes.set(note, nc = noteCarve(note, rules, grant));
    per.push(nc);
    // Fresh objects each carve, as the full carve gives: callers own what they get.
    if (nc.excluded) excluded.push({ ...nc.excluded });
    else {
      const v = nc.visible!;
      visible.set(note.fm.id, { note, attributes: v.attributes === "all" ? "all" : new Set(v.attributes), body: v.body, slices: [...v.slices] });
      for (const h of nc.hidden) hiddenFacts.push({ ...h });
    }
  }
  const notShared = [...new Set(grant.exclude_types)].filter((t) =>
    notes.some((n) => matchesType(n, [t])) && rules.slices[t]?.announce !== false);
  const result: CarveResult = { grant, visible, excluded, hiddenFacts, flags: [], notShared, carvedValues: [] };
  const merged = notes.filter((n) => n.fm.status === "merged");
  const byId = merged.length ? new Map(notes.map((n) => [n.fm.id, n])) : undefined;
  if (byId) {
    result.mergedTo = new Map();
    for (const n of merged) { const t = mergedTarget(n, byId); if (t) result.mergedTo.set(n.fm.id, t); }
  }

  // leakFlags' carved values, from the remembered lists: excluded notes first, then merge
  // pointers (worked out each carve: they follow other notes), then hidden facts.
  const carved = new Map<string, string>();
  for (const nc of per) for (const [s, from] of nc.carvedEx) carved.set(s, from);
  if (byId) pointerValues(byId, result, carved);
  for (const nc of per) for (const [s, from] of nc.carvedHid) carved.set(s, from);
  const shown = new Set<string>();
  if (carved.size) for (const nc of per) for (const s of nc.shown) shown.add(s);
  const values = carvedNeedles(carved, shown).map(([s]) => s).sort((a, b) => b.length - a.length);

  // Names, as carve() withholds them. Name needles depend on the values only (no common words),
  // so while the values are the same, the last carve's values, needles and answers stand.
  const sig = JSON.stringify(values);
  if (sig !== memo.sig) {
    // A kept value's needle is the one it had (needlesWith's answer depends on the value only).
    const had = new Map(memo.needles.map((n) => [n.value, n]));
    const fresh = needlesWith({ ...result, carvedValues: values.filter((v) => !had.has(v)) });
    const made = new Map(fresh.map((n) => [n.value, n]));
    const needles = values.map((v) => had.get(v) ?? made.get(v)).filter((n): n is Needle => !!n);
    const prev = memo.sigId, before = memo.values;
    memo.sig = sig; memo.sigId++; memo.values = Object.freeze(values) as string[]; memo.needles = Object.freeze(needles) as Needle[];
    // A name no old value reached keeps its answer when no added value reaches it either (it
    // then stays as is under the whole new list). Values that can reach into "[withheld]" or
    // "[[redacted]]" text rule this out: every name is worked out again.
    const old = new Set(before), added = values.filter((v) => !old.has(v)), now = new Set(values);
    const odd = (v: string) => /withheld|redacted|\[|\]/i.test(v) || /withheld|redacted/.test(squash(v));
    if (before.length && !added.some(odd) && !before.some((v) => !now.has(v) && odd(v))) {
      const addedNeedles = needles.filter((n) => !old.has(n.value));
      // The exact pass changes a name only if it holds a value (scrubExact).
      const lows = added.map((v) => v.toLowerCase());
      const reaches = (name: string) => { const low = name.toLowerCase(); return (lows.some((v) => low.includes(v)) ? withholdName(name, added, addedNeedles) : withholdIn(name, addedNeedles)) !== name; };
      for (let i = 0; i < notes.length; i++) {
        const nc = per[i], fm = notes[i].fm;
        if (nc.excluded || nc.named?.sig !== prev || nc.named.note) continue;
        if (!reaches(fm.title) && !fm.aliases?.some(reaches)) nc.named.sig = memo.sigId;
      }
    }
  }
  result.carvedValues = memo.values;
  if (!names) return result;
  const needles = memo.needles;
  nameNeedlesOf.set(result, { values: result.carvedValues, needles });
  for (let i = 0; i < notes.length; i++) {
    const nc = per[i];
    if (nc.excluded) continue;
    if (nc.named?.sig !== memo.sigId) {
      const fm = notes[i].fm;
      const title = withholdName(fm.title, result.carvedValues, needles);
      const aliases = fm.aliases?.map((a) => withholdName(a, result.carvedValues, needles));
      const changed = title !== fm.title || aliases?.some((a, j) => a !== fm.aliases![j]);
      nc.named = { sig: memo.sigId, note: changed ? deepFreeze({ ...notes[i], fm: { ...fm, title, ...(aliases ? { aliases } : {}) } }) : undefined };
    }
    if (nc.named.note) visible.set(notes[i].fm.id, { ...visible.get(notes[i].fm.id)!, note: nc.named.note });
  }
  return result;
}

// Dates and single lowercase words ("account") match too much ordinary prose to be useful.
// A carved value holding a date is carved as the page writer says it too ("due 8 Dec at noon",
// G589); a bare carved date is withheld in words in its own page only (`scrubPage` in view.ts),
// since "24 Sep" on another page is as common as 2026-09-24 there.
function carvedNeedles(carved: Map<string, string>, shown: Set<string>): [string, string][] {
  const all = new Map(carved);
  for (const [s, from] of carved) if (distinctive(s, shown)) for (const w of dateWordForms(s)) if (w !== s && !all.has(w) && distinctive(w, shown) && !/^\d{1,2} \p{L}{3}( \d{4})?$/u.test(w)) all.set(w, from);
  return [...all.entries()].filter(([s]) => s.trim().length >= 4 && !STOP_VALUES.has(s.toLowerCase()) && distinctive(s, shown));
}

// A merged note is a pointer, out of every view; it is carved as the note it finally merged into
// (followed through any chain of merges, G246) is carved for this agent (G227). Shown: only names
// the merges held back (a more private note's alias) stay carved (G204); its values follow that
// note's shown and hidden facts below. Kept out on purpose (type, name, ceiling), missing or a
// loop: its names and values are carved too (G217). Merely outside this agent's slices: nothing,
// as for any other note it doesn't read.
function pointerValues(byId: Map<string, Note>, res: CarveResult, carved: Map<string, string>) {
  const pointers = res.excluded.filter((x) => x.reason === "status merged");
  const whyOut = pointers.length ? new Map(res.excluded.map((x) => [x.id, x.reason])) : undefined;
  for (const e of pointers) {
    const n = byId.get(e.id);
    if (!n || folderOf(n) === "agents") continue;
    const intoId = mergedTarget(n, byId) ?? "";
    const into = res.visible.get(intoId);
    const why = whyOut?.get(intoId) ?? "";
    if (!into && byId.has(intoId) && /^(no slice selects it|no slices granted)/.test(why)) continue;
    const names = new Set(into ? [into.note.fm.title, ...(into.note.fm.aliases ?? [])].map((x) => x.toLowerCase()) : []);
    for (const a of n.fm.aliases ?? []) if (!names.has(a.toLowerCase())) carved.set(a, e.id);
    if (!into) for (const [attr, f] of Object.entries(n.fm.facts ?? {})) for (const s of valueStrings(f)) carved.set(s, `${e.id}#${attr}`);
  }
}

// What the preview warns about (architecture 0.7, "What the preview would flag").
function leakFlags(notes: Note[], rules: Rules, res: CarveResult, scan = true): Flag[] {
  const flags: Flag[] = [];
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  // Values that were carved out on purpose: everything in notes excluded for type, name or
  // sensitivity, plus hidden facts. Notes merely outside the granted areas don't count.
  const carved = new Map<string, string>(); // value -> where it came from
  const purposeful = res.excluded.filter((e) => e.purposeful);
  for (const e of purposeful) {
    const n = byId.get(e.id)!;
    if (folderOf(n) === "agents") continue; // tool names like "Gmail" aren't secrets
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) for (const s of valueStrings(f)) carved.set(s, `${e.id}#${attr}`);
    for (const a of n.fm.aliases ?? []) carved.set(a, e.id);
  }
  // Merge pointers, as the note they became is carved (pointerValues).
  pointerValues(byId, res, carved);
  for (const h of res.hiddenFacts) {
    const [id, attr] = h.key.split("#");
    const f = byId.get(id)?.fm.facts?.[attr];
    if (f) for (const s of valueStrings(f)) carved.set(s, h.key);
  }
  // A value the agent is also given elsewhere isn't carved out.
  const shown = new Set<string>();
  if (carved.size) for (const v of res.visible.values()) for (const [, f] of visibleFacts(v, res)) for (const s of valueStrings(f)) shown.add(s.toLowerCase());
  const needles = carvedNeedles(carved, shown);
  res.carvedValues = needles.map(([s]) => s).sort((a, b) => b.length - a.length);
  if (!scan) return flags;
  const deep = nameNeedles(res, new Map(needles));
  const categories = categoryWords(rules.checks);
  const carvedWords = wordSet(needles.map(([s]) => s));

  for (const v of res.visible.values()) {
    const id = v.note.fm.id;
    const texts: string[] = [];
    if (v.body) texts.push(v.note.body);
    for (const [, f] of visibleFacts(v, res)) texts.push(...valueStrings(f));
    const text = texts.join("\n");
    if (v.body) {
      for (const target of new Set(linksIn(v.note.body))) {
        if (byId.has(target) && !res.visible.has(target) && purposeful.some((e) => e.id === target))
          flags.push({ id, kind: "links-to-excluded", detail: `prose links to ${target} (shown as [[redacted]])` });
      }
    }
    for (const needle of carvedWords.found(text))
      flags.push({ id, kind: "carved-value-in-view", detail: `mentions "${needle}", which is carved out (${carved.get(needle)})` });
    // An id is shown as is, so the owner renames the note (names are flagged in carve()).
    const inId = findCarried(id.replace(/[/_-]+/g, " "), deep)?.from;
    if (inId) flags.push({ id, kind: "carved-value-in-view", detail: `id carries a value carved out (${inId}); rename the note` });
    for (const t of res.grant.exclude_types) {
      for (const word of categories[t] ?? []) {
        const m = text.match(new RegExp(`(^|[^\\p{L}])(${escapeRe(word)})($|[^\\p{L}])`, "iu"));
        if (m) { flags.push({ id, kind: "category-mention", detail: `mentions "${m[2]}" (${t} is not shared)` }); break; }
      }
    }
  }
  return flags;
}

// The first word of a type withheld from `agent` (money: salary, TFSA…, from rules/checks.yaml
// `categories`) that `text` mentions, as "type: word". Used by the write path and log intake.
export function withheldWord(rules: Rules, agent: string, text: string): string | undefined {
  const cats = categoryWords(rules.checks);
  for (const t of grantFor(rules, agent).exclude_types) for (const w of cats[t] ?? [])
    if (hasWord(text, w)) return `${t}: ${w}`;
  return undefined;
}

// `carve <agent> --why <id>`: one line per slice.
export function explain(notes: Note[], rules: Rules, grant: Grant, target: string): string[] {
  const [id, attr] = target.split("#");
  const res = carve(notes, rules, grant);
  const note = notes.find((n) => n.fm.id === id);
  if (!note) return [`${id}: no such note`];
  const v = res.visible.get(id);
  const lines: string[] = [];
  if (!v) {
    const e = res.excluded.find((x) => x.id === id);
    lines.push(`${id}: OUT for ${grant.agent} (${e?.reason})`);
    return lines;
  }
  lines.push(`${id}: IN for ${grant.agent}, via ${v.slices.join(", ")}; body ${v.body ? "shown" : "hidden"}`);
  if (attr) {
    const h = res.hiddenFacts.find((x) => x.key === target);
    lines.push(h ? `${target}: OUT (${h.reason})` : note.fm.facts?.[attr] ? `${target}: IN` : `${target}: no such fact`);
  } else {
    for (const h of res.hiddenFacts.filter((x) => x.key.startsWith(id + "#"))) lines.push(`  ${h.key}: OUT (${h.reason})`);
  }
  return lines;
}

export function countFacts(res: CarveResult): number {
  let n = 0;
  for (const v of res.visible.values()) n += visibleFacts(v, res).length;
  return n;
}

export function renderPreview(notes: Note[], res: CarveResult): string {
  const total = notes.length;
  const vis = [...res.visible.values()];
  const byFolder = (xs: { id: string }[]) => {
    const m = new Map<string, number>();
    for (const x of xs) { const f = x.id.split("/")[0]; m.set(f, (m.get(f) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(", ");
  };
  const outGroups = new Map<string, number>();
  for (const e of res.excluded) {
    const key = e.reason.startsWith("no slice") ? "outside granted slices" : e.reason;
    outGroups.set(key, (outGroups.get(key) ?? 0) + 1);
  }
  const lines = [
    `${res.grant.agent} would see ${vis.length} notes (of ${total}), ${countFacts(res)} facts.`,
    `  slices: ${res.grant.slices.join(", ") || "(none)"}${res.grant.exclude_types.length ? `; not shared: ${res.grant.exclude_types.join(", ")}` : ""}; ceiling: ${res.grant.ceiling}`,
    `  in:   ${byFolder(vis.map((v) => ({ id: v.note.fm.id }))) || "nothing"}`,
    `  out:  ${[...outGroups.entries()].map(([r, n]) => `${r} (${n})`).join("; ") || "nothing"}`,
  ];
  if (res.hiddenFacts.length) {
    const g = new Map<string, number>();
    for (const h of res.hiddenFacts) g.set(h.reason, (g.get(h.reason) ?? 0) + 1);
    lines.push(`  facts held back: ${[...g.entries()].map(([r, n]) => `${r} (${n})`).join("; ")}`);
  }
  lines.push(`  sample: ${vis.slice(0, 6).map((v) => v.note.fm.id).join(" · ")}`);
  if (res.flags.length) {
    lines.push(`  check before confirming (${res.flags.length}):`);
    for (const f of res.flags) lines.push(`    ! ${f.id}: ${f.detail}`);
  } else lines.push("  no leaks flagged");
  return lines.join("\n");
}

export function factSummary(attr: string, f: Fact, type: string, rules: Rules, now: string): string[] {
  const spec = attributeSpec(rules, type, attr);
  const fr = factFreshness(f, spec, now);
  const fmt = (r: FactRecord) => {
    const v = typeof r.value === "object" ? JSON.stringify(r.value) : String(r.value);
    const src = (r.sources ?? []).map(refString).join(", ");
    return `${v} (as of ${r.as_of}${r.as_of_approx ? ", approx." : ""}; ${r.verification}; ${src})`;
  };
  if (isDisputed(f)) return [`- **${attr}** [disputed ${f.dispute}]:`, ...f.candidates.map((c) => `  - candidate: ${fmt(c)}`)];
  if (isList(f)) {
    const live = f.items.filter((i) => !i.valid_to);
    return [`- **${attr}** [${fr}]:`, ...live.map((i) => `  - ${fmt(i)}`)];
  }
  return [`- **${attr}** [${fr}]: ${fmt(f as FactRecord)}`];
}

// Words the agent is shown anyway (titles and visible fact values), squashed. A fragment of a
// carved value made only of these isn't distinctive enough to count as a leak.
// Per frozen note, its words for the facts last visible (most carves of a brain see a note the same way).
const noteWords = new WeakMap<Note, { attrs: string; words: string[] }>();
export function shownWords(res: CarveResult): Set<string> {
  const out = new Set<string>();
  for (const v of res.visible.values()) {
    const facts = visibleFacts(v, res);
    const attrs = facts.map(([a]) => a).join("\0");
    const hit = noteWords.get(v.note);
    if (hit && hit.attrs === attrs) { for (const w of hit.words) out.add(w); continue; }
    const words: string[] = [];
    const add = (t: string) => { for (const w of t.split(/[^\p{L}\p{N}]+/u)) if (w) words.push(squash(w)); };
    add(v.note.fm.title);
    for (const [, f] of facts) for (const s of valueStrings(f)) add(s);
    if (Object.isFrozen(v.note)) noteWords.set(v.note, { attrs, words });
    for (const w of words) out.add(w);
  }
  return out;
}
