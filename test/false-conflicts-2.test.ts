// SPDX-License-Identifier: AGPL-3.0-only
// Owner's phone, 2026-11-06 (G674-G677): three more cards asked "pick one" about values that both
// hold. An org's name in another case ("Lakeview college" against "LAKEVIEW College"), linked to its page
// on one side and written as a name on the other; two next steps from one mail of one day (sign
// the agreement, the interview on Thursday); and a person's relationship the owner answered "Not
// sure, keep both" on about ten times, each answer followed by the same card again, the owner's
// own word on one side and an assistant's guess on the other.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, readdirSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write, decideProposal } from "../src/write";
import { runAuto } from "../src/filing";
import { ownerKeepBoth, ownerConflicts } from "../src/core";
import { inboxConflicts } from "../src/settle-inbox";
import { loadBrain, type FactRecord } from "../src/brain";

const NOW = new Date("2026-10-28T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const note = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!;
const jane = (root: string) => note(root, "people/jane-roy");
const open = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute" && ["open", "escalated"].includes(String(n.fm.status)));
const owner = (root: string, attribute: string, value: string, as_of: string, id = "people/jane-roy") =>
  write(root, { agent: "owner", id, attribute, value, as_of, sources: [`owner:${as_of}/say`], verification: "confirmed-by-owner" } as never, { owner: true } as never);

function sent(root: string, ref: string, from: string) {
  const { senderKey } = require("../src/capture");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", `2026-10-06-${ref.slice(-8)}.md`), `---\n${YAML.stringify({ id: `2026-10-06-${ref.slice(-8)}`, kind: "text", via: "source", source_ref: ref, sender_key: senderKey(from), status: "done" })}---\nNot kept here.\n`);
}
// A mail the hub pulled, waiting for the filing tick as a capture's proposal.
function pulled(root: string, attribute: string, value: string, as_of: string, id = "people/jane-roy", ref = "gmail:f000000000000012", n = "1"): void {
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", `m${n}.md`), `${value}\n`);
  writeFileSync(join(root, "inbox", `${as_of}-capture-m${n}.yaml`), YAML.stringify({ proposed: as_of, by: "steward", reason: `capture inbox/captures/m${n}.md: a new value`, checks: ["capture"], capture: `inbox/captures/m${n}.md`, request: { agent: "steward", kind: "fact", id, attribute, value, as_of, sources: [ref], verification: "self-reported" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "capture: stored");
}
// An org page an assistant made, its name in lower case, and Jane's org linking to it.
function org(root: string) {
  mkdirSync(join(root, "orgs"), { recursive: true });
  writeFileSync(join(root, "orgs", "lakeshore-college.md"), `---\nid: orgs/lakeshore-college\ntype: org\ntitle: Lakeshore college\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-09-28\nupdated: 2026-09-28\nby: planner\n---\nA college.\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "org page");
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "org", value: "[[orgs/lakeshore-college]]", as_of: "2026-09-28", sources: ["agent:planner"], verification: "self-reported" } as never).outcome).toBe("committed");
}

test("G674: an org named in another case is the page it links to, never a conflict", () => {
  const root = makeBrain();
  org(root);
  pulled(root, "org", "LAKESHORE College", "2026-10-05");
  runAuto(root, NOW);
  expect(open(root)).toHaveLength(0);
  expect(inboxConflicts(root)).toHaveLength(0);
  const f = jane(root).fm.facts!.org as FactRecord;
  expect(f.value).toBe("[[orgs/lakeshore-college]]");
  expect(f.sources.map(String)).toContain("gmail:f000000000000012");
  // An assistant writing the name, accents and spacing apart, merges too.
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "org", value: "Lakeshore  Collège", as_of: "2026-10-06", sources: ["gmail:f000000000000013"], verification: "self-reported" } as never);
  expect(r.outcome).toBe("committed");
  expect(open(root)).toHaveLength(0);
  // Another org is still another value.
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "org", value: "Harbour Institute", as_of: "2026-10-06", sources: ["gmail:f000000000000014"], verification: "self-reported" } as never).message).not.toContain("same value");
});

test("G674: a proposal naming the linked page in another case is no card on the settle screen", () => {
  const root = makeBrain();
  org(root);
  // Waits in the inbox (a trial assistant only proposes).
  expect(write(root, { agent: "helper", id: "people/jane-roy", attribute: "org", value: "lakeshore COLLEGE", as_of: "2026-10-06", sources: ["agent:helper"], verification: "self-reported" } as never).outcome).toBe("inbox");
  expect(inboxConflicts(root)).toHaveLength(0);
});

test("G675: two next steps from one mail of one day both stay, no conflict", () => {
  const root = makeBrain();
  const ref = "gmail:f000000000000031";
  sent(root, ref, "Programme Office <office@school.example>");
  writeFileSync(join(root, "projects", "seminar.md"), `---\nid: projects/seminar\ntype: project\ntitle: Seminar\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\nA seminar.\n`);
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "seminar");
  pulled(root, "next_step", "sign the confidentiality agreement as soon as possible", "2026-10-06", "projects/seminar", ref, "1");
  runAuto(root, NOW);
  pulled(root, "next_step", "interview planned for Thursday 8 October", "2026-10-06", "projects/seminar", ref, "2");
  runAuto(root, NOW);
  expect(open(root)).toHaveLength(0);
  const v = String((note(root, "projects/seminar").fm.facts!.next_step as FactRecord).value);
  expect(v).toContain("sign the confidentiality agreement");
  expect(v).toContain("interview planned for Thursday 8 October");
  // The same mail read again adds nothing.
  pulled(root, "next_step", "interview planned for Thursday 8 October", "2026-10-06", "projects/seminar", ref, "3");
  runAuto(root, NOW);
  expect(String((note(root, "projects/seminar").fm.facts!.next_step as FactRecord).value)).toBe(v);
  expect(open(root)).toHaveLength(0);
});

test("G676: after Not sure, keep both, the same two values never ask again; a third one does", () => {
  const root = makeBrain();
  sent(root, "gmail:f000000000000041", "a@one.example"); sent(root, "gmail:f000000000000042", "b@two.example");
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "on leave", as_of: "2026-10-06", sources: ["gmail:f000000000000041"], verification: "self-reported" } as never);
  // The other side from a mail the hub pulled: a conflict beside the live value (held, then asked).
  pulled(root, "status", "teaching this term", "2026-10-06", "people/jane-roy", "gmail:f000000000000042", "1");
  runAuto(root, NOW);
  const [c] = open(root);
  expect(c).toBeDefined();
  ownerKeepBoth(root, String(c.fm.id).split("/")[1]);
  expect(ownerConflicts(root, NOW, { held: true })).toHaveLength(0);
  // Each side said again, from its source or another: no card.
  sent(root, "gmail:f000000000000044", "b@two.example");
  pulled(root, "status", "Teaching this term", "2026-10-06", "people/jane-roy", "gmail:f000000000000044", "2");
  runAuto(root, NOW);
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "teaching this term", as_of: "2026-10-06", sources: ["gmail:f000000000000042"], verification: "self-reported" } as never);
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "On leave", as_of: "2026-10-07", sources: ["agent:planner"], verification: "self-reported" } as never);
  expect(ownerConflicts(root, NOW, { held: true })).toHaveLength(0);
  expect(open(root)).toHaveLength(0);
  // A value nobody kept is new: it asks.
  sent(root, "gmail:f000000000000045", "c@three.example");
  pulled(root, "status", "retired", "2026-10-06", "people/jane-roy", "gmail:f000000000000045", "3");
  runAuto(root, NOW);
  expect(ownerConflicts(root, NOW, { held: true })).toHaveLength(1);
});

test("G676: a proposal the owner turned down isn't proposed again by the same assistant", () => {
  const root = makeBrain();
  owner(root, "relationship", "old friend", "2026-10-02");
  const ask = () => write(root, { agent: "helper", id: "people/jane-roy", attribute: "relationship", value: "met once at a conference", as_of: "2026-10-06", sources: ["gmail:f000000000000051"], verification: "self-reported" } as never);
  const first = ask();
  expect(first.outcome).toBe("inbox");
  const [card] = inboxConflicts(root);
  expect(card).toBeDefined();
  decideProposal(root, first.file!, "reject");
  const files = () => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"));
  const before = files().length;
  const again = ask();
  expect(again.outcome).toBe("noop");
  expect(files().length).toBe(before);
  expect(inboxConflicts(root)).toHaveLength(0);
  // New evidence for the same value still goes through (slice audit).
  expect(write(root, { agent: "helper", id: "people/jane-roy", attribute: "relationship", value: "met once at a conference", as_of: "2026-10-07", sources: ["gmail:f000000000000052"], verification: "self-reported" } as never).outcome).toBe("inbox");
});

test("G677: money, health and legal still ask against the owner's word, from an assistant's word too", () => {
  const root = makeBrain();
  owner(root, "status", "salary review done", "2026-10-02");
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "salary raised to 90000", as_of: "2026-10-06", sources: ["agent:planner"], verification: "self-reported" } as never).outcome).not.toBe("committed");
  expect((jane(root).fm.facts!.status as FactRecord).value).toBe("salary review done");
  expect(jane(root).fm.history?.status ?? []).toHaveLength(0);
  // Waiting in the inbox, it is still a card (review of G677).
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-06-planner-s1.yaml"), YAML.stringify({ proposed: "2026-10-06", by: "planner", reason: "own_area", checks: [], request: { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "status", value: "salary cut to 70000", as_of: "2026-10-06", sources: ["agent:planner"], verification: "self-reported" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "proposal");
  expect(inboxConflicts(root).some((c) => c.fact_key === "people/jane-roy#status")).toBe(true);
});

test("G677: an assistant's word against the owner's never asks, whatever its date; a newer mail still does", () => {
  const root = makeBrain();
  owner(root, "relationship", "both a friend and a colleague", "2026-10-02");
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "relationship", value: "a contact since 2016, not close", as_of: "2026-10-06", sources: ["agent:planner"], verification: "self-reported" } as never);
  expect(r.outcome).toBe("committed");
  expect(open(root)).toHaveLength(0);
  expect((jane(root).fm.facts!.relationship as FactRecord).value).toBe("both a friend and a colleague");
  expect((jane(root).fm.history!.relationship as FactRecord[]).some((h) => h.value === "a contact since 2016, not close")).toBe(true);
  // A mail of a later day may say the fact changed: that still asks.
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "relationship", value: "now her manager", as_of: "2026-10-07", sources: ["gmail:f000000000000061"], verification: "self-reported" } as never).outcome).toBe("disputed");
});

test("G677: an assistant's proposal against the owner's word files itself as history, never a card", () => {
  const root = makeBrain();
  owner(root, "relationship", "both a friend and a colleague", "2026-10-02");
  // A core assistant's proposal waiting in the inbox (as one filed outside its area or level would).
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-06-planner-r1.yaml"), YAML.stringify({ proposed: "2026-10-06", by: "planner", reason: "own_area", checks: [], request: { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "relationship", value: "a contact since 2016, not close", as_of: "2026-10-06", sources: ["agent:planner"], verification: "self-reported" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "proposal");
  expect(inboxConflicts(root)).toHaveLength(0);
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "filing on");
  runAuto(root, NOW);
  expect(readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"))).toHaveLength(0);
  expect((jane(root).fm.facts!.relationship as FactRecord).value).toBe("both a friend and a colleague");
  expect(open(root)).toHaveLength(0);
});

test("G676: the night's report names a conflict asked again after the owner kept both", () => {
  const { upkeep } = require("../src/upkeep");
  const root = makeBrain();
  sent(root, "gmail:f000000000000041", "a@one.example"); sent(root, "gmail:f000000000000042", "b@two.example");
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "on leave", as_of: "2026-10-06", sources: ["gmail:f000000000000041"], verification: "self-reported" } as never);
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "teaching this term", as_of: "2026-10-06", sources: ["gmail:f000000000000042"], verification: "self-reported" } as never);
  const [c] = open(root);
  const id = String(c.fm.id).split("/")[1];
  ownerKeepBoth(root, id);
  // The same pair open again under a new number, as it came back on the owner's phone.
  const dir = join(root, "disputes"), again = join(dir, "c-9999.md");
  copyFileSync(join(dir, `${id}.md`), again);
  writeFileSync(again, readFileSync(again, "utf8").replace(`disputes/${id}`, "disputes/c-9999").replace("status: kept-both", "status: open"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "asked again");
  const r = upkeep(root, { now: "2026-10-08" });
  expect(r.findings.filter((f: { rule: string }) => f.rule === "asked-again-after-keep-both").map((f: { key: string }) => f.key)).toEqual(["people/jane-roy#status"]);
  expect(existsSync(again)).toBe(true);
});

test("G678: a long sentence said again with its parts in another order is the same value; a changed name or number is not", () => {
  const { nearSame } = require("../src/normalize");
  const a = "Use each sign-in client to retain in a partner sign-in flow or to exchange a refresh token for an access token";
  const b = "use the sign-in clients in a partner sign-in flow or to exchange a refresh token for an access token, for each client you want to retain";
  expect(nearSame(a, b)).toBe(true);
  expect(nearSame(b, a)).toBe(true);
  expect(nearSame("Send the signed contract to Anna at the main office by Friday morning please", "Send the signed contract to Paul at the main office by Friday morning please")).toBe(false);
  expect(nearSame("Send the signed contract to Anna at the office from Paul by Friday morning", "Send the signed contract to Paul at the office from Anna by Friday morning please")).toBe(false);
  expect(nearSame("Return the twelve graded reports to the class on the shared drive by 14 October", "Return the twelve graded reports to the class on the shared drive by 21 October you")).toBe(false);
  expect(nearSame("The launch is on track for the beta testers in the second week of October", "The launch is not on track for the beta testers in the second week of October you")).toBe(false);
  // A word that changes who or what it covers is never filler (slice audit of G678).
  expect(nearSame("Robin shares the draft with the board members before the end of the month for their review and comment", "Robin shares the draft with all board members before the end of the month for their review and comment")).toBe(false);
  expect(nearSame("Refunds are issued to the customer within five business days of the approved request", "Refunds are issued to the customer within five business days of any approved request")).toBe(false);
  expect(nearSame("Pay the bonus to the staff who work the weekend shift during the winter term", "Pay the bonus to the staff who want work the weekend shift during the winter term")).toBe(false);
  // Short values are never folded this way.
  expect(nearSame("send Zoe the slides", "send the slides to Zoe please")).toBe(false);
});

test("G678: a later mail with the same notice in another order files with no card", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "For each section the final exam room booking stays with the registrar office for the winter term", as_of: "2026-10-02", sources: ["gmail:f000000000000071"], verification: "verified-by-source" } as never);
  pulled(root, "next_step", "the final exam room booking stays with the registrar office for the winter term, for each section we want", "2026-10-06", "projects/course-a", "gmail:f000000000000072");
  const done = runAuto(root, NOW);
  expect(done.map((d) => d.picked)).not.toContain("left it for you");
  expect(open(root)).toHaveLength(0);
  expect(inboxConflicts(root)).toHaveLength(0);
  const f = note(root, "projects/course-a").fm.facts!.next_step as FactRecord;
  expect(String(f.value)).toStartWith("For each section");
  expect(f.sources.map(String)).toContain("gmail:f000000000000072");
});

test("G678: the owner's own near-same correction is a change, never folded into the old words", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "For each section the final exam room booking stays with the registrar office for the winter term", as_of: "2026-10-02", sources: ["gmail:f000000000000071"], verification: "verified-by-source" } as never);
  owner(root, "next_step", "the final exam room booking stays with the registrar office for the winter term, for each section we want", "2026-10-06", "projects/course-a");
  expect(String((note(root, "projects/course-a").fm.facts!.next_step as FactRecord).value)).toStartWith("the final exam room booking");
});

