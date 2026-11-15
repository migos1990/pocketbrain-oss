// SPDX-License-Identifier: AGPL-3.0-only
// Contract for src/standing.ts: what who_is may say about the person behind an address. Standing
// sets priority, never access or trust (invariant 14). A bug fixed in standing.ts adds a row here.
// Not in registry.ts: its set mirrors the merge gate's access-core list, which only the owner changes.
import { test, expect } from "bun:test";
import * as core from "../../src/core";
import { recordInteraction, suggestStanding } from "../../src/standing";
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

test("contract standing: a name a sender gave itself never ties its traffic to a page, at any count (G829)", () => {
  const rows: [string, { from?: string; to?: string; sent: boolean }[]][] = [
    ["a spoofed From name, never answered", Array.from({ length: 12 }, () => ({ from: "Sam Roy <x@evil.example>", sent: false }))],
    ["a spoofed From name, answered at the bare address", [...Array.from({ length: 6 }, () => ({ from: "Sam Roy <x@evil.example>", sent: false })), ...Array.from({ length: 3 }, () => ({ to: "x@evil.example", sent: true }))]],
    ["a first.last address the owner never wrote to", Array.from({ length: 12 }, () => ({ from: "sam.roy@evil.example", sent: false }))],
    // A reply's To line repeats the sender's chosen name: it counts for nothing once they wrote first (G881).
    ["a spoofed From name, then replies that repeat it", [...Array.from({ length: 3 }, () => ({ from: "Sam Roy <x@evil.example>", sent: false })), ...Array.from({ length: 3 }, () => ({ to: "Sam Roy <x@evil.example>", sent: true }))]],
    ["a name hidden behind a quoted comma", [...Array.from({ length: 3 }, () => ({ to: '"x, Sam Roy" <y@evil.example>', sent: true })), ...Array.from({ length: 3 }, () => ({ from: "y@evil.example", sent: false }))]],
  ];
  for (const [what, mails] of rows) {
    const root = brain({ people: {} });
    mails.forEach((m, i) => recordInteraction(root, { kind: "gmail", from: m.sent ? "me" : m.from, to: m.sent ? m.to : "robin@example.com", at: `2026-10-01T${String(i).padStart(2, "0")}:00:00Z`, sent: m.sent }));
    expect([what, suggestStanding(root).map((x) => x.person)]).toEqual([what, []]);
  }
});

test("contract standing: an address under an attribute that is not the person's own address attribute never resolves who_is to that page (G880)", () => {
  const { writeFileSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { git } = require("../../src/git") as typeof import("../../src/git");
  for (const attr of ["assistant_email", "spouse_email", "work_email", "old_email"]) {
    const root = brain({ people: { "people/sam-roy": { tier: "close", authority: "them" } } });
    const f = join(root, "people", "sam-roy.md"), text = readFileSync(f, "utf8");
    writeFileSync(f, text.replace(/\nfacts:\n/, `\nfacts:\n  ${attr}: { value: "other@elsewhere.example", as_of: 2026-10-01, sources: ["owner:2026-10-01/notes"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }\n`));
    expect(readFileSync(f, "utf8")).toContain(`${attr}: { value: "other@elsewhere.example"`);
    git(root, ["add", "-A"]); git(root, ["commit", "-qm", "owner: an address of someone else"], "owner");
    expect([attr, core.whoIs(root, "steward", "other@elsewhere.example").standing as unknown]).toEqual([attr, { tier: "unknown" }]);
  }
});
