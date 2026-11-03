// SPDX-License-Identifier: AGPL-3.0-only
// Audit v11 High 2 (G643): a mail id the hub has already read still vouched for any address an
// assistant planted. G615 (audit v10) closed the unchecked-id case: a source-verified address
// counted once any ref it cites was checked and found. But "found" said only that the mail
// exists, not that the address is in it, so an assistant could cite a real mail it saw and plant
// any address as a known sender. A read mail now vouches only for the address it came from: the
// hub records the hash of each read item's From (log/refs-checked.jsonl), never the address.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { senderStanding } from "../src/sender";
import { pullSource } from "../src/pull";
import { makeModel } from "../src/model";
import { loadBrain } from "../src/brain";

const REF = "gmail:aaaaaaaaaaaaaab1";
const person = (root: string) => loadBrain(root).filter((n) => n.fm.type === "person" && n.fm.area === "work");

async function readOneMail(root: string, from: string) {
  writeFileSync(join(root, "rules/standing.yaml"), "me: [me@example.org]\npeople: {}\n");
  writeFileSync(join(root, "rules/sources.yaml"), "sources:\n  mail:\n    kind: gmail\n    fixture: fx.json\n");
  const mail = { id: REF.slice(6), threadId: REF.slice(6), internalDate: String(Date.parse("2026-10-07T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: from }, { name: "To", value: "me@example.org" }, { name: "Subject", value: "Hello" }] }, text: "Short note." };
  writeFileSync(join(root, "fx.json"), JSON.stringify([mail]));
  const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: () => JSON.stringify({ facts: [] }) });
  await pullSource(root, "mail", { model });
}
const plant = (root: string, id: string, value: string) =>
  write(root, { agent: "planner", id, attribute: "email", value, as_of: "2026-10-07", sources: [REF], verification: "verified-by-source" } as never);

test("a mail the hub read vouches only for the address it came from, never one an assistant plants", async () => {
  const root = makeBrain();
  await readOneMail(root, "Real Sender <real@example.com>");
  const [a] = person(root);
  const r = plant(root, a!.fm.id, "planted@evil.example");
  expect(r.outcome).toBe("committed");
  expect(senderStanding(root, "planted@evil.example")).toBe("unknown");
  expect(senderStanding(root, "Someone <planted@evil.example>")).toBe("unknown");
});

test("the same read mail still makes its own sender known", async () => {
  const root = makeBrain();
  await readOneMail(root, "Real Sender <real@example.com>");
  const [a] = person(root);
  expect(plant(root, a!.fm.id, "real@example.com").outcome).toBe("committed");
  expect(senderStanding(root, "Real Sender <real@example.com>")).toBe("known");
});

test("the hub keeps the sender's hash, never the address, beside the ref it read", async () => {
  const root = makeBrain();
  await readOneMail(root, "Real Sender <real@example.com>");
  const log = readFileSync(join(root, "log", "refs-checked.jsonl"), "utf8");
  expect(log).toContain(REF);
  expect(log).not.toContain("real@example.com");
});

test("a ref checked before senders were kept vouches for no address", () => {
  const root = makeBrain();
  const [a] = person(root);
  // The fixture's mailbox is recorded found with no sender, like a brain's log before G643.
  const r = write(root, { agent: "planner", id: a!.fm.id, attribute: "email", value: "old@example.com", as_of: "2026-10-07", sources: ["gmail:f000000000000001"], verification: "verified-by-source" } as never);
  expect(r.outcome).toBe("committed");
  expect(senderStanding(root, "old@example.com")).toBe("unknown");
});
