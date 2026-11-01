// SPDX-License-Identifier: AGPL-3.0-only
// Who sent a pulled message (outside review 2026-10-25, G420). Filing never looked, so a
// stranger's mail could file a private or money fact, or replace a value the brain held. A pull
// records on its capture only `sender: known | unknown`, never the address (tracked files never
// hold addresses). Known: an address a person page (the owner's own included) holds on the owner's
// word or a source checked and found (G615). Standing and the contacts log never count (CLAUDE.md invariant 14:
// standing sets priority, never trust), so whom the owner wrote to doesn't vouch for a sender.
// Filing asks unknownSenderWait before a pulled fact files itself (src/filing.ts fileVerdict), and the
// save path refuses the hub's own accept of one that should have waited (src/write.ts decideOne,
// G429), so no tick or retry files it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadBrain } from "./brain";
import { loadRules } from "./rules";
import { trustedAddresses, normalizeAddress, type AddressKind } from "./sameperson";
import { checkedRefs } from "./louis";

export type SenderStanding = "known" | "unknown";


// undefined: no sender to judge (a calendar event, a note, a document, or a mail with no From:
// the pull records that one as unknown).
export function senderStanding(root: string, from: string | undefined): SenderStanding | undefined {
  if (!from || !from.trim()) return undefined;
  if (from === "me") return "known";
  // A mail's From line, or a text's phone number or handle, in the form person pages key them by.
  const keys = new Set((["email", "phone", "handle"] as AddressKind[]).map((k) => { const a = normalizeAddress(k, from); return a ? `${k}:${a}` : ""; }).filter(Boolean));
  if (!keys.size) return "unknown";
  const rules = loadRules(root), checked = checkedRefs(root);
  for (const n of loadBrain(root)) {
    if (n.fm.type !== "person" || n.fm.status === "archived") continue;
    for (const key of trustedAddresses(n, rules, checked, { found: true }).keys()) if (keys.has(key)) return "known";
  }
  return "unknown";
}

// What a proposal's capture recorded (proposals from a pull carry `capture: inbox/captures/…`).
export function captureSender(root: string, proposal: { capture?: unknown }): SenderStanding | undefined {
  if (typeof proposal.capture !== "string") return undefined;
  const f = join(root, proposal.capture);
  if (!existsSync(f)) return undefined;
  const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(f, "utf8"));
  const s = m ? (YAML.parse(m[1]) as { sender?: unknown } | null)?.sender : undefined;
  return s === "known" || s === "unknown" ? s : undefined;
}

// Why a pulled fact waits for the owner, or undefined to file it. sensitive: private, money,
// health or legal. A different value from an unknown sender is weighed like any other (a newer,
// as-strong one updates with Undo, anything else is a conflict held for the Gardener): waiting on
// it asked about every ordinary change, since few senders are on a page on trusted evidence (north
// star: 29 asks instead of 3; G429). A capture without the field (before G420, or not mail) is
// judged as before.
export function unknownSenderWait(sender: SenderStanding | undefined, f: { sensitive: boolean }): string | undefined {
  if (sender !== "unknown") return undefined;
  if (f.sensitive) return "It came from an address none of your people pages hold, and it's private, so you decide it.";
  return undefined;
}
