// SPDX-License-Identifier: AGPL-3.0-only
// The brain's owner: the one person whose word outranks every source. The code calls them
// "owner"; their display name comes from rules/policy.yaml `owner.name` (ownerName in rules.ts).
// The first brain was written when the code said "louis", so every "louis" form below is still
// read as the owner: confirmed-by-louis, louis:<date>/<channel> refs, the git author "louis",
// rules/louis-messages.yaml and policy louis_channel. New writes use the owner forms.

export const OWNER = "owner";
export const OWNER_CONFIRMED = "confirmed-by-owner";
export const LEGACY_CONFIRMED = "confirmed-by-louis";

export const isOwnerConfirmed = (v: unknown): boolean => v === OWNER_CONFIRMED || v === LEGACY_CONFIRMED;

// The stored form for new writes.
export function normVerification<T>(v: T): T {
  return (v === LEGACY_CONFIRMED ? OWNER_CONFIRMED : v) as T;
}

// Who counts as the owner when the code asks "did the owner do this?" (git authors, `by`, the
// decider of a proposal). The display name is checked by callers that have the rules.
export function isOwnerId(name: unknown, displayName?: string): boolean {
  if (typeof name !== "string") return false;
  const n = name.trim().toLowerCase();
  return n === OWNER || n === "louis" || (!!displayName && n === displayName.trim().toLowerCase());
}

// A source ref for something the owner said on a channel (inbox, dashboard, text, init…).
export const ownerRef = (date: string, channel: string) => `owner:${date}/${channel}`;
export const OWNER_REF = /^(owner|louis):\d{4}-\d{2}-\d{2}\/.+/;
