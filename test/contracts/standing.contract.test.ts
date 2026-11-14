// SPDX-License-Identifier: AGPL-3.0-only
// Contract for src/standing.ts: what who_is may say about the person behind an address. Standing
// sets priority, never access or trust (invariant 14). A bug fixed in standing.ts adds a row here.
// Not in registry.ts: its set mirrors the merge gate's access-core list, which only the owner changes.
import { test, expect } from "bun:test";
import * as core from "../../src/core";
import { brain } from "../standing-fixture";

// Sam's address the owner confirmed (and may pin); Jane's came from a mail (verified-by-source).
const SAM = "sam@example.com", JANE = "jane@northfield.example";
type Entry = { tier: "inner" | "close" | "known"; authority?: "owner" | "them"; addresses?: string[] };

test("contract standing: who_is never says 'authority over the owner' through an address the owner did not pin or confirm (G826)", () => {
  const rows: [string, Entry, string, { tier: string; authority?: string }][] = [
    // person, entry, address asked, expected standing
    ["people/jane-roy", { tier: "known", authority: "them" }, JANE, { tier: "known" }], // a mail vouched for it: no authority (G826)
    ["people/sam-roy", { tier: "known", authority: "them" }, SAM, { tier: "known", authority: "them" }], // the owner confirmed it
    ["people/sam-roy", { tier: "close", authority: "them", addresses: [SAM] }, SAM, { tier: "close", authority: "them" }], // pinned
    ["people/sam-roy", { tier: "close", authority: "them", addresses: ["other@example.com"] }, SAM, { tier: "known" }], // not pinned: capped, no authority
    ["people/jane-roy", { tier: "known", authority: "owner" }, JANE, { tier: "known", authority: "owner" }], // the owner's authority only lowers
  ];
  for (const [person, entry, address, want] of rows) {
    const root = brain({ me: ["robin@example.com"], people: { [person]: entry } });
    const w = core.whoIs(root, "steward", address);
    expect([person, entry.tier, address, w.standing as unknown]).toEqual([person, entry.tier, address, want]);
    if (!("authority" in want) || want.authority !== "them") expect(w.guidance).not.toMatch(/authority over the owner/);
  }
});
