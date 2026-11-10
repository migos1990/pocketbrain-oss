// SPDX-License-Identifier: AGPL-3.0-only
// Owner's phone, 2026-11-03 (G662): two conflict cards asked "pick one" about values that both
// hold. One was the same sentence twice, a capital letter and "retain" against "be retained"
// apart, from mails ten days apart; the other was a project's status from two mails of the same
// day ("beta testing", then "build 5 is ready to test"). A conflict is two values
// that can't both hold: a reworded sentence is the same value (step 1), and a later mail of the
// same day is the fact changing that day (step 4), the earlier value kept as history.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { runAuto } from "../src/filing";
import { loadBrain, type FactRecord } from "../src/brain";
import { sameValue } from "../src/normalize";

const NOW = new Date("2026-10-28T15:00:00Z");
const sh = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const jane = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
// A pulled item's capture record: its ref and its sender's key (never the address).
function sent(root: string, ref: string, from: string) {
  const { senderKey } = require("../src/capture");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", `2026-10-06-${ref.slice(-8)}.md`), `---\n${YAML.stringify({ id: `2026-10-06-${ref.slice(-8)}`, kind: "text", via: "source", source_ref: ref, sender_key: senderKey(from), status: "done" })}---\nNot kept here.\n`);
}
const disputes = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute");

// A mail the hub pulled, waiting for the filing tick as a capture's proposal.
function pulled(root: string, attribute: string, value: string, as_of: string, id = "people/jane-roy", ref = "gmail:f000000000000012"): string {
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", "m.md"), `${value}\n`);
  writeFileSync(join(root, "inbox", `${as_of}-capture-m1.yaml`), YAML.stringify({ proposed: as_of, by: "steward", reason: "capture inbox/captures/m.md: a new value", checks: ["capture"], capture: "inbox/captures/m.md", request: { agent: "steward", kind: "fact", id, attribute, value, as_of, sources: [ref], verification: "self-reported" } }));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "capture: stored");
  return root;
}

test("a reworded sentence is the same value; a different one is not", () => {
  const a = "Use each sign-in client to retain in a partner sign-in flow or to exchange a refresh token for an access token";
  expect(sameValue(a, "use each sign-in client to be retained in a partner sign-in flow or to exchange a refresh token for an access token")).toBe(true);
  expect(sameValue("Ship the beta to testers on Friday", "Ship the beta to testers on Monday")).toBe(false);
  expect(sameValue("The launch is not on track this week", "The launch is on track this week")).toBe(false);
  expect(sameValue("Review build 4 with the testers", "Review build 5 with the testers")).toBe(false);
  // Tense and the role of each name still count (slice audit of G662).
  expect(sameValue("Invoice was paid in full by the supplier", "Invoice will be paid in full by the supplier")).toBe(false);
  expect(sameValue("Deploy was approved by the board today", "Deploy is approved by the board today")).toBe(false);
  expect(sameValue("Send the report to Anna by Friday", "Send the report by Anna to Friday")).toBe(false);
  // Short values keep the exact comparison: a word apart is a different value.
  expect(sameValue("in review", "in reviews")).toBe(false);
});

// The owner's brain runs next steps as a run of values (merge: latest, set by the owner's setter);
// the live one was checked against its mail (verified-by-source), so a reworded newer mail
// outranked nothing and opened a conflict.
function course(root: string, merge: string) {
  const f = join(root, "rules", "checks.yaml");
  writeFileSync(f, require("node:fs").readFileSync(f, "utf8").replace("next_step: { merge: replace,", `next_step: { merge: ${merge},`));
  const p = join(root, "projects", "course-a.md");
  writeFileSync(p, require("node:fs").readFileSync(p, "utf8").replace("value: Grade the midterm,", "value: Grade the midterm and post the marks to the class site,"));
  sh(root, "add", "-A"); sh(root, "commit", "-qm", "setup");
}
const courseA = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!;

for (const merge of ["latest", "replace"]) test(`a later mail saying the same next step in other words merges, no conflict (${merge})`, () => {
  const root = makeBrain();
  course(root, merge);
  pulled(root, "next_step", "grade midterm, and post the marks to class site.", "2026-10-05", "projects/course-a");
  runAuto(root, NOW);
  expect(disputes(root)).toHaveLength(0);
  const f = courseA(root).fm.facts!.next_step as FactRecord;
  expect(f.contested).toBeUndefined();
  expect(f.value).toBe("Grade the midterm and post the marks to the class site");
  expect(f.sources.map(String)).toContain("gmail:f000000000000012");
});

for (const [label, second, both] of [["one sender", "Build Desk <builds@store.example>", true], ["two senders", "Someone Else <someone@else.example>", false]] as const) test(`two mails of the same day on a status, ${label}: ${both ? "the later one updates, the earlier is history" : "a conflict"}`, () => {
  const root = makeBrain();
  sent(root, "gmail:f000000000000020", "Build Desk <builds@store.example>");
  sent(root, "gmail:f000000000000012", second);
  write(root, { agent: "steward", id: "people/jane-roy", attribute: "status", value: "beta testing with a small group", as_of: "2026-10-06", sources: ["gmail:f000000000000020"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", pulled: true } as never);
  pulled(root, "status", "build 5 is ready to test on the phone", "2026-10-06");
  runAuto(root, NOW);
  if (!both) { expect(disputes(root)).toHaveLength(1); return; }
  expect(disputes(root)).toHaveLength(0);
  expect((jane(root).fm.facts!.status as FactRecord).value).toBe("build 5 is ready to test on the phone");
  expect((jane(root).fm.history!.status as FactRecord[]).some((h) => h.value === "beta testing with a small group")).toBe(true);
});

test("a same-day value from an assistant (not a mail the hub pulled) still asks", () => {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "beta testing with a small group", as_of: "2026-10-06", sources: ["gmail:f000000000000020"], verification: "self-reported" } as never);
  const r = write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "launched to everyone", as_of: "2026-10-06", sources: ["gmail:f000000000000021"], verification: "self-reported" } as never);
  expect(r.outcome).toBe("disputed");
});

test("a newer mail's different next step, on a run of next steps, is the next one, not a conflict", () => {
  const root = makeBrain();
  course(root, "latest");
  pulled(root, "next_step", "Book the room for the final exam", "2026-10-05", "projects/course-a");
  runAuto(root, NOW);
  expect(disputes(root)).toHaveLength(0);
  expect((courseA(root).fm.facts!.next_step as FactRecord).value).toBe("Book the room for the final exam");
  expect((courseA(root).fm.history!.next_step as FactRecord[]).some((h) => String(h.value).startsWith("Grade the midterm"))).toBe(true);
});

test("a same-day change shaped like money still asks", () => {
  const root = makeBrain();
  write(root, { agent: "steward", id: "people/jane-roy", attribute: "status", value: "salary review pending", as_of: "2026-10-06", sources: ["gmail:f000000000000020"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", pulled: true } as never);
  const r = write(root, { agent: "steward", id: "people/jane-roy", attribute: "status", value: "salary raised to 90000", as_of: "2026-10-06", sources: ["gmail:f000000000000012"], verification: "self-reported" } as never, { acceptedBy: "auto-decide", pulled: true } as never);
  expect(r.outcome).toBe("disputed");
});

test("the night's report counts open conflicts whose sides both hold, and changes nothing", () => {
  const { upkeep, bothHold } = require("../src/upkeep");
  const { loadRules } = require("../src/rules");
  const rec = (value: string, as_of: string, ref: string) => ({ value, as_of, sources: [ref], verification: "self-reported", by: "planner", recorded: as_of });
  const rules = loadRules(makeBrain());
  const root0 = makeBrain();
  sent(root0, "gmail:f1", "a@x.example"); sent(root0, "gmail:f2", "a@x.example");
  expect(bothHold([rec("Use each client to retain in a partner flow or to exchange a token", "2026-10-01", "gmail:f1"), rec("use each client to be retained in a partner flow or to exchange a token", "2026-10-06", "gmail:f2")], rules, root0)).toContain("same thing");
  expect(bothHold([rec("beta testing", "2026-10-06", "gmail:f1"), rec("build 5 ready to test", "2026-10-06", "gmail:f2")], rules, root0)).toContain("same day");
  expect(bothHold([rec("beta testing", "2026-10-05", "gmail:f1"), rec("cancelled", "2026-10-06", "agent:planner")], rules, root0)).toBeUndefined();
  // A fact whose name is money-, health- or legal-shaped never counts, whatever its values say (review of G662).
  expect(bothHold([rec("under review", "2026-10-06", "gmail:f1"), rec("approved", "2026-10-06", "gmail:f2")], rules, root0, "salary")).toBeUndefined();
  expect(bothHold([rec("under review", "2026-10-06", "gmail:f1"), rec("approved", "2026-10-06", "gmail:f2")], rules, root0, "status")).toContain("same day");
  const root = makeBrain();
  sent(root, "gmail:f000000000000020", "a@x.example"); sent(root, "gmail:f000000000000021", "a@x.example");
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "beta testing with a small group", as_of: "2026-10-06", sources: ["gmail:f000000000000020"], verification: "self-reported" } as never);
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "status", value: "launched to everyone", as_of: "2026-10-06", sources: ["gmail:f000000000000021"], verification: "self-reported" } as never);
  const before = disputes(root).map((d) => d.fm.status);
  const r = upkeep(root, { now: "2026-10-08" });
  expect(r.findings.filter((f: { rule: string }) => f.rule === "both-hold-conflict").map((f: { key: string }) => f.key)).toEqual(["people/jane-roy#status"]);
  expect(disputes(root).map((d) => d.fm.status)).toEqual(before);
});

test("a sender's key is its address, whatever its display name or case", () => {
  const { senderKey } = require("../src/capture");
  expect(senderKey("Desk <Builds@Store.example>")).toBe(senderKey("Build Desk <builds@store.example>"));
  expect(senderKey("builds@store.example")).toBe(senderKey("<builds@store.example>"));
  expect(senderKey("Desk <builds@store.example>")).not.toBe(senderKey("Desk <other@store.example>"));
  expect(senderKey("no address here")).toBeUndefined();
});
