// SPDX-License-Identifier: AGPL-3.0-only
// Normalizers run before any comparison so "ACME Inc." vs "Acme" style differences
// never become conflicts (architecture 0.6 step 1).
import type { AttributeSpec } from "./rules";

export function normalizeValue(v: unknown, spec: AttributeSpec): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim().replace(/\s+/g, " ");
  switch (spec.normalize) {
    case "email":
      return s.toLowerCase();
    case "e164": {
      const digits = s.replace(/[^\d+]/g, "");
      if (digits.startsWith("+")) return digits;
      if (digits.length === 10) return "+1" + digits; // North American default
      if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
      return digits;
    }
    case "date": {
      const m = s.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
      return m ? [m[1], m[2], m[3]].filter(Boolean).join("-") : s;
    }
    case "money": {
      const m = s.match(/([A-Z]{3})?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})?/);
      if (!m) return s;
      const cur = m[1] ?? m[3] ?? "CAD";
      return `${cur} ${Number(m[2].replace(/,/g, "")).toFixed(2)}`;
    }
    case "link":
      return s.startsWith("[[") ? s : `[[${s}]]`;
    default:
      return s;
  }
}

// Comparison key: case-folded, punctuation-light, legal suffixes dropped.
export function compareKey(v: unknown): string {
  if (typeof v !== "string") return JSON.stringify(v);
  return v
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|corp|sa|sas|gmbh)\b\.?/g, "")
    .replace(/[^\p{L}\p{N}@+]+/gu, " ")
    .trim();
}

// Value key (G662, tightened by audit v13, G759): the comparison key with the sign and the
// currency kept, and for a sentence (five words or more) articles and "is"/"are"/"be" dropped, so a
// sentence said again in other casing, accents, punctuation or with an article more is the same
// value, never a conflict (architecture 0.6 step 1). One rewording folds, the one G662 was filed
// for: "to retain" and "to be retained" (a passive infinitive and its active form), and only for a
// word written in lower case, so never a name. Every other word stays whole: a name and a longer
// name ("Robert", "Roberts"), a place, tense ("expires", "expired", "being signed", "signed"),
// numbers, negations and every preposition differ, and so do "-740" and "740", "$740" and "€740".
// A final "s" alone folds too, on a word written in lower case inside the sentence ("exam",
// "exams"; "move", "moves"): the two can both hold, so it is no conflict and no ask (the owner's
// rule), while a word with a capital, so any name, and a sentence's first word keep theirs. The first key cut every word to a stem; that merged a different
// value in as a source of the first, and an extra ask is cheaper than a silent merge. Short values
// keep the exact key.
const GRAMMAR = new Set(["a", "an", "the", "be", "is", "are", "am", "le", "la", "les", "un", "une"]);
// nearSame's looser word form, for a long sentence said again in another order (below).
const stem = (w: string) => /^\d/.test(w) || w.length <= 4 ? w : w.replace(/(ing|ed|es|s)$/, "").replace(/(.)\1$/, "$1").replace(/e$/, "");
const CURRENCY: Record<string, string> = { "$": "dollarsign", "€": "eurosign", "£": "poundsign", "¥": "yensign" };
// A minus is a sign when it touches the number after it and no letter or digit before it; a dash
// and a space is one only when the value is nothing but the number ("- 740"), else a list mark
// ("- 3 seats"); between words or digits ("sign-in", "2026-10-05", "555-0142") it is punctuation.
const signed = (v: string) => v
  .replace(/(?:^\s*[-\u2212]\s+(?=[$€£¥]?[\d.,\s]+$)|(?<![\p{L}\p{N}])[-\u2212](?=[$€£¥]?\d))/gu, " minussign ")
  .replace(/[$€£¥]/g, (c) => ` ${CURRENCY[c]} `);
// "to be retained" reads as "to retain": only the passive side is rewritten, to the word less its
// "ed" ("planned" to "plan"). The active word is never touched, since "to" is as often a
// preposition before a name ("to anne" is no "to ann"); a verb ending in "e" ("to move", "to be
// moved") therefore stays two values, an ask more and never a silent merge.
const participle = (w: string) => /ed$/.test(w) ? w.replace(/ed$/, "").replace(/([^aeiou])\1$/, "$1") : w;
// One final "s" off a longer word; never "ss", "us" or "is" ("class", "status", "basis").
const singular = (w: string) => w.length >= 5 && /[^sui]s$/.test(w) && !/\d/.test(w) ? w.slice(0, -1) : w;
export function valueKey(v: unknown): string {
  // A number is its own text, sign and all: -740 is "-740" and never 740.
  if (typeof v === "number") return valueKey(String(v));
  if (typeof v !== "string") return compareKey(v);
  const marked = signed(v);
  const k = compareKey(marked);
  const words = k.split(" ").filter(Boolean);
  if (words.length < 5) return k;
  // The same words with their capitals, to tell a name from a verb after "to".
  const cased = marked.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\b(inc|ltd|llc|corp|sa|sas|gmbh)\b\.?/gi, "").replace(/[^\p{L}\p{N}@+]+/gu, " ").trim().split(" ").filter(Boolean);
  const aligned = cased.length === words.length;
  const out = [...words];
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i] !== "to") continue;
    const passive = words[i + 1] === "be", t = passive ? i + 2 : i + 1;
    if (t >= words.length || !aligned || cased[t] !== words[t] || /\d/.test(words[t]) || GRAMMAR.has(words[t])) continue;
    if (passive) out[t] = participle(words[t]);
  }
  if (aligned) for (let i = 1; i < out.length; i++) if (cased[i] === words[i]) out[i] = singular(out[i]);
  return "~" + out.filter((w) => !GRAMMAR.has(w)).join(" ");
}
export const sameValue = (a: unknown, b: unknown) => valueKey(a) === valueKey(b);

// Near the same sentence (G678): a long value said again with its parts in another order and a
// filler word or two more ("Use each client to retain in a flow…" and "use the clients in a flow…,
// for each client you want to retain", a notice's two mails). One side's words, stemmed, are all in
// the other; what the other adds is only filler ("you", "want", "please"), at most three words; most
// of the shorter one's words come in the same order; numbers and negations are the same. Only for
// ten words or more, and never the same words merely reordered (that can swap who does what:
// "to Anna from Paul" and "to Paul from Anna"), so a short value or a changed name still differs.
// Only words that address the reader. No quantifier ("all", "any", "each"), no modal ("need"),
// no pointer ("that"): those change who or what a sentence covers (slice audit of G678). "want"
// and "wish" count only beside "you" or "we" ("for each client you want to retain").
const FILLER = new Set(["you", "your", "we", "our", "want", "wish", "please", "kindly", "vous", "nous", "votre", "notre", "veuillez", "vouloir", "voulez", "souhaitez"]);
const WHO = new Set(["you", "your", "we", "our", "vous", "nous", "votre", "notre"]);
const NEGATION = new Set(["not", "no", "never", "none", "nor", "without", "ne", "pas", "jamais", "aucun", "aucune", "sans", "non"]);
const stems = (v: string) => compareKey(v).split(" ").filter((w) => w && !GRAMMAR.has(w)).map(stem);
function lcs(a: string[], b: string[]): number {
  const row = new Array(b.length + 1).fill(0);
  for (const x of a) { let prev = 0; for (let j = 1; j <= b.length; j++) { const t = row[j]; row[j] = x === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]); prev = t; } }
  return row[b.length];
}
export function nearSame(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (valueKey(a) === valueKey(b)) return true;
  let x = stems(a), y = stems(b);
  if (x.length < 10 || y.length < 10) return false;
  if (x.length > y.length) [x, y] = [y, x];
  const nums = (w: string[]) => w.filter((t) => /\d/.test(t)).sort().join(" ");
  const negs = (w: string[]) => w.filter((t) => NEGATION.has(t)).sort().join(" ");
  if (nums(x) !== nums(y) || negs(x) !== negs(y)) return false;
  const sx = new Set(x), sy = new Set(y);
  if (![...sx].every((t) => sy.has(t))) return false;
  const extra = [...sy].filter((t) => !sx.has(t));
  if (!extra.length || extra.length > 3 || !extra.every((t) => FILLER.has(t))) return false;
  if (extra.some((t) => !WHO.has(t) && !["please", "kindly", "veuillez"].includes(t)) && !extra.some((t) => WHO.has(t))) return false;
  return lcs(x, y) >= 0.75 * x.length;
}

