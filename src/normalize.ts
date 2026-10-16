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
