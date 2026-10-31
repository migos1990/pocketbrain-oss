// SPDX-License-Identifier: AGPL-3.0-only
// Names become links (memory-graph.md item 2, docs/wiki.md "Names become links"): when a note's
// text names another note by its exact title or alias, and that name fits exactly one note, upkeep
// turns the first mention into [[id|the words as written]], so the text reads the same and the
// link is recorded. No model: a name is matched by rule, never guessed. A name that fits two notes
// is a review line, never a link. Only prose is touched (a fact's value is its writer's), and only
// outside links, code, headings and reference definitions.
import { createHash } from "node:crypto";
import { linksIn, type Note } from "./brain";
import { carve, grantFor } from "./carve";
import { ownerName, type Rules } from "./rules";

const LINKABLE = new Set(["people", "orgs", "projects", "decisions", "notes", "money"]);
// A character's folded form only when it keeps its length (é -> e), so a match's place in the
// folded text is its place in the text; anything else (𝐀, ﬁ) stays as it is.
const fold1 = (c: string) => { const f = c.normalize("NFKD").replace(/\p{M}/gu, ""); return f.length === c.length ? f : c; };
// Accents dropped one character at a time.
const fold = (s: string) => [...s].map(fold1).join("");
const word = /[\p{L}\p{N}]/u;

export interface NameUse { name: string; ids: string[]; caseSensitive: boolean }

// The names a mention may use: titles and aliases of linkable notes that aren't merged. A one-word
// name needs 5 or more letters and a capital (a proper noun, matched with its case); a longer name
// needs 4 or more characters and matches in any case. The owner's own names never link: they are
// in every note.
export function nameIndex(notes: Note[], owner: string[] = []): Map<string, NameUse> {
  // A merged note's names never link: they live on as aliases of the note it became, and a
  // same-person undo would leave such a link pointing at the wrong person.
  const merged = notes.filter((n) => n.fm.status === "merged").flatMap((n) => [n.fm.title, ...(n.fm.aliases ?? [])]).map((x) => String(x ?? ""));
  const skip = new Set([...owner, ...merged].map((o) => fold(o).toLowerCase()).filter(Boolean));
  const out = new Map<string, NameUse>();
  for (const n of notes) {
    if (!LINKABLE.has(n.fm.id.split("/")[0]) || n.fm.status === "merged") continue;
    for (const raw of [n.fm.title, ...(n.fm.aliases ?? [])]) {
      const name = String(raw ?? "").trim();
      const one = !/\s/.test(name);
      if (!word.test(name) || name.length < (one ? 5 : 4) || (one && !/^\p{Lu}/u.test(name))) continue;
      const k = fold(name).toLowerCase();
      if (skip.has(k)) continue;
      const u = out.get(k) ?? { name, ids: [], caseSensitive: one };
      if (!u.ids.includes(n.fm.id)) u.ids.push(n.fm.id);
      out.set(k, u);
    }
  }
  return out;
}

// A name's key: a short hash of its folded, lower-cased words. A source item keeps the keys of the
// capitalised runs in its text (nameKeys), never the words, so the page writer can later tell
// which pages it named, including pages made after it was read (src/wiki.ts, docs/wiki.md).
export function nameKey(name: string): string {
  return createHash("sha256").update(fold(name).toLowerCase().split(/[^\p{L}\p{N}'-]+/u).filter(Boolean).join(" ")).digest("hex").slice(0, 12);
}
export const NAME_KEYS_MAX = 300;
const LINKER = /^(of|de|du|des|la|le|and|et|the|&)$/i;
export function nameKeys(text: string): string[] {
  const out = new Set<string>();
  const words = text.split(/[^\p{L}\p{N}'&-]+/u).filter(Boolean);
  for (let i = 0; i < words.length && out.size < NAME_KEYS_MAX; i++) {
    if (!/^[\p{Lu}\p{N}]/u.test(words[i])) continue;
    for (let j = i; j < Math.min(words.length, i + 5) && out.size < NAME_KEYS_MAX; j++) {
      const w = words[j];
      if (/^[\p{Lu}\p{N}]/u.test(w)) out.add(nameKey(words.slice(i, j + 1).join(" ")));
      else if (!LINKER.test(w)) break;
    }
  }
  return [...out].sort();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Text that may carry a mention: not a link, inline code, a heading, a reference definition or a code block.
function spans(body: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let at = 0, fence = false;
  for (const line of body.split("\n")) {
    const end = at + line.length;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && !/^\s*#/.test(line) && !/^\[\^[^\]\s]+\]:/.test(line)) {
      let s = at;
      for (const m of line.matchAll(/\[\[[^\]]*\]\]|`[^`]*`|\[\^[^\]\s]+\]|\]\([^)]*\)|https?:\/\/\S+/g)) { out.push({ start: s, end: at + m.index! }); s = at + m.index! + m[0].length; }
      out.push({ start: s, end });
    }
    at = end + 1;
  }
  return out.filter((x) => x.end > x.start);
}

// Where `name` first appears as whole words in `body`'s plain text, or -1.
export function findName(body: string, use: NameUse): { at: number; text: string } | undefined {
  const folded = fold(body);
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${esc(fold(use.name))}(?![\\p{L}\\p{N}_])`, use.caseSensitive ? "gu" : "giu");
  for (const s of spans(body)) {
    re.lastIndex = 0;
    const m = re.exec(folded.slice(s.start, s.end));
    if (m) return { at: s.start + m.index, text: body.slice(s.start + m.index, s.start + m.index + m[0].length) };
  }
  return undefined;
}

export interface Mention { from: string; to: string; name: string }
export interface Ambiguous { from: string; name: string; ids: string[] }

// What one note's text names: the links to add (longest name first, one per note named, never to
// itself or to a note it already links to) and the names that fit more than one note.
export function mentionsIn(n: Note, index: Map<string, NameUse>): { link: Mention[]; ambiguous: Ambiguous[] } {
  const have = new Set([...linksIn(n.body), ...linksIn(JSON.stringify(n.fm.facts ?? {}))]);
  const link: Mention[] = [], ambiguous: Ambiguous[] = [];
  const own = new Set([n.fm.title, ...(n.fm.aliases ?? [])].map((x) => fold(String(x ?? "")).toLowerCase()));
  let body = n.body;
  for (const use of [...index.values()].sort((a, b) => b.name.length - a.name.length)) {
    if (use.ids.includes(n.fm.id) || own.has(fold(use.name).toLowerCase())) continue;
    const hit = findName(body, use);
    if (!hit) continue;
    if (use.ids.length > 1) { if (!use.ids.some((x) => have.has(x))) ambiguous.push({ from: n.fm.id, name: use.name, ids: [...use.ids].sort() }); continue; }
    const to = use.ids[0];
    if (have.has(to)) continue;
    link.push({ from: n.fm.id, to, name: use.name });
    have.add(to);
    // The words stay as written; a longer name linked first keeps a shorter one inside it from linking again.
    body = body.slice(0, hit.at) + `[[${to}|${hit.text}]]` + body.slice(hit.at + hit.text.length);
  }
  return { link, ambiguous };
}

// The body with each mention linked, first appearance only.
export function linkMentions(body: string, links: Mention[], index: Map<string, NameUse>): string {
  let out = body;
  for (const l of links) {
    const use = index.get(fold(l.name).toLowerCase());
    const hit = use && findName(out, use);
    if (hit) out = out.slice(0, hit.at) + `[[${l.to}|${hit.text}]]` + out.slice(hit.at + hit.text.length);
  }
  return out;
}

// What upkeep step 1c would do, note by note: the links to add, the names that fit more than one
// note (counted), and the links left out because some assistant that sees the note can't see the
// note named. Also `pocketbrain wiki links preview`, for the owner only.
export interface NotePlan { from: string; link: Mention[]; ambiguous: number; blind: Mention[]; index: Map<string, NameUse> }
export function namePlan(notes: Note[], rules: Rules): NotePlan[] {
  const index = nameIndex(notes, [ownerName(rules)]);
  const carves = Object.keys(rules.policy.agents ?? {}).flatMap((agent) => { try { return [carve(notes, rules, grantFor(rules, agent), { flags: false })]; } catch { return []; } });
  const out: NotePlan[] = [];
  for (const n of notes) {
    if (!LINKABLE.has(n.fm.id.split("/")[0]) || n.fm.status === "merged") continue;
    const { link, ambiguous } = mentionsIn(n, index);
    const blind = link.filter((l) => carves.some((r) => r.visible.has(n.fm.id) && !r.visible.has(l.to)));
    const ok = link.filter((l) => !blind.includes(l));
    if (ok.length || blind.length || ambiguous.length) out.push({ from: n.fm.id, link: ok, ambiguous: ambiguous.length, blind, index });
  }
  return out;
}
