// SPDX-License-Identifier: AGPL-3.0-only
// Rows shared by the relay and write contracts (G113-G115): one hidden value (the sample brain's
// bank, hidden from planner and helper) in encodings both choke points must see through, and
// ordinary text with %, & and Greek or Turkish letters that both must let through.
const BANK = "Maple Trust Bank";
const pct = (s: string) => [...Buffer.from(s)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
const ent = (s: string) => [...s].map((c) => `&#${c.codePointAt(0)};`).join("");
export const ENCODED_BANK: [string, string][] = [
  ["base64 (G113)", `Ask ${Buffer.from(BANK).toString("base64")} about fees`],
  ["URL-encoded beside a malformed %zz (G114)", `Ask ${pct(BANK)} about fees, 100%zz sure`],
  ["HTML numeric entities (G115)", `Ask ${ent(BANK)} about fees`],
  ["hex entities and &amp; (G115)", `Ask ${[...BANK].map((c) => `&#x${c.codePointAt(0)!.toString(16)};`).join("")} &amp; co`],
  ["Greek capital look-alikes (G115)", "Ask ΜΑΡLE ΤRUSΤ ΒΑΝΚ about fees"],
];
export const ORDINARY: string[] = [
  "Course A textbook is 50% off, 100%zz typo and all",
  "Tom &amp; Jerry &#8212; the course A screening",
  "Reading list: ΑΘΗΝΑ by Işıl Yıldız",
];
