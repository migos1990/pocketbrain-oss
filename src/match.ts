// SPDX-License-Identifier: AGPL-3.0-only
// One matcher for "does this text carry a value it shouldn't", shared by the relay and the
// write path's leak tripwire so the two choke points can't drift apart (eval gaps G4, G5).
// It catches the cheap tricks: spacing, dashes, line breaks, case, zero-width and look-alike
// letters, base64/hex/URL encoding, HTML entities, reformatted amounts, and a distinctive part
// of a multi-word value. What it doesn't catch is a row in test/ceilings.test.ts (LEAK_CEILING);
// paraphrase is out of reach of any matcher, and architecture 0.7 accepts that.

// Common look-alikes from Cyrillic and Greek (capitals too: squash folds case after this map),
// and the dotless i, mapped to Latin.
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "к": "k", "м": "m", "т": "t", "в": "b", "н": "h", "і": "i", "ј": "j", "ѕ": "s",
  "А": "a", "В": "b", "Е": "e", "К": "k", "М": "m", "Н": "h", "О": "o", "Р": "p", "С": "c", "Т": "t", "Х": "x", "У": "y", "І": "i",
  "α": "a", "ο": "o", "ρ": "p", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "τ": "t", "υ": "u", "χ": "x",
  "Α": "a", "Β": "b", "Ε": "e", "Ζ": "z", "Η": "h", "Ι": "i", "Κ": "k", "Μ": "m", "Ν": "n", "Ο": "o", "Ρ": "p", "Τ": "t", "Υ": "y", "Χ": "x",
  "ı": "i",
};

// Zero-width characters and look-alike forms can't hide a value from the checks.
export const unhide = (s: string) => s.normalize("NFKC").replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, "");

// A value worth watching for: not short, not shown to the agent anyway, not a date, a single
// lowercase word or a link. Generic values ("account", "active") match too much prose.
export function distinctive(s: string, shown: Set<string>): boolean {
  return !(s.length < 4 || shown.has(s.toLowerCase()) || /^\d{4}(-\d{2}){0,2}$/.test(s) || /^[a-z]+$/.test(s) || /^\[\[/.test(s));
}

// Look-alike letters mapped to Latin; everything else kept as is.
export const foldLookalikes = (s: string) => [...s].map((c) => CONFUSABLES[c] ?? c).join("");

// Letters and digits only, lower case, accents and look-alikes folded. Short strings are
// remembered: the same words are squashed for every carve (shownWords).
const squashed = new Map<string, string>();
export function squash(s: string): string {
  const hit = squashed.get(s);
  if (hit !== undefined) return hit;
  const out = [...s.normalize("NFKC")].map((c) => CONFUSABLES[c] ?? c).join("")
    .normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  if (s.length <= 64) { if (squashed.size >= 200_000) squashed.clear(); squashed.set(s, out); }
  return out;
}

// HTML entities: numeric (&#77; &#x4D;), the few named ones that carry text, and accented
// letters (&eacute; -> e, accents are folded anyway). Anything else is left as written.
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", shy: "", zwj: "", zwnj: "" };
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6}));?|&([a-z][a-z0-9]{1,31});/gi, (m, dec, hex, name) => {
    const cp = dec ? Number(dec) : hex ? parseInt(hex, 16) : undefined;
    if (cp !== undefined) return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    const n = String(name);
    return NAMED[n.toLowerCase()] ?? (/^[a-z](acute|grave|circ|uml|tilde|cedil|ring|slash|caron)$/i.test(n) ? n[0] : m);
  });
}

// %XX escapes decoded run by run, so one malformed escape ("100%zz") leaves the rest decodable.
// Bytes that aren't valid UTF-8 become U+FFFD, which squash drops.
const decodePercent = (s: string) => s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"));

// The text plus anything hidden in it by encoding. Callers pass the text as written: base64 is
// case-sensitive, so lower-casing first loses it (G113).
export function decodedVariants(text: string): string[] {
  const out = [text];
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{12,}={0,2}/g)) {
    try {
      const d = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      if (/^[\p{L}\p{N}\p{P}\p{Zs}]{6,}$/u.test(d)) out.push(d);
    } catch { /* not base64 */ }
  }
  for (const m of text.matchAll(/\b(?:[0-9a-f]{2}){6,}\b/gi)) {
    const d = Buffer.from(m[0], "hex").toString("utf8");
    if (/^[\p{L}\p{N}\p{P}\p{Zs}]{6,}$/u.test(d)) out.push(d);
  }
  const ent = /&#?[a-z0-9]+;?/i.test(text) ? decodeEntities(text) : text;
  if (ent !== text) out.push(ent);
  for (const t of new Set([text, ent])) if (/%[0-9a-f]{2}/i.test(t)) out.push(decodePercent(t));
  return out;
}

// An amount reduced to its integer digits: "CAD 412500.00", "412,500 $", "412 500" -> "412500".
export function amountDigits(s: string): string | undefined {
  const m = s.replace(/[\s,'  ]/g, "").match(/(\d{4,})(?:[.,]\d{1,2})?/);
  return m ? m[1] : undefined;
}

export interface Needle { value: string; from: string; squashed: string; digits?: string; parts: string[] }

// Turn a carved value into what to look for. `common` holds squashed words the reader is
// shown anyway, so a fragment made only of those doesn't count as distinctive.
// What a value's needle is before `common` is known, worked out once per value: carves of a
// large brain turn thousands of values into needles on every cell update (docs/perf.md).
const needleBases = new Map<string, { squashed: string; digits?: string; pairs: [string, string, string][] } | null>();
export function needleFor(value: string, from: string, common: Set<string> = new Set()): Needle | undefined {
  let base = needleBases.get(value);
  if (base === undefined) {
    const squashed = squash(value);
    const isAmount = /\d/.test(value) && /^[\p{Sc}A-Z]{0,4}\s*[\d\s.,' ]+\s*[\p{Sc}A-Z]{0,4}$/u.test(value.trim());
    const digits = isAmount ? amountDigits(value) : undefined;
    // Any two consecutive words of 4+ letters, unless both are words the reader sees anyway.
    const words = value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const pairs: [string, string, string][] = [];
    if (words.length >= 3) for (let i = 0; i + 1 < words.length; i++) {
      const [a, b] = [words[i], words[i + 1]];
      if (a.length >= 4 && b.length >= 4) pairs.push([squash(a), squash(b), squash(a + b)]);
    }
    base = squashed.length < 6 && !digits ? null : { squashed, digits, pairs };
    if (needleBases.size >= 200_000) needleBases.clear();
    needleBases.set(value, base);
  }
  if (!base) return undefined;
  const parts = base.pairs.filter(([a, b]) => !(common.has(a) && common.has(b))).map(([, , p]) => p);
  return { value, from, squashed: base.squashed, digits: base.digits, parts };
}

// The needles indexed by the first K letters of each form, so a text is scanned once per
// variant instead of once per needle: a large brain carves thousands of values (docs/perf.md).
const K = 6;
interface NeedleIndex { byPrefix: Map<string, [number, string][]>; byDigits: Map<string, number[]>; short: [number, string][] }
const indexCache = new WeakMap<Needle[], NeedleIndex>();
function indexOf(needles: Needle[]): NeedleIndex {
  let ix = indexCache.get(needles);
  if (ix) return ix;
  ix = { byPrefix: new Map(), byDigits: new Map(), short: [] };
  const put = (form: string, i: number) => { const k = form.slice(0, K); (ix!.byPrefix.get(k) ?? ix!.byPrefix.set(k, []).get(k)!).push([i, form]); };
  needles.forEach((n, i) => {
    if (n.squashed.length >= K) put(n.squashed, i);
    for (const p of n.parts) if (p.length >= K) put(p, i); else ix!.short.push([i, p]);
    if (n.digits) (ix!.byDigits.get(n.digits) ?? ix!.byDigits.set(n.digits, []).get(n.digits)!).push(i);
  });
  indexCache.set(needles, ix);
  return ix;
}

// What findCarried compares needles with: the text and what is encoded in it, squashed, and its
// runs of four or more digits (thousands separators dropped).
export function carriedForms(text: string): { sq: string[]; digitRuns: Set<string> } {
  const variants = decodedVariants(text);
  return { sq: variants.map(squash), digitRuns: new Set(variants.flatMap((v) => [...v.replace(/(\d)[\s,'  ](?=\d{3}\b)/g, "$1").matchAll(/\d{4,}/g)].map((m) => m[0]))) };
}

// The first needle the text carries, in any of the forms above: the earliest in `needles`
// whose squashed value or distinctive part is inside the squashed text, or whose amount digits
// appear as a run of digits.
export function findCarried(text: string, needles: Needle[]): Needle | undefined {
  const { sq, digitRuns } = carriedForms(text);
  const ix = indexOf(needles);
  let best = Infinity;
  for (const d of digitRuns) for (const i of ix.byDigits.get(d) ?? []) if (i < best) best = i;
  for (const s of sq) for (let at = 0; at + K <= s.length; at++) {
    for (const [i, form] of ix.byPrefix.get(s.slice(at, at + K)) ?? []) if (i < best && s.startsWith(form, at)) best = i;
  }
  // A part shorter than K can't be indexed; check those few one by one.
  for (const [i, p] of ix.short) if (i < best && sq.some((s) => s.includes(p))) best = i;
  return best === Infinity ? undefined : needles[best];
}

// A short name (title, alias) with every carried needle replaced by [withheld]: the smallest run of
// words that carries a whole needle is cut ("Joe at Maple-Trust Bank" keeps "Joe at"), else the
// smallest run carrying a part of one. A needle no run of words carries (an encoded value)
// withholds the whole name.
export function withholdIn(name: string, needles: Needle[]): string {
  const whole = (t: string) => { const q = squash(t); return needles.some((n) => n.squashed.length >= 6 && q.includes(n.squashed)); };
  const any = (t: string) => !!findCarried(t, needles);
  // Most names carry nothing: one indexed look settles it (the loop below changes a name only where
  // findCarried finds a needle). Trying every needle on every name made a large carve's names pass
  // take seconds (docs/perf.md).
  if (!needles.length || !findCarried(name, needles)) return name;
  let out = name;
  for (let guard = 0; guard < 8 && needles.length && any(out); guard++) {
    const words = [...out.matchAll(/[\p{L}\p{N}]+/gu)];
    const smallest = (hit: (t: string) => boolean): [number, number] | undefined => {
      for (let len = 1; len <= words.length; len++)
        for (let i = 0; i + len <= words.length; i++) {
          const a = words[i].index!, b = words[i + len - 1].index! + words[i + len - 1][0].length;
          if (hit(out.slice(a, b))) return [a, b];
        }
      return undefined;
    };
    const cut = smallest(whole) ?? smallest(any);
    if (!cut) return "[withheld]";
    out = out.slice(0, cut[0]) + "[withheld]" + out.slice(cut[1]);
  }
  return out;
}
