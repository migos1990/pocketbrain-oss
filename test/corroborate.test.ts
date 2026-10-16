// SPDX-License-Identifier: AGPL-3.0-only
// Corroboration (docs/gardener.md, docs/sources-pull.md): when the hub reads a cited source item,
// for verify_source or for upkeep's recheck of due and stale facts, every fact citing that item is
// checked against the item's own words. Still said: re-confirmed (last_confirmed today). No longer
// said: due, with the reason. The value never changes. Fixtures only; no model.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { recheckFacts, recheckDue } from "../src/pull";
import { readJsonl } from "../src/util";

const IN = "2026-10-08T07:30:00Z"; // 03:30 in Toronto, inside the gardener's window
afterEach(() => { delete process.env.PB_NOW; process.env.PB_TODAY = "2026-10-08"; });
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } }).stdout.toString().trim();
const MAIL = (id: string, text: string) => ({ id, labelIds: ["Label_school"], internalDate: "1760300000000", payload: { headers: [{ name: "Subject", value: "Course A" }] }, text });
const REF = "gmail:a1b2c3d4e5f60718";
const KEY = "projects/course-a#next_step";
const nextStep = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;

// Course A's next step ("Grade the midterm", as of 2026-10-01, shelf life 14 days) cites REF.
function setup(text: string) {
  const root = makeBrain();
  writeFileSync(join(root, "mail.json"), JSON.stringify([MAIL("a1b2c3d4e5f60718", text)]));
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { gmail: { kind: "gmail", where: ["Label_school"], fixture: "mail.json" } } }));
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  (n.fm.facts!.next_step as FactRecord).sources = [REF];
  saveNote(root, n);
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "louis: cite");
  return root;
}
async function mcp(root: string, token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await handle(root, new Request("http://pb/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }), headers: { authorization: `Bearer ${token}` } }));
  return JSON.parse(((await res.json()) as any).result.content[0].text);
}

test("verify_source match re-confirms every fact citing the item, by the fact's own value, and commits as the hub", async () => {
  const root = setup("Reminder for everyone: grade the midterm before Friday.");
  process.env.PB_TODAY = "2026-10-20";
  process.env.PB_NOW = "2026-10-20T07:30:00Z";
  const r = await mcp(root, issueToken(root, "gardener"), "verify_source", { ref: REF, claim: "grade the midterm" });
  expect(r.result).toBe("match");
  expect(r.confirmed).toEqual([KEY]);
  const f = nextStep(root);
  expect(f.last_confirmed).toBe("2026-10-20");
  expect(f.value).toBe("Grade the midterm");
  expect(sh(root, "git", "log", "-1", "--format=%an %s")).toContain("rechecked");
  expect(readJsonl<any>(join(root, "log", "writes.jsonl")).some((w) => w.kind === "source-confirm" && w.key === KEY)).toBe(true);
});

test("a claim that matches doesn't confirm a fact the item doesn't say: the hub checks each fact's own value", async () => {
  const root = setup("The intra exam moves to October 23 in room B-201.");
  process.env.PB_NOW = IN;
  const r = await mcp(root, issueToken(root, "gardener"), "verify_source", { ref: REF, claim: "intra exam October 23" });
  expect(r.result).toBe("match");
  expect(r.confirmed ?? []).toEqual([]);
  expect(r.due).toEqual([KEY]);
  const f = nextStep(root);
  expect(f.value).toBe("Grade the midterm");
  expect(f.review_after).toBe("2026-10-08");
  expect(f.recheck).toMatchObject({ ref: REF });
  expect(f.recheck!.why).toContain("no longer says");
});

test("a later match clears the recheck that a no-match raised", () => {
  const root = setup("x");
  recheckFacts(root, REF, "Nothing about that here at all.");
  expect(nextStep(root).review_after).toBe("2026-10-08");
  recheckFacts(root, REF, "Please grade the midterm.");
  const f = nextStep(root);
  expect(f.review_after).toBeUndefined();
  expect(f.recheck).toBeUndefined();
});

test("a value too short to check by words is left alone", () => {
  const root = setup("x");
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  (n.fm.facts!.next_step as FactRecord).value = "ok";
  saveNote(root, n);
  expect(recheckFacts(root, REF, "Nothing related.")).toEqual({ confirmed: [], due: [], files: [] });
  expect(nextStep(root).review_after).toBeUndefined();
});

test("upkeep rechecks due and stale facts at their source on its own, capped, skipping ones already flagged", async () => {
  const root = setup("Reminder for everyone: grade the midterm before Friday.");
  process.env.PB_TODAY = "2026-10-20"; // 19 days after as_of: due
  const r = await recheckDue(root, { max: 5 });
  expect(r).toMatchObject({ checked: 1, confirmed: [KEY], due: [] });
  expect(nextStep(root).last_confirmed).toBe("2026-10-20");
  expect(readJsonl<any>(join(root, "log", "sources", "verify.jsonl")).at(-1)).toMatchObject({ agent: "hub", ref: REF, result: "match" });
  // Now current: nothing to recheck.
  expect((await recheckDue(root, { max: 5 })).checked).toBe(0);
  // Capped at max refs per pass.
  expect((await recheckDue(root, { max: 0 })).checked).toBe(0);
});

test("the gardener's upkeep_run reports what was rechecked at source", async () => {
  const root = setup("The room changed; see the new schedule.");
  process.env.PB_TODAY = "2026-10-20";
  process.env.PB_NOW = "2026-10-20T07:30:00Z";
  const r = await mcp(root, issueToken(root, "gardener"), "upkeep_run");
  expect(r.rechecked).toEqual({ confirmed: [], due: [KEY] }); // in-view keys only, no hub-wide counts
  expect(nextStep(root).recheck!.ref).toBe(REF);
  // Flagged once; the next pass doesn't spend a check on it again.
  const again = await mcp(root, issueToken(root, "gardener"), "upkeep_run");
  expect(again.rechecked).toEqual({ confirmed: [], due: [] });
  expect(readFileSync(join(root, "log", "gardener.jsonl"), "utf8")).toContain("upkeep_run");
});

// Slice audit 2026-10-15: a fact hidden from the gardener on a note it can see (above its level,
// shared with another agent only, or excluded by name) is neither reported nor touched.
const MIXED = "Reminder: grade the midterm before Friday. The plan is Operation Bluebird.";
function withHidden(how: "sensitivity" | "share_with" | "exclude") {
  const root = setup(MIXED);
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  const rec: Record<string, unknown> = { value: "Operation Bluebird", as_of: "2026-10-01", sources: [REF], verification: "unverified", by: "planner", recorded: "2026-10-01" };
  if (how === "sensitivity") rec.sensitivity = "secret";
  if (how === "share_with") rec.share_with = ["steward"];
  (n.fm.facts as Record<string, unknown>).hidden = rec;
  saveNote(root, n);
  if (how === "exclude") {
    const p = join(root, "rules", "policy.yaml");
    writeFileSync(p, readFileSync(p, "utf8").replace("slices: [all], max_proposals_per_day: 13", 'slices: [all], exclude: ["projects/course-a#hidden"], max_proposals_per_day: 13'));
  }
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "louis: hidden fact");
  return root;
}
const hiddenFact = (root: string) => (loadBrain(root).find((x) => x.fm.id === "projects/course-a")!.fm.facts as Record<string, FactRecord>).hidden;

for (const how of ["sensitivity", "share_with", "exclude"] as const) {
  test(`verify_source and upkeep_run neither report nor touch a fact hidden from the gardener (${how})`, async () => {
    const root = withHidden(how);
    process.env.PB_TODAY = "2026-10-20";
    process.env.PB_NOW = "2026-10-20T07:30:00Z";
    const g = issueToken(root, "gardener");
    const v = await mcp(root, g, "verify_source", { ref: REF, claim: "grade the midterm" });
    expect(v.confirmed).toEqual([KEY]);
    expect(JSON.stringify(v)).not.toContain("#hidden");
    const u = await mcp(root, g, "upkeep_run");
    expect(JSON.stringify(u.rechecked)).not.toContain("#hidden");
    const h = hiddenFact(root);
    expect(h.last_confirmed).toBeUndefined();
    expect(h.verification).toBe("unverified");
  });
}

test("verify_source refuses a ref that only a hidden fact cites", async () => {
  const root = withHidden("share_with");
  const n = loadBrain(root).find((x) => x.fm.id === "projects/course-a")!;
  (n.fm.facts!.next_step as FactRecord).sources = ["gmail:f000000000000003"];
  saveNote(root, n);
  sh(root, "git", "commit", "-qam", "louis: uncite");
  process.env.PB_NOW = IN;
  const r = await mcp(root, issueToken(root, "gardener"), "verify_source", { ref: REF, claim: "Operation Bluebird" });
  expect(r).toMatchObject({ result: "unreachable", why: "no fact in your view cites this ref" });
});

test("a deleted item turns the facts citing it due, and a retired note citing it is left alone", () => {
  const root = setup("x");
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  const [attr] = Object.keys(n.fm.facts ?? {});
  (n.fm.facts![attr] as FactRecord).sources = [REF];
  n.fm.status = "retired";
  saveNote(root, n);
  sh(root, "git", "commit", "-qam", "louis: retired note cites it");
  const r = recheckFacts(root, REF, null);
  expect(r.due).toEqual([KEY]);
  expect(nextStep(root).recheck!.why).toContain("deleted");
  const after = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  expect((after.fm.facts![attr] as FactRecord).review_after).toBeUndefined();
});

test("on a replica a recheck writes nothing; the hub rechecks on its own pass", () => {
  const root = setup("Please grade the midterm.");
  writeFileSync(join(root, "rules", "hub.yaml"), "hub: mac\nreplicas:\n  laptop: {}\n");
  sh(root, "git", "add", "-A");
  sh(root, "git", "commit", "-qm", "louis: hub");
  process.env.PB_REPLICA = "laptop";
  process.env.PB_TODAY = "2026-10-20";
  try {
    expect(recheckFacts(root, REF, "Please grade the midterm.")).toEqual({ confirmed: [], due: [], files: [] });
    expect(nextStep(root).last_confirmed).toBeUndefined();
  } finally { delete process.env.PB_REPLICA; }
});

// Weekly-hunt eval (agents-gardener-weekly): the old role still appears in the mail, but about
// someone else. A person's fact is confirmed only by a sentence that names that person.
const role = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord;
function citeRole(root: string) {
  const n = loadBrain(root).find((x) => x.fm.id === "people/jane-roy")!;
  (n.fm.facts!.role as FactRecord).sources = [REF];
  saveNote(root, n);
}
test("a person's old value said about someone else in the item doesn't confirm it", () => {
  const root = setup("x");
  citeRole(root);
  const r = recheckFacts(root, REF, "Jane Roy, new role\nHi Robin, a quick update: since October 1 I'm Associate Dean at Northfield. Sam takes over as course coordinator. Jane");
  expect(r.confirmed).not.toContain("people/jane-roy#role");
  expect(r.elsewhere).toEqual(["people/jane-roy#role"]);
  expect(role(root).last_confirmed).toBeUndefined();
});
test("a sentence naming the person with their value still confirms it", () => {
  const root = setup("x");
  citeRole(root);
  const r = recheckFacts(root, REF, "Staff list\nJane Roy stays course coordinator for the winter term.");
  expect(r.confirmed).toContain("people/jane-roy#role");
});
