// SPDX-License-Identifier: AGPL-3.0-only
// G980: the ledger of machine mail (log/machine-mail.jsonl) only held mail a pull skipped or a
// recheck read after the skip rule existed. A no-reply mail the hub read and filed from before the
// rule was never in it, so `machine-mail on` left its facts where they were. The night pass now
// counts the mail refs live facts cite that were never classified, and with the switch on reads each
// once by the hub's own read-one path, which records a machine's mail in the ledger.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { machineMail, recordCheckedRefs } from "../src/louis";
import { classifyOldMail, oldMailRefs, setAsideMachineMail } from "../src/receipt-pages";
import { fetchOne } from "../src/pull";

const ROBOT = "gmail:d0000000000000c1", PERSON = "gmail:d0000000000000c2", GONE = "gmail:d0000000000000c3";
const mail = (id: string, from: string) => ({ id, labelIds: ["INBOX", "CATEGORY_UPDATES"], internalDate: "1791000000000", payload: { headers: [{ name: "Subject", value: `Letter ${id}` }, { name: "From", value: from }] }, snippet: "x" });
// The sample brain cites a few mails of its own; the mailbox here doesn't have them.
let base = 0;
function brain() {
  const root = makeBrain();
  base = oldMailRefs(root).length;
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { post: { kind: "gmail", fixture: "post.json", consent: "owner 2026-10-01" } } }));
  writeFileSync(join(root, "post.json"), JSON.stringify([mail("d0000000000000c1", "Depot <no-reply@depot.example>"), mail("d0000000000000c2", "Ines Vale <ines@studio.example>")]));
  git(root, ["add", "rules/sources.yaml"]); git(root, ["commit", "-q", "-m", "owner: a mailbox"]);
  recordCheckedRefs(root, { [ROBOT]: true, [PERSON]: true, [GONE]: true });
  const say = (attribute: string, value: string, ref: string) => write(root, { agent: "planner", id: "projects/course-b", attribute, value, as_of: "2026-10-05", sources: [ref], verification: "verified-by-source" } as never).outcome;
  expect(say("parking_note", "Gate nine opens for vans at dawn", ROBOT)).toBe("committed");
  expect(say("seating_note", "Chairs arrive folded on Thursday", PERSON)).toBe("committed");
  expect(say("signage_note", "Arrows are taped along the ramp", GONE)).toBe("committed");
  return root;
}

test("G980: with the switch off the old mail is only counted, nothing is read", async () => {
  const root = brain();
  let reads = 0;
  const r = await classifyOldMail(root, false, { fetch: async (rt, ref) => { reads++; return fetchOne(rt, ref); } });
  expect(r).toEqual({ waiting: base + 3, checked: 0, found: 0 });
  expect(reads).toBe(0);
  expect(machineMail(root).size).toBe(0);
  expect(setAsideMachineMail(root, false).facts).toBe(0);
});

test("G980: with the switch on each old mail is read once, a machine's lands in the ledger and its fact is set aside", async () => {
  const root = brain();
  let reads = 0;
  const fetch = async (rt: string, ref: string) => { reads++; return fetchOne(rt, ref); };
  const r = await classifyOldMail(root, true, { fetch });
  expect(r.waiting).toBe(base + 3);
  expect(r.found).toBe(1);
  expect([...machineMail(root)]).toEqual(["gmail:d0000000000000c1"]);
  expect(setAsideMachineMail(root, true).facts).toBe(1);
  // Read once: the person's mail and the one the mailbox no longer has are not asked for again.
  const before = reads;
  const again = await classifyOldMail(root, true, { fetch });
  expect(again.checked).toBe(0);
  expect(reads).toBe(before);
});

test("G980: a mail the hub could not reach is tried again, and a night reads no more than its cap", async () => {
  const root = brain();
  const down = await classifyOldMail(root, true, { fetch: async () => "ECONNRESET" });
  expect(down).toEqual({ waiting: base + 3, checked: 0, found: 0 });
  const capped = await classifyOldMail(root, true, { max: 1 });
  expect(capped.checked).toBe(1);
  expect((await classifyOldMail(root, true, { max: 1 })).waiting).toBe(base + 2);
});

test("G980: mail that can never be read does not keep the rest from being classified (code review of PR 236)", async () => {
  const root = brain();
  // The first refs in line fail for a reason that will not clear; a night reads two.
  const all = oldMailRefs(root), stuck = new Set(all.slice(0, 2));
  const tried: string[] = [];
  const fetch = async (rt: string, ref: string) => { tried.push(ref); return stuck.has(ref) ? "outside the allowlist" : fetchOne(rt, ref); };
  expect((await classifyOldMail(root, true, { max: 2, fetch })).checked).toBe(0);
  const second = await classifyOldMail(root, true, { max: 2, fetch });
  expect(tried.slice(2).some((x) => stuck.has(x))).toBe(false);
  expect(second.checked).toBe(Math.min(2, all.length - 2));
  // Still waiting, and tried again once everything else was read.
  for (let i = 0; i < all.length; i++) await classifyOldMail(root, true, { max: 2, fetch });
  expect(oldMailRefs(root).sort()).toEqual([...stuck].sort());
  expect(tried.filter((x) => stuck.has(x)).length).toBeGreaterThan(2);
});
