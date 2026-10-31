// SPDX-License-Identifier: AGPL-3.0-only
// The copy contract (phone UI spec §3, owner 2026-10-26): the owner reads their own words, never
// the system's. Every owner-facing string of the new screens is checked here for the forbidden
// words; a new screen adds its strings to OWNER_FACING.
import { test, expect } from "bun:test";
import { OWNER_SAY } from "../src/owner-errors";
import { HOME_COPY } from "../src/dashboard/html-home";
import { fromWords, LINE_COPY } from "../src/dashboard/home";
import { PAGE_COPY } from "../src/dashboard/html-page";
import { SETTLE_COPY } from "../src/dashboard/html-settle";
import { APP_COPY } from "../src/dashboard/html-app";

export const FORBIDDEN = ["proposal", "propose", "dispute", "slice", "carve", "verification", "verified", "candidate", "step", "tier", "inbox", "deck", "card", "yaml", "fact_key", "undo_token"];
const FILE_PATH = /\b[\w-]+\/[\w-]+\.(md|ya?ml|jsonl?|ts)\b|\brules\//;

const OWNER_FACING: Record<string, string[]> = {
  "owner-say replies": Object.values(OWNER_SAY),
  "home page": Object.values(HOME_COPY),
  "the memories' sentences": Object.values(LINE_COPY),
  "the four tabs": Object.values(APP_COPY),
  "page screen": Object.values(PAGE_COPY),
  "settle screen": Object.values(SETTLE_COPY),
  "diary line sources": ["you", "email", "calendar", "notion", "assistant", "none"].map((w) => fromWords({ source_word: w, by: "helper" } as never, { policy: { agents: {} } } as never)),
};

for (const [where, strings] of Object.entries(OWNER_FACING)) {
  test(`${where} use the owner's words`, () => {
    const bad = strings.flatMap((s) => [...FORBIDDEN.filter((w) => new RegExp(`\\b${w}`, "i").test(s)).map((w) => `"${w}" in: ${s}`), ...(FILE_PATH.test(s) ? [`a file path in: ${s}`] : [])]);
    expect(bad).toEqual([]);
  });
}

test("the two first words: Here's what I have (nothing written) and Noted (written)", () => {
  expect(OWNER_SAY["say.noted"]).toStartWith("Noted:");
  for (const id of ["say.lookup", "say.no-match", "say.already", "say.later", "say.refused", "say.act"] as const) expect(OWNER_SAY[id]).toStartWith("Here's what I have:");
});
