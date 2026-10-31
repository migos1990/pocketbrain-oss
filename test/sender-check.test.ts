// SPDX-License-Identifier: AGPL-3.0-only
// Who sent the mail (outside review 2026-10-25, G420): filing never checked it, so a stranger's
// mail could file a private or money fact, or silently replace a value the brain held. A pulled
// capture now records only sender: known | unknown (never the address). Known: an address a
// person page holds on trusted evidence. Standing (whom the owner wrote to) never vouches for a
// sender: it sets priority, never trust (CLAUDE.md invariant 14). The filing path asks unknownSenderWait whether such a fact must wait for the owner.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { senderStanding, captureSender, unknownSenderWait } from "../src/sender";
import { recordInteraction } from "../src/standing";
import { saveNote, loadBrain } from "../src/brain";
import { pullSource } from "../src/pull";
import { makeModel } from "../src/model";

test("a trusted address on a person page is known; someone the owner only wrote to, or anyone else, isn't", () => {
  const root = makeBrain();
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(join(root, "rules/standing.yaml"), "me: [me@example.org]\npeople: {}\n");
  recordInteraction(root, { kind: "gmail", from: "Me <me@example.org>", to: "Pal <pal@example.org>", at: "2026-10-01T10:00:00Z", sent: true });
  recordInteraction(root, { kind: "gmail", from: "Spam <spam@example.net>", to: "me@example.org", at: "2026-10-01T10:00:00Z", sent: false });
  expect(senderStanding(root, "pal@example.org")).toBe("unknown");
  expect(senderStanding(root, "Spam <spam@example.net>")).toBe("unknown");
  expect(senderStanding(root, undefined)).toBeUndefined();
  const n = loadBrain(root).find((x) => x.fm.type === "person")!;
  n.fm.facts = { ...(n.fm.facts ?? {}), email: { value: "friend@example.com", as_of: "2026-10-01", sources: ["owner:2026-10-01/inbox/x"], verification: "confirmed-by-owner", by: "owner", recorded: "2026-10-01" } as never };
  saveNote(root, n);
  expect(senderStanding(root, "Friend <friend@example.com>")).toBe("known");
});

test("an unknown sender's private or money fact waits; anything else, or a known sender, doesn't", () => {
  expect(unknownSenderWait("unknown", { sensitive: true })).toMatch(/none of your people pages hold/);
  expect(unknownSenderWait("unknown", { sensitive: false })).toBeUndefined();
  expect(unknownSenderWait("known", { sensitive: true })).toBeUndefined();
  expect(unknownSenderWait(undefined, { sensitive: true })).toBeUndefined();
});

test("a pulled mail's capture says known or unknown, and never stores the address", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules/standing.yaml"), "me: [me@example.org]\npeople: {}\n");
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  mail:\n    kind: gmail\n    fixture: fx.json\n");
  const mail = (id: string, from: string) => ({ id, threadId: id, internalDate: String(Date.parse("2026-10-07T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: from }, { name: "To", value: "me@example.org" }, { name: "Subject", value: "Course" }] }, text: "The course next step is to grade the midterm exams by Friday afternoon for everyone." });
  writeFileSync(join(root, "fx.json"), JSON.stringify([mail("aaaaaaaaaaaaaaa1", "Stranger <stranger@example.net>")]));
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [] }) });
  await pullSource(root, "mail", { model });
  const dir = join(root, "inbox/captures");
  const files = readdirSync(dir);
  expect(files.length).toBe(1);
  const text = readFileSync(join(dir, files[0]), "utf8");
  expect(text).toContain("sender: unknown");
  expect(text).not.toContain("stranger@example.net");
  expect(captureSender(root, { capture: `inbox/captures/${files[0]}` })).toBe("unknown");
  expect(captureSender(root, {})).toBeUndefined();
});

// Audit v3 (2026-10-26): a gmail capture pulled after G420 carried no sender. A mail with no From
// header got no sender field at all, and a capture without one is judged as if from before G420,
// so a stranger could skip the check by leaving From out. A mail or text nobody can be named as
// sending is unknown.
test("a pulled mail with no From header is an unknown sender, not one the check skips", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules/standing.yaml"), "me: [me@example.org]\npeople: {}\n");
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  mail:\n    kind: gmail\n    fixture: fx.json\n");
  const mail = { id: "aaaaaaaaaaaaaab2", threadId: "aaaaaaaaaaaaaab2", internalDate: String(Date.parse("2026-10-07T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "To", value: "me@example.org" }, { name: "Subject", value: "Course" }] }, text: "The course next step is to grade the midterm exams by Friday afternoon for everyone." };
  writeFileSync(join(root, "fx.json"), JSON.stringify([mail]));
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [] }) });
  await pullSource(root, "mail", { model });
  const files = readdirSync(join(root, "inbox/captures"));
  expect(files.length).toBe(1);
  expect(captureSender(root, { capture: `inbox/captures/${files[0]}` })).toBe("unknown");
});

// Slice audit 2026-10-25: texts are pulled with a phone or handle sender, and only email was
// matched, so every text would have waited once filing uses the rule.
test("a text from a phone a person page holds on trusted evidence is known", () => {
  const root = makeBrain();
  const n = loadBrain(root).find((x) => x.fm.type === "person")!;
  n.fm.facts = { ...(n.fm.facts ?? {}), phone: { value: "+1 514 555 0100", as_of: "2026-10-01", sources: ["owner:2026-10-01/inbox/x"], verification: "confirmed-by-owner", by: "owner", recorded: "2026-10-01" } as never };
  saveNote(root, n);
  expect(senderStanding(root, "+15145550100")).toBe("known");
  expect(senderStanding(root, "(514) 555-0100")).toBe("known");
  expect(senderStanding(root, "+15145550199")).toBe("unknown");
});
