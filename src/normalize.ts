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

// Value key (G662): the comparison key, and for a sentence (five words or more) its meaning in
// plain words: articles and the present forms of "to be" dropped ("to retain" and "to be
// retained" say one thing) and each word cut to its stem, so "Use each client to retain…" and
// "use each client to be retained…" are the same value (architecture 0.6 step 1), never a
// conflict. Numbers, negations, tense ("was", "will"), every preposition and every content word
// stay: "build 4" and "build 5", "on track" and "not on track", "was paid" and "will be paid",
// "to Anna by Friday" and "by Anna to Friday" still differ (slice audit). Short values keep the
// exact key.
const GRAMMAR = new Set(["a", "an", "the", "be", "is", "are", "am", "been", "being", "le", "la", "les", "un", "une"]);
const stem = (w: string) => /^\d/.test(w) || w.length <= 4 ? w : w.replace(/(ing|ed|es|s)$/, "").replace(/(.)\1$/, "$1").replace(/e$/, "");
export function valueKey(v: unknown): string {
  const k = compareKey(v);
  if (typeof v !== "string") return k;
  const words = k.split(" ").filter(Boolean);
  if (words.length < 5) return k;
  return "~" + words.filter((w) => !GRAMMAR.has(w)).map(stem).join(" ");
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

