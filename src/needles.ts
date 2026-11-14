// SPDX-License-Identifier: AGPL-3.0-only
// What outbound text must not carry, as needles for the shared matcher (src/match.ts).
//
// hiddenNeedles(notes, rules, agent): every value the agent can't see: the values of hidden
// notes at any level and of hidden facts, field by field for an object, and a hidden note's
// aliases (the write tripwire's carvedValues in src/write.ts keeps its own list).
// The two choke points each missed what the other caught (act-door red team, M1). The act door
// and the relay (checkBetween, so handoffs too, G656) use it; the write path keeps its own.
//
// hiddenNames(notes, rules, agent): what names a page left out of the agent's view on purpose:
// its id, its title and its id's last part, matched whole (G254). The relay uses it, so a handoff
// that names such a page is held like one that carries its values.
//
// outwardScreen(notes, rules, ceiling): what only notes or facts above a ceiling hold, with the
// note each match comes from, for mail leaving the brain (act-door red team, H2). Its hits flag
// an item for the owner; they never refuse.
import type { Note, Sensitivity } from "./brain";
import { sensitivityRank } from "./brain";
import type { Rules } from "./rules";
import { ownerName } from "./rules";
import { carve, grantFor, records, visibleFacts, shownWords, folderOf } from "./carve";
import { needleFor, findCarried, distinctive, squash, decodedVariants, type Needle } from "./match";

// The strings a value carries: itself if a string or number, its fields if an object.
function scalarStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (typeof v === "number") return [String(v)];
  if (v && typeof v === "object") return Object.values(v).flatMap(scalarStrings);
  return [];
}

// Values the agent can't see, each with the note or fact it comes from.
export function hiddenValues(notes: Note[], rules: Rules, agent: string): Map<string, string> {
  const res = carve(notes, rules, grantFor(rules, agent), { flags: false });
  const shown = new Set<string>();
  for (const v of res.visible.values()) for (const [, f] of visibleFacts(v, res)) for (const r of records(f)) for (const s of scalarStrings(r.value)) shown.add(s.toLowerCase());
  const out = new Map<string, string>();
  const add = (val: string, from: string) => { const s = val.trim(); if (distinctive(s, shown) && !out.has(s)) out.set(s, from); };
  const hiddenKeys = new Set(res.hiddenFacts.map((h) => h.key));
  for (const n of notes) {
    const visible = res.visible.has(n.fm.id);
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) {
      if (visible && !hiddenKeys.has(`${n.fm.id}#${attr}`)) continue;
      for (const r of records(f)) for (const s of scalarStrings(r.value)) add(s, `${n.fm.id}#${attr}`);
    }
    if (!visible) for (const a of (n.fm.aliases as string[] | undefined) ?? []) add(String(a), n.fm.id);
  }
  return out;
}

export function hiddenNeedles(notes: Note[], rules: Rules, agent: string): Needle[] {
  const common = shownWords(carve(notes, rules, grantFor(rules, agent), { flags: false }));
  return [...hiddenValues(notes, rules, agent)].map(([v, from]) => needleFor(v, from, common)).filter((n): n is Needle => !!n);
}

// Names of the pages carved out for the agent (carve's `purposeful`: a type not shared, excluded by
// name, above its ceiling): the id, the title, and the id's last part where it says something the
// title doesn't. A page merely outside the agent's slices is not here: naming it tells the agent
// nothing its own search wouldn't. Aliases are hiddenValues'.
// A name is matched as whole words, in order, with only spaces, dashes, slashes, underscores or
// dots between them, in any case or accents, or run together as one word; so "Main bank" is not
// in "remain bankrupt" nor "Paul Advisor" in "Paul, advisor to the course". A value is matched
// more deeply (findCarried); a name is held on less, because one alerted hold stops a sender's
// later handoffs until the owner looks.
// A name of one word is often an everyday word too ("Compensation", "Mortgage"), and no list here
// decides which: it counts only where the text writes it with a capital (or in a script with no
// capitals), and never when the agent is shown that word anyway.
// What doesn't count, so everyday text isn't held (rows in test/contracts/relay.contract.test.ts):
// a name a page in view also carries, a name under six letters or with no letter, a part of a title.
interface HiddenName { words: string[]; value: string; from: string }
export type HiddenNames = Map<string, HiddenName[]>; // by first word, squashed
export function hiddenNames(notes: Note[], rules: Rules, agent: string): HiddenNames {
  const res = carve(notes, rules, grantFor(rules, agent), { flags: false });
  const names: HiddenNames = new Map();
  const out = res.excluded.filter((e) => e.purposeful);
  if (!out.length) return names;
  const common = shownWords(res);
  const inView = new Set<string>();
  for (const v of res.visible.values()) for (const x of [v.note.fm.title, ...((v.note.fm.aliases as string[] | undefined) ?? [])]) inView.add(squash(String(x ?? "")));
  const byId = new Map(notes.map((n) => [n.fm.id, n]));
  const seen = new Set<string>();
  const add = (name: string, from: string) => {
    const words = (name.match(/[\p{L}\p{N}]+/gu) ?? []).map(squash).filter(Boolean), sq = words.join("");
    if (sq.length < 6 || !/\p{L}/u.test(sq) || seen.has(sq) || inView.has(sq) || (words.length === 1 && common.has(sq))) return;
    seen.add(sq);
    (names.get(words[0]) ?? names.set(words[0], []).get(words[0])!).push({ words, value: name, from });
    // Run together ("workshopfund"), a several-word name is one word of the text.
    // Like a one-word title, it is often an everyday word ("Pay Roll", "payroll"): with a capital
    // only (findNamed), and never when the agent is shown that word anyway.
    if (words.length > 1 && !common.has(sq)) (names.get(sq) ?? names.set(sq, []).get(sq)!).push({ words: [sq], value: name, from });
  };
  for (const e of out) {
    const n = byId.get(e.id);
    if (!n || folderOf(n) === "agents") continue;
    const id = String(n.fm.id);
    add(id, id);
    add(String(n.fm.title ?? ""), id);
    add(id.slice(id.lastIndexOf("/") + 1), id);
  }
  return names;
}

// The first hidden name the text carries, as written or in an encoding the matcher decodes.
export function findNamed(text: string, names: HiddenNames): { value: string; from: string } | undefined {
  if (!names.size) return undefined;
  for (const variant of decodedVariants(text)) {
    // Marks that sit inside or around a word without being read (emphasis, an HTML tag, a
    // zero-width character, a soft hyphen) are taken out first: "**Main** bank" is "Main bank".
    const plain = variant.replace(/<\/?[a-z][^<>]{0,80}>|[*~`\u200B-\u200D\u2060\uFEFF\u00AD]/gi, "");
    const toks = [...plain.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({ raw: m[0], sq: squash(m[0]), at: m.index!, end: m.index! + m[0].length }));
    for (let i = 0; i < toks.length; i++) for (const n of names.get(toks[i].sq) ?? []) {
      // One word: only as a name, with a capital (a letter that has no lower-case form counts).
      if (n.words.length === 1 && /^\p{Ll}/u.test(toks[i].raw)) continue;
      let ok = i + n.words.length <= toks.length;
      for (let k = 1; ok && k < n.words.length; k++) ok = toks[i + k].sq === n.words[k] && /^[\s\-_/\\.]*$/.test(plain.slice(toks[i + k - 1].end, toks[i + k].at));
      if (ok) return { value: n.value, from: n.from };
    }
  }
  return undefined;
}

// Outbound mail only (red team M2): single capitalised words of 6+ letters from a hidden value
// of two or more words (not an address or a link) that nothing the agent sees uses, squashed,
// each with where it comes from. The act door shows them to the owner as a flag; they never
// refuse, since one word of a name is often an everyday word too.
export function hiddenWords(notes: Note[], rules: Rules, agent: string): Map<string, string> {
  const common = shownWords(carve(notes, rules, grantFor(rules, agent), { flags: false }));
  const names = new Set([ownerName(rules), ...Object.keys(rules.policy.agents)].map(squash));
  const out = new Map<string, string>();
  for (const [v, from] of hiddenValues(notes, rules, agent)) {
    if (/@|:\/\//.test(v)) continue;
    const ws = v.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter(Boolean);
    if (ws.length < 2) continue;
    for (const w of ws) {
      const s = squash(w);
      if (/^\p{Lu}\p{L}{5,}$/u.test(w) && !common.has(s) && !names.has(s) && !out.has(s)) out.set(s, from);
    }
  }
  return out;
}

export interface Screen { ceiling: Sensitivity; needles: Needle[]; exact: Map<string, string>; named: Map<string, string> }
export interface ScreenHit { from: string; match: string }

const words = (t: string) => t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /\d/.test(w));
const NAME = /(?<![.!?:]\s+|^\s*)\b\p{Lu}[\p{L}\p{N}]*/gmu;
const names = (t: string) => [...t.matchAll(NAME)].flatMap((m) => words(m[0]));
const numbers = (t: string) => words(t).filter((w) => /\d/.test(w));
const flat = (v: unknown): string => v == null ? "" : typeof v === "object" ? Object.values(v as object).map(flat).join("\n") : String(v);

// The same shape as the relay's request-check screen (aboveCeiling in src/relay.ts), with each
// word and needle keeping the note it comes from. `exact`: a short value whole and any number;
// `named`: capitalised words from titles, aliases, bodies and longer values, matched only where
// the text capitalises them too. A word counts only when no note at or below the ceiling uses
// it and it isn't the owner's or an agent's name.
export function outwardScreen(notes: Note[], rules: Rules, ceiling: Sensitivity): Screen {
  const above = (l: Sensitivity | undefined) => sensitivityRank(l) > sensitivityRank(ceiling);
  const exact: [string, string][] = [], named: [string, string][] = [], lo: string[] = [], needles: Needle[] = [];
  const value = (v: unknown, from: string) => {
    for (const part of v !== null && typeof v === "object" ? Object.values(v as object).map(flat) : [flat(v)]) {
      // An address or a link is matched whole, by its needle: its pieces (example, private) are everywhere.
      if (/@|:\/\//.test(part)) continue;
      if (part.trim().split(/\s+/).length <= 2) exact.push(...words(part).map((w): [string, string] => [w, from]));
      else { exact.push(...numbers(part).map((w): [string, string] => [w, from])); named.push(...names(part).map((w): [string, string] => [w, from])); }
    }
  };
  for (const n of notes) {
    const noteHi = above(n.fm.sensitivity);
    const prose = [n.fm.title ?? "", ...((n.fm.aliases as string[] | undefined) ?? []), n.body ?? ""].join("\n");
    if (noteHi) {
      named.push(...names(prose).map((w): [string, string] => [w, n.fm.id]));
      exact.push(...numbers(prose).map((w): [string, string] => [w, n.fm.id]));
      for (const h of (n.fm.history as unknown[] | undefined) ?? []) value(h, n.fm.id);
    } else lo.push(...words(prose));
    for (const [attr, f] of Object.entries(n.fm.facts ?? {})) for (const r of records(f)) {
      if (!noteHi && !above(r.sensitivity)) { lo.push(...words(flat(r.value))); continue; }
      value(r.value, n.fm.id);
      for (const s of scalarStrings(r.value)) { const nd = needleFor(s.trim(), n.fm.id); if (nd) needles.push(nd); }
    }
  }
  const seen = new Set([...lo, ...words(ownerName(rules)), ...Object.entries(rules.policy.agents).flatMap(([k, a]) => [k, ...(a.aliases ?? [])].flatMap(words))]);
  const keep = (ws: [string, string][]) => { const m = new Map<string, string>(); for (const [w, from] of ws) if (!seen.has(w) && !m.has(w)) m.set(w, from); return m; };
  return { ceiling, needles, exact: keep(exact), named: keep(named) };
}

// Every match of the screen in the text: needle hits (spacing, encoding and the rest, as the
// matcher catches them) and the words, each with the note it comes from.
export function screenText(screen: Screen, text: string): ScreenHit[] {
  const hits: ScreenHit[] = [];
  let rest = screen.needles;
  for (let n = findCarried(text, rest); n; n = findCarried(text, rest)) {
    hits.push({ from: n.from, match: n.value });
    rest = rest.filter((x) => x !== n);
  }
  for (const w of new Set(words(text))) { const from = screen.exact.get(w); if (from) hits.push({ from, match: w }); }
  for (const m of text.matchAll(/\b\p{Lu}[\p{L}\p{N}]*/gu)) for (const w of words(m[0])) { const from = screen.named.get(w); if (from && !hits.some((h) => h.match === w)) hits.push({ from, match: w }); }
  return hits;
}
