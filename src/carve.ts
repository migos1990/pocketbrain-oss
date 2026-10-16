// SPDX-License-Identifier: AGPL-3.0-only
// The slice compiler (architecture 0.7): an agent's grant is the union of its slices,
// minus agent-level excludes, capped by its tier's sensitivity ceiling. The result is a
// list of visible notes, each with the attributes and body it may show.
import type { Note, Fact, FactRecord, Sensitivity } from "./brain";
import { isDisputed, isList, sensitivityRank, linksIn } from "./brain";
import type { Rules, Slice } from "./rules";
import { tierOf, attributeSpec } from "./rules";
import { factFreshness } from "./freshness";
import { confirmSlices } from "./fga";
import { refString } from "./sources";
import { squash, distinctive, needleFor, findCarried, withholdIn, type Needle } from "./match";
import { categoryWords } from "./checks";
import { escapeRe, hasWord, wordSet } from "./util";
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
}

// Notes that are never handed out: merge pointers. A superseded or stalled decision stays in
// views (the owner's call, 2026-10-08: "what did I decide in September" must work), ranked down
// and labelled with the decision that replaced it (view.ts statusBanner).
const NEVER_IN_VIEWS = new Set(["merged"]);

// Decoy notes for leak probes (src/canary.ts) live here. Only a slice that names this area (or
// lists the note) reaches them: never `all`, a type, tag or sensitivity slice.
export const PROBE_AREA = "probe";

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

// flags: false skips the preview's leak flags (the write path and cells don't show them); the
// carved values the scrub needs are computed either way.
export function carve(notes: Note[], rules: Rules, grant: Grant, opts: { flags?: boolean } = {}): CarveResult {
  const visible = new Map<string, Visible>();
  const excluded: Excluded[] = [];
  const hiddenFacts: CarveResult["hiddenFacts"] = [];
  const unknown = grant.slices.filter((s) => !rules.slices[s]);
  if (unknown.length) throw new Error(`unknown slice(s): ${unknown.join(", ")} (see rules/slices.yaml)`);

  for (const note of notes) {
    const id = note.fm.id;
    const folder = folderOf(note);
    if (NEVER_IN_VIEWS.has(note.fm.status)) { excluded.push({ id, reason: `status ${note.fm.status}` }); continue; }
    if (folder === "disputes") { excluded.push({ id, reason: "conflict packet (owner and resolver only)" }); continue; }
    if (grant.exclude_types.some((t) => matchesType(note, [t]))) { excluded.push({ id, reason: `type ${folder} not shared` }); continue; }
    if (grant.exclude.includes(id)) { excluded.push({ id, reason: "excluded by name" }); continue; }
    if (sensitivityRank(note.fm.sensitivity) > sensitivityRank(grant.ceiling)) {
      excluded.push({ id, reason: `${note.fm.sensitivity}, above ${grant.agent}'s ceiling (${grant.ceiling})` });
      continue;
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
    for (const name of grant.slices) {
      const s = rules.slices[name];
      const r = sliceRejects(note, s);
      if (r) { reasons.push(`${name}: ${r}`); continue; }
      by.push(name);
      const a = attributesFor(s);
      if (a === "all" || attrs === "all") attrs = "all";
      else attrs = new Set([...(attrs ?? []), ...a]);
      if (s.bodies === true || (s.bodies !== false && !s.only_attributes)) body = true;
    }
    if (!attrs) { excluded.push({ id, reason: reasons.length ? `no slice selects it (${reasons.join("; ")})` : "no slices granted" }); continue; }
    visible.set(id, { note, attributes: attrs, body, slices: by });
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
  result.flags = leakFlags(notes, rules, result, opts.flags !== false);
  // A note's name is prose too: a carved value in a visible note's title or aliases ("Joe at
  // <bank>") is withheld like one in its body, on every path that reads the carve (view, read,
  // search, context_pack, cells). The agent gets a copy; the brain's note is untouched (bug hunt
  // A2, eval gap G56). Ids can't be rewritten: leakFlags flags them for the owner and new ids
  // leave carved values out (write.ts safeSlug).
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
export function nameNeedles(res: CarveResult, from?: Map<string, string>): Needle[] {
  const common = new Set<string>();
  for (const v of res.visible.values()) for (const [, f] of visibleFacts(v, res)) for (const s of valueStrings(f)) for (const w of s.split(/[^\p{L}\p{N}]+/u)) if (w) common.add(squash(w));
  // Whole values only (squashed, or an amount's digits): a two-word fragment ("Trust Bank") would
  // withhold innocent names ("Trust Banking 101").
  return res.carvedValues.filter((v) => !/^\p{L}+$/u.test(v.trim())).map((v) => needleFor(v, from?.get(v) ?? v, common)).filter((x): x is Needle => !!x).map((n) => ({ ...n, parts: [] }));
}

// A note's title or alias with carved values withheld: exact words first, then disguised forms.
export function withholdName(name: string, values: string[], needles: Needle[]): string {
  return withholdIn(scrubExact(name, values), needles);
}

const lowered = new WeakMap<string[], string[]>();
// Each carved value, as a whole word, replaced by [withheld] (the exact pass of view.ts scrubCarved).
export function scrubExact(text: string, values: string[]): string {
  let out = text;
  const low = text.toLowerCase();
  let lows = lowered.get(values);
  if (!lows) lowered.set(values, (lows = values.map((v) => v.toLowerCase())));
  for (const [i, v] of values.entries()) if (low.includes(lows[i])) out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(v)}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1[withheld]");
  return out;
}

export function factHiddenReason(v: Visible, attr: string, f: Fact, grant: Grant, rules: Rules): string | undefined {
  const key = `${v.note.fm.id}#${attr}`;
  if (grant.exclude.includes(key)) return "excluded by name";
  if (v.attributes !== "all" && !v.attributes.has(attr)) return "attribute not in slice";
  const recs = records(f);
  // Hiding is per fact, so one item's list that leaves the agent out hides the whole fact (as with sensitivity below).
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
function valueStrings(f: Fact): readonly string[] {
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

// What the preview warns about (architecture 0.7, "What the preview would flag").
function leakFlags(notes: Note[], rules: Rules, res: CarveResult, scan = true): Flag[] {
  const flags: Flag[] = [];
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  // Values that were carved out on purpose: everything in notes excluded for type, name or
  // sensitivity, plus hidden facts. Notes merely outside the granted areas don't count.
  const carved = new Map<string, string>(); // value -> where it came from
  const purposeful = res.excluded.filter((e) => /not shared|excluded|ceiling|above/.test(e.reason));
  for (const e of purposeful) {
    const n = byId.get(e.id)!;
    if (folderOf(n) === "agents") continue; // tool names like "Gmail" aren't secrets
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) for (const s of valueStrings(f)) carved.set(s, `${e.id}#${attr}`);
    for (const a of n.fm.aliases ?? []) carved.set(a, e.id);
  }
  for (const h of res.hiddenFacts) {
    const [id, attr] = h.key.split("#");
    const f = byId.get(id)?.fm.facts?.[attr];
    if (f) for (const s of valueStrings(f)) carved.set(s, h.key);
  }
  // A value the agent is also given elsewhere isn't carved out.
  const shown = new Set<string>();
  if (carved.size) for (const v of res.visible.values()) for (const [, f] of visibleFacts(v, res)) for (const s of valueStrings(f)) shown.add(s.toLowerCase());
  // Dates and single lowercase words ("account") match too much ordinary prose to be useful.
  const needles = [...carved.entries()].filter(([s]) => s.trim().length >= 4 && !STOP_VALUES.has(s.toLowerCase()) && distinctive(s, shown));
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
