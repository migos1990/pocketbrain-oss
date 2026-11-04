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
