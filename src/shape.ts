// SPDX-License-Identifier: AGPL-3.0-only
// Does it look like health, legal or money? Shared by the hub's filing (which leaves such items to
// the owner) and the write path's serving hold (phone UI spec §7: held until the owner has seen it).
import { categoryWords, SENSITIVE_WORDS, wordsRe } from "./checks";
import { hasWord } from "./util";
import type { Rules } from "./rules";

// Health, legal or money in the words of an item, whatever the note. Over-matching only leaves a
// card to the owner. Word edges are any letter, so accented words (santé, payé) match (G129).
// Stems: whole words in any script (checks.ts wordsRe, G129), any letters may follow (lawyers,
// therapist, médecins; G158). Over-matching only leaves a card to the owner.
const W = (words: string) => wordsRe(`(?:${words})\\p{L}*`);
const LEGAL_HEALTH = W("lawyers?|avocats?|attorneys?|solicitors?|notaires?|court|tribunal|trial|procès|legal|juridique|lawsuits?|litiges?|plaintes?|sued|police|garde à vue|prud'?hommes|chemo\\p{L}*|chimio\\p{L}*|cancer|surger|chirurgie|illness|hospital|hôpital|hosto|sick|malad\\p{L}*|doctors?|médecins?|disab\\p{L}*|handicap\\p{L}*|leave|congé|therap\\p{L}*|thérap\\p{L}*|psych\\p{L}*|depress\\p{L}*|dépress\\p{L}*|anxiety|anxiété|MRI|IRM|ICU|HIV|VIH|pregnan\\p{L}*|grossesse|enceinte|diagnos\\p{L}*|santé|health|medical|médical\\p{L}*|medication|médicament\\p{L}*|école|school|divorce|custody|arrest\\p{L}*");
const MONEY_SHAPE = W("budget|salar\\p{L}*|salaire|wages?|income|revenus?|loans?|prêts?|mortgage|hypoth\\p{L}*|rent|loyer|invoices?|factures?|price|prix|costs?|coût\\p{L}*|fees?|frais|paid|payé\\p{L}*|payments?|paiements?|paie|owe[sd]?|refunds?|rembours\\p{L}*|tax\\p{L}*|impôts?|banks?|banque|accounts?|comptes?|cards?|cartes?|IBAN|RIB|virements?|retraite|pension|insurance|assurance\\p{L}*|debt|dettes?|EUR|USD|CAD|GBP|CHF");
const AMOUNT = /[$€£¥]\s?\d|\d\s?([$€£¥]|eur|usd|cad|chf|gbp)(?!\p{L})/iu;

// Words a mail subject uses for money or health paperwork that are too plain to hold back a filing
// on their own ("statement", "claim") but that a held card must never say as a page's name: G568
// rested on the sender being a stranger, and a known sender's "Visa statement" or "Manulife claim"
// still showed (audit v9, 2026-10-31; G585). Used for names only (sensitiveName).
const PAPERWORK = W("statements?|relevés?|claims?|réclamations?|visa|mastercard|amex|american express|interac|credit|crédit|premiums?|primes?|deductibles?|policy|polices?|receipts?|reçus?|billing|facturation|prescriptions?|ordonnances?|dental|dentaire|pharmac\\p{L}*|lab results?");
export function sensitiveName(rules: Rules, name: string): string | undefined {
  return sensitiveShape(rules, name) ?? name.normalize("NFC").match(PAPERWORK)?.[1];
}

export function sensitiveShape(rules: Rules, ...texts: unknown[]): string | undefined {
  const t = texts.map((x) => (typeof x === "string" ? x : JSON.stringify(x ?? ""))).join(" ").replace(/_/g, " ");
  return t.normalize("NFC").match(SENSITIVE_WORDS)?.[1] ?? t.match(LEGAL_HEALTH)?.[1] ?? t.match(MONEY_SHAPE)?.[1] ?? t.match(AMOUNT)?.[0] ?? categoryWords(rules.checks).money.find((w) => hasWord(t, w));
}


// An assistant's reason without the hub's own words about its tier ("a trial agent" is no lawsuit).
export const reasonText = (reason: string) => reason.replace(/\btrial (agent|tier)\b/gi, "");
