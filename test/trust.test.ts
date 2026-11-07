// SPDX-License-Identifier: AGPL-3.0-only
// The trust audit (src/trust.ts, docs/trust.md): every live fact is checked (the owner's word, or
// the hub read its source and found the value), needs a look (source says otherwise, stale,
// guessed, private-looking and shown to an assistant below private) or not checked yet. A
// "verified-by-source" label alone is a claim and never counts as checked. Counts only in what it
// prints. Plus the nightly backfill.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { liveRecords } from "../src/health";
import { factTrust, trustReport, trustText, trustLine, recordTrust } from "../src/trust";
import { loadRules } from "../src/rules";
import { nightBackfill, nightBackfillLine } from "../src/backfill";
import { memoryCheck, unseenChanges, state as syncState } from "../src/memsync";
import { main } from "../src/cli";

const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();
function note(root: string, path: string, fm: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), `---\n${fm.trim()}\n---\nbody\n`);
}
const head = (id: string, type = "person", area = "work") => `id: ${id}\ntype: ${type}\ntitle: ${id.split("/")[1].replace(/-/g, " ")}\narea: ${area}\nsensitivity: personal\nstatus: active\ncreated: 2026-05-01\nupdated: 2026-05-01\nby: helper\nfacts:`;
const confirmLine = (root: string, key: string, source: string, at: string) => {
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "writes.jsonl"), JSON.stringify({ at, agent: "hub", kind: "source-confirm", key, outcome: "committed", source }) + "\n");
};

// makeBrain pins today to 2026-10-08; person.role has a 180-day shelf life.
function seed() {
  const root = makeBrain();
  for (const d of ["people", "projects", "decisions", "money"]) rmSync(join(root, d), { recursive: true, force: true });
  note(root, "people/ann-told.md", `${head("people/ann-told")}
  role: { value: Editor in chief, as_of: 2026-09-01, sources: ["owner:2026-09-01/dashboard-edit"], verification: confirmed-by-owner, by: owner, recorded: 2026-09-01 }
  org: { value: Acme Press, as_of: 2026-09-01, sources: ["gmail:a000000000000001"], verification: verified-by-source, by: helper, recorded: 2026-09-01 }
  city: { value: Lyon France, as_of: 2026-09-01, sources: ["gmail:a000000000000002"], verification: verified-by-source, by: helper, recorded: 2026-09-01 }
  team: { value: Books desk, as_of: 2026-09-01, sources: ["gmail:a000000000000003"], verification: verified-by-source, by: helper, recorded: 2026-09-10 }`);
  note(root, "people/ben-weak.md", `${head("people/ben-weak")}
  role: { value: Chair of the board, as_of: 2026-09-01, sources: ["gmail:b000000000000001"], verification: verified-by-source, by: helper, recorded: 2026-09-01, review_after: 2026-10-01, recheck: { why: the source no longer says this, ref: "gmail:b000000000000001", at: 2026-10-01 } }
  org: { value: Old Club, as_of: 2025-01-01, sources: ["owner:2025-01-01/dashboard-edit"], verification: confirmed-by-owner, by: owner, recorded: 2025-01-01 }
  city: { value: Paris maybe, as_of: 2026-09-01, sources: ["agent:helper"], verification: self-reported, confidence: inferred, by: helper, recorded: 2026-09-01 }
  hobby: { value: Chess club, as_of: 2026-09-01, sources: ["notion:abc123"], verification: verified-by-source, by: helper, recorded: 2026-09-01 }
  diagnosis: { value: Recovering from surgery, as_of: 2026-09-01, sources: ["owner:2026-09-01/dashboard-edit"], verification: confirmed-by-owner, by: owner, recorded: 2026-09-01 }`);
  // The org's last owner word is 21 months old: past twice the 180-day shelf life of person.role? org has none, so make role stale instead.
  writeFileSync(join(root, "rules", "checks.yaml"), readFileSync(join(root, "rules", "checks.yaml"), "utf8").replace("org: { merge: replace, normalize: link }", "org: { merge: replace, normalize: link, shelf_life: 90d }"));
  git(root, "add", "-A"); git(root, "commit", "-qm", "seed");
  // The hub read Ann's org mail after the value was recorded: checked. Her city's mail was read
  // before the value was recorded (a later value, not what the mail said): not checked. Her team
  // has no read at all, only the verified-by-source label: not checked.
  confirmLine(root, "people/ann-told#org", "gmail:a000000000000001", "2026-09-05T10:00:00Z");
  confirmLine(root, "people/ann-told#team", "gmail:a000000000000003", "2026-09-05T10:00:00Z");
  return root;
}

test("each live fact lands in one bucket: checked only by the owner's word or the hub's own read", () => {
  const root = seed();
  const by = new Map(factTrust(root).map((f) => [f.key, f]));
  expect(by.get("people/ann-told#role")!.checked).toBe("owner");
  expect(by.get("people/ann-told#org")!.checked).toBe("hub");
  // A verified-by-source label is a claim: without a hub read since the value was recorded it isn't checked.
  expect(by.get("people/ann-told#city")!.checked).toBeUndefined();
  expect(by.get("people/ann-told#team")!.checked).toBeUndefined();
  expect(by.get("people/ben-weak#role")!.problems).toContain("source-says-otherwise");
  expect(by.get("people/ben-weak#org")!.problems).toContain("stale");
  expect(by.get("people/ben-weak#city")!.problems).toContain("guessed");
  expect(by.get("people/ben-weak#hobby")!.unsourced).toBe("vague");
  expect(by.get("people/ben-weak#city")!.unsourced).toBe("assistant");
  // Someone else's health at personal: the helper (trial, below private) reads it.
  expect(by.get("people/ben-weak#diagnosis")!.problems).toContain("private-shown");

  const t = trustReport(root);
  expect(t.facts).toBe(9);
  expect(t.look).toBe(4);
  expect(t.checked).toBe(2);
  expect(t.unchecked).toBe(3);
  expect(t.by).toEqual({ owner: 1, hub: 1 });
  expect(t.unsourced.total).toBe(3); // the flagged role, the inferred city, the Notion-only hobby
  expect(trustLine(t)).toBe("2 checked against their source, 4 need a look, 3 not checked yet.");
  // On home it ends the memory line, which already says "facts" (decide-wall bar).
});

test("what the audit prints carries counts only: no value, title or note id", () => {
  const root = seed();
  const out = trustText(trustReport(root)) + JSON.stringify(trustReport(root));
  for (const leak of ["Editor in chief", "Acme Press", "Lyon", "Chair of the board", "Paris", "Chess", "surgery", "ann-told", "ben-weak", "ann told", "a000000000000001"]) expect(out).not.toContain(leak);
});

test("pocketbrain audit trust prints the report and keeps one row a day for the week-on-week line", () => {
  const root = seed();
  process.env.PB_BRAIN = root;
  const lines: string[] = [];
  const log = console.log;
  console.log = (s: string) => lines.push(String(s));
  try { expect(main(["audit", "trust"])).toBe(0); expect(main(["audit", "trust"])).toBe(0); } finally { console.log = log; delete process.env.PB_BRAIN; }
  expect(lines[0]).toStartWith("Trust: 9 facts. 2 checked against their source, 4 need a look");
  const rows = readFileSync(join(root, "log", "trust.jsonl"), "utf8").trim().split("\n");
  expect(rows.length).toBe(1);
  // A row from a week before is the comparison.
  writeFileSync(join(root, "log", "trust.jsonl"), JSON.stringify({ date: "2026-09-30", facts: 9, checked: 0, look: 6, unchecked: 3, unsourced: 5 }) + "\n");
  expect(recordTrust(root, trustReport(root))?.date).toBe("2026-09-30");
});

test("the nightly backfill only reports until the owner's pocketbrain backfill on, then attaches", async () => {
  const root = seed();
  writeFileSync(join(root, "rules", "sources.yaml"), "consent: 2026-10-01\nsources:\n  mail:\n    kind: gmail\n    account: personal\n    where: [INBOX]\n");
  git(root, "add", "-A"); git(root, "commit", "-qm", "sources");
  const mail = { id: "m9", text: "Ben Weak plays at the Chess club on Tuesdays.", internalDate: String(Date.parse("2026-09-20T12:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "Subject", value: "Tuesdays" }] } };
  const search = async () => [mail];
  const head0 = git(root, "rev-parse", "HEAD");
  // Report-only: it searches and counts, and writes nothing.
  const dry = await nightBackfill(root, { search });
  expect(dry.on).toBe(false);
  expect(dry.results[0].attached).toContain("people/ben-weak#hobby");
  expect(nightBackfillLine(dry)).toStartWith("backfill (report only): mail");
  expect(git(root, "rev-parse", "HEAD")).toBe(head0);
  expect(factTrust(root).find((f) => f.key === "people/ben-weak#hobby")!.checked).toBeUndefined();
  // The owner's one command: an owner commit of policy.yaml, then the night attaches.
  process.env.PB_BRAIN = root;
  const log = console.log; console.log = () => {};
  try { expect(main(["backfill", "on"])).toBe(0); } finally { console.log = log; delete process.env.PB_BRAIN; }
  expect(git(root, "log", "-1", "--format=%s")).toContain("backfill on");
  const live = await nightBackfill(root, { search });
  expect(live.on).toBe(true);
  expect(nightBackfillLine(live)).toMatch(/^backfill: mail \d+ searched, 1 now sourced$/);
  expect(factTrust(root).find((f) => f.key === "people/ben-weak#hobby")!.checked).toBe("hub");
});

test("assistants behind: changes an agent hasn't confirmed seeing, counted without logging anything", () => {
  const root = seed();
  expect(unseenChanges(root, "helper")).toBeUndefined(); // never checked in: no baseline
  memoryCheck(root, "helper"); // the first check records the baseline
  expect(unseenChanges(root, "helper")).toBe(0);
  const file = join(root, "people", "ann-told.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("Editor in chief", "Publisher"));
  git(root, "add", "-A"); git(root, "commit", "-qm", "owner changed role");
  const before = existsSync(join(root, "log", "memsync.jsonl")) ? readFileSync(join(root, "log", "memsync.jsonl"), "utf8") : "";
  expect(unseenChanges(root, "helper", syncState(root))).toBe(1);
  expect(existsSync(join(root, "log", "memsync.jsonl")) ? readFileSync(join(root, "log", "memsync.jsonl"), "utf8") : "").toBe(before);
  expect(trustReport(root).behind).toContainEqual({ agent: "helper", changes: 1 });
});
