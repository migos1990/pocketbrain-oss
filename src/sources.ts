// SPDX-License-Identifier: AGPL-3.0-only
// Source refs are `scheme:id` (memory-shape.md section 5). Rank feeds conflict step 5.
import type { FactRecord, SourceRef } from "./brain";
import { isOwnerConfirmed, OWNER_REF } from "./owner";

export const SCHEMES: Record<string, "louis" | "exact" | "vague" | "self" | "none"> = {
  imsg: "louis",
  louis: "louis",
  owner: "louis",
  gmail: "exact",
  "gmail-thread": "exact",
  gcal: "exact",
  // Pulled sources (src/pull.ts): <id>@<version>, so a moved source can be told apart.
  slack: "exact",
  gdoc: "exact",
  zoom: "exact",
  discord: "exact",
  mail: "exact",
  // The owner's texts read from chat.db (src/pull.ts): what someone wrote, not the owner's word to
  // the brain, so exact, unlike imsg: (a message the owner sent the brain itself).
  imessage: "exact",
  granola: "exact",
  // A card in the owner's address book (src/contacts.ts): contacts:<card id>@<version>.
  contacts: "exact",
  doc: "exact",
  url: "exact",
  call: "exact",
  notion: "vague",
  "town-wiki": "vague",
  "instinct-mem": "vague",
  "town-routine": "vague",
  "agent-relay": "vague",
  agent: "self",
  // The owner tapping Yes on a proposal (2026-10-25): a record of the approval, not evidence. It
  // never raises a fact's rank; the fact ranks as the source it cites.
  approved: "none",
  // A line of an agent's own archived log (src/logs.ts): agent-log:<agent>/<hid>.
  "agent-log": "self",
  unverified: "none",
  // A handed-over brain (handover.ts): the previous owner's private refs, kept by kind only.
  prior: "exact",
  "prior-note": "vague",
};

// The schemes a refusal lists. The rest still parse (old brains carry them) but aren't advertised:
// `louis` is the old spelling of `owner`, and the `*-mem`/`*-wiki`/`*-routine` ones are named
// after one owner's assistants; a new agent cites its own memory as `agent:`.
const UNLISTED = new Set(["louis", "instinct-mem", "town-wiki", "town-routine"]);
export const PUBLIC_SCHEMES = Object.keys(SCHEMES).filter((s) => !UNLISTED.has(s));

// Refs that name an agent's own memory, never Louis's word (write-quality N5).
export const AGENT_MEMORY_SCHEMES = new Set(["instinct-mem", "town-wiki", "town-routine", "agent", "agent-relay", "agent-log"]);

// The assistant an assistant ref names (G30: an agent never learns which other assistants exist;
// G722): "agent:<name>/…" or "agent:<name>#…" its name, the one owner's old *-wiki/*-mem/*-routine
// schemes theirs, and "" for a relay or log ref, which may name either side. Undefined for any
// other ref.
export function assistantOf(ref: string): string | undefined {
  const s = schemeOf(ref);
  if (!s || !AGENT_MEMORY_SCHEMES.has(s)) return undefined;
  if (s === "town-wiki" || s === "town-routine") return "town";
  if (s === "instinct-mem") return "instinct";
  return s === "agent" ? (ref.slice(s.length + 1).split(/[/#]/)[0] ?? "").toLowerCase() : "";
}
// What a reader gets for a ref: another assistant's ref as this one, its own as it is (G722).
export const ANOTHER_ASSISTANT = "agent:[withheld]";
export function readerRef(ref: string, reader: string): string {
  const a = assistantOf(ref);
  return a === undefined || (a !== "" && a === reader.toLowerCase()) ? ref : ANOTHER_ASSISTANT;
}
export function readerSource(s: SourceRef, reader: string): SourceRef {
  return typeof s === "string" ? readerRef(s, reader) : { ...s, ref: readerRef(s.ref, reader) };
}
// Every assistant ref in a text a reader gets, and a footnote's "<Name>'s note" for another
// assistant (G723): the page's file keeps them for the owner, who sees which assistant filed what.
const ASSISTANT_REF = /\b(?:agent|agent-relay|agent-log|town-wiki|town-routine|instinct-mem):(?!\[)[^\s,;)\]]+/g;
export function readerText(text: string, reader: string): string {
  const me = reader.toLowerCase();
  const word = (seg: string) => seg.replace(/^([ \t]*)([A-Z][\w-]{0,39})'s note\b/, (m, pre: string, who: string) => who.toLowerCase() === me ? m : `${pre}An assistant's note`);
  return text.replace(ASSISTANT_REF, (m) => readerRef(m, reader))
    .replace(/^(\[\^[^\]\s]+\]:)([^\n]*)$/gm, (_m, label: string, rest: string) => `${label}${rest.split(";").map(word).join(";")}`);
}

export function refString(s: SourceRef): string {
  return typeof s === "string" ? s : s.ref;
}

export function schemeOf(ref: string): string | undefined {
  if (ref === "unverified") return "unverified";
  const m = ref.match(/^([a-z][a-z-]*):/);
  return m && m[1] in SCHEMES ? m[1] : undefined;
}

// A link into a signed-in app (a Slack permalink, a Gmail or Outlook web link, an assistant's
// view-email page): it names a real message, but the hub can't open it to check, and it isn't an
// id the brain can match on. An agent fixing a stale fact from one proposes; the owner confirms.
const LINK_ONLY_HOSTS = /(^|\.)(slack\.com|mail\.google\.com|outlook\.office\.com|outlook\.office365\.com|outlook\.live\.com|teams\.microsoft\.com|discord\.com|town\.com)$/i;
export function isLinkOnly(ref: string): boolean {
  if (!ref.startsWith("url:")) return false;
  try { return LINK_ONLY_HOSTS.test(new URL(ref.slice(4)).hostname); } catch { return false; }
}

// An exact Louis message has an id; a date range (imsg:2026-09-22..2026-09-25) is vague.
export function isExactLouisRef(ref: string): boolean {
  return /^imsg:phonemsg-[0-9A-Z]{20,}$/.test(ref) || OWNER_REF.test(ref);
}

export function decodeGmailM1(token: string): string | undefined {
  // m1.<base64 of the hex id>
  try {
    const hex = Buffer.from(token.replace(/^m1\./, ""), "base64").toString("utf8");
    return /^[0-9a-f]{16}$/.test(hex) ? hex : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeRef(ref: string): string {
  // A bare link is a url: ref.
  if (/^https?:\/\//i.test(ref)) ref = `url:${ref}`;
  const m = ref.match(/^gmail:(m1\.[A-Za-z0-9+/=_-]+)$/);
  if (m) {
    const hex = decodeGmailM1(m[1]);
    if (hex) return `gmail:${hex}`;
  }
  if (ref.startsWith("url:")) {
    try {
      const u = new URL(ref.slice(4));
      // An assistant's "view this email" link (Town's view-email?eid=m1.…) carries the Gmail id:
      // cite the message itself, which is exact and re-checkable, not the assistant's page.
      for (const v of u.searchParams.values()) {
        const hex = /^m1\.[A-Za-z0-9+/=_-]+$/.test(v) ? decodeGmailM1(v) : undefined;
        if (hex) return `gmail:${hex}`;
      }
      for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/.test(k)) u.searchParams.delete(k);
      return "url:" + u.toString();
    } catch {
      return ref;
    }
  }
  return ref;
}

// 5 louis, 4 verified, 3 exact, 2 vague, 1 inferred, 0 unverified.
// The owner's tap on a card (approved:, written only by the hub's accept) or the owner's own word:
// what code that trusts an owner-vouched value (addresses for same-person and standing) accepts.
export const isApprovedRef = (ref: string) => schemeOf(ref) === "approved";
export const ownerVouched = (r: Pick<FactRecord, "sources" | "verification">) => isOwnerConfirmed(r.verification) || (r.sources ?? []).some((x) => isApprovedRef(refString(x)));

export function sourceRank(r: Pick<FactRecord, "sources" | "verification" | "confidence">): number {
  if (r.verification === "unverified") return 0;
  r = { ...r, sources: (r.sources ?? []).filter((x) => schemeOf(refString(x)) !== "approved") };
  // Something another agent said in passing ranks below everything else (architecture 0.7 rule 5).
  if ((r.sources ?? []).length && (r.sources ?? []).every((x) => schemeOf(refString(x)) === "agent-relay")) return 0.5;
  if (r.confidence === "inferred") return 1;
  const refs = (r.sources ?? []).map(refString);
  if (isOwnerConfirmed(r.verification) || refs.some(isExactLouisRef)) return 5;
  if (r.verification === "verified-by-source") return 4;
  if (refs.some((x) => SCHEMES[schemeOf(x) ?? ""] === "exact")) return 3;
  if (refs.some((x) => ["vague", "louis", "self"].includes(SCHEMES[schemeOf(x) ?? ""] ?? ""))) return 2;
  return 0;
}

// Pull every recognisable ref out of free text (Notion "Source" columns, bodies).
export function extractRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/phonemsg-[0-9A-Z]{20,30}/g)) out.add(`imsg:${m[0]}`);
  for (const m of text.matchAll(/\bm1\.[A-Za-z0-9+/=_-]{16,}/g)) {
    const hex = decodeGmailM1(m[0]);
    if (hex) out.add(`gmail:${hex}`);
  }
  const threadIds = new Set<string>();
  for (const m of text.matchAll(/thread\s+(?:id\s+)?([0-9a-f]{16})\b/gi)) {
    threadIds.add(m[1]);
    out.add(`gmail-thread:${m[1]}`);
  }
  for (const m of text.matchAll(/(?<![0-9a-zA-Z-])([0-9a-f]{16})(?![0-9a-zA-Z])/g)) {
    if (!threadIds.has(m[1]) && /[a-f]/.test(m[1]) && /\d/.test(m[1])) out.add(`gmail:${m[1]}`);
  }
  for (const m of text.matchAll(/\bevt1\.[A-Za-z0-9_-]+/g)) out.add(`gcal:${m[0]}`);
  for (const m of text.matchAll(/https?:\/\/[^\s)<>"\]]+/g)) {
    if (!/app\.notion\.com|notion\.so/.test(m[0])) out.add(normalizeRef(`url:${m[0].replace(/[.,;]+$/, "")}`));
  }
  for (const m of text.matchAll(/Instinct memory(?: note)?:?\s+([a-z0-9_\-/]+)/gi)) out.add(`instinct-mem:${m[1]}`);
  return [...out];
}

// An assistant's imported memory cites the capture it came in (`doc:capture/<id>`), but it is that
// assistant's word, so it is kept and ranked as one: `agent:<agent>/capture/<id>` (G587 audit F2).
export function asAgentWord(sources: readonly unknown[], agent: string): string[] {
  return sources.map((x) => {
    const ref = refString(x as never);
    return ref.startsWith("doc:capture/") ? `agent:${agent}/${ref.slice("doc:".length)}` : ref;
  });
}
