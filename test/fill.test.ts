// SPDX-License-Identifier: AGPL-3.0-only
// Is the brain filling? (src/fill.ts, docs/sources-pull.md "Is the brain filling?"): per source,
// how many facts the capture pipeline proposed, how many the owner kept or dropped, how many it
// re-confirmed without asking, and the owner's minutes, against the self-filling targets.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { fill, renderFill, fillQuality } from "../src/fill";
import { week } from "../src/measure";
import { confirmFact, saveNoteBody, setFact } from "../src/dashboard/edit";

// makeBrain pins today to 2026-10-08.
function proposal(root: string, name: string, ref: string, proposed: string, decision?: "accept" | "reject", decided = proposed) {
  const body = { proposed, by: "capture", reason: `capture inbox/captures/x.md: adds role; quote: "..."`, checks: ["capture"], capture: "inbox/captures/x.md", request: { agent: "capture", kind: "fact", id: "people/jane-roy", attribute: "role", value: "x", sources: [ref] } };
  const dir = decision ? join(root, "inbox", "decided") : join(root, "inbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${proposed}-capture-${name}.yaml`), YAML.stringify(decision ? { ...body, decided, decision, by: "owner" } : body));
}
const log = (root: string, file: string, e: Record<string, unknown>) => { mkdirSync(join(root, "log"), { recursive: true }); appendFileSync(join(root, "log", file), JSON.stringify(e) + "\n"); };

test("counts proposals per source over the window: kept, dropped, open, and the keep rate", () => {
  const root = makeBrain();
  for (let i = 0; i < 9; i++) proposal(root, `g${i}`, `granola:n${i}@2026-10-0${(i % 7) + 2}T00:00:00Z`, `2026-10-0${(i % 7) + 2}`, "accept");
  proposal(root, "g9", "granola:n9@1", "2026-10-07", "reject");
  proposal(root, "m1", "gmail:abc", "2026-10-06", "reject");
  proposal(root, "m2", "gmail:def", "2026-10-08");
  proposal(root, "old", "gmail:old", "2026-09-01", "accept"); // outside the window
  const f = fill(root, 7);
  const g = f.sources.find((s) => s.source === "granola")!;
  expect(g).toMatchObject({ proposed: 10, kept: 9, dropped: 1, open: 0 });
  expect(g.keepRate).toBeCloseTo(0.9);
  const m = f.sources.find((s) => s.source === "gmail")!;
  expect(m).toMatchObject({ proposed: 2, kept: 0, dropped: 1, open: 1 });
  expect(f.total).toMatchObject({ proposed: 12, kept: 9, dropped: 2, open: 1 });
});

test("only the capture pipeline counts: an agent's own proposal is not the brain filling itself", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-helper-1.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "helper", reason: "trial tier", request: { agent: "helper", id: "people/jane-roy", attribute: "role", value: "x", sources: ["agent:helper"] } }));
  expect(fill(root, 7).total.proposed).toBe(0);
});

test("re-confirmations from a pull count per source, without an owner tap", () => {
  const root = makeBrain();
  log(root, "writes.jsonl", { at: "2026-10-07T10:00:00Z", agent: "hub", kind: "source-confirm", key: "people/jane-roy#role", outcome: "committed", source: "granola:n1@x" });
  log(root, "writes.jsonl", { at: "2026-10-07T10:00:00Z", agent: "hub", kind: "source-confirm", key: "people/jane-roy#role", outcome: "committed", source: "gmail:a/b" });
  log(root, "writes.jsonl", { at: "2026-09-07T10:00:00Z", agent: "hub", kind: "source-confirm", key: "people/jane-roy#role", outcome: "committed", source: "gmail:a/c" });
  const f = fill(root, 7);
  expect(f.sources.find((s) => s.source === "granola")!.confirmed).toBe(1);
  expect(f.sources.find((s) => s.source === "gmail")!.confirmed).toBe(1);
});

test("the verdict holds the week to the self-filling targets: 50 facts, 85% kept, 2 owner minutes a day", () => {
  const root = makeBrain();
  for (let i = 0; i < 60; i++) proposal(root, `g${i}`, `granola:n${i}@1`, "2026-10-07", i < 54 ? "accept" : "reject");
  log(root, "owner-time.jsonl", { at: "2026-10-07T08:00:00Z", via: "dashboard", minutes: 3 });
  const f = fill(root, 7);
  expect(f.verdict.volume).toBe("pass"); // 60 >= 50
  expect(f.verdict.keep).toBe("pass");   // 90% >= 85%
  expect(f.verdict.minutes).toBe("pass"); // 3 minutes over 7 days
  const thin = fill(makeBrain(), 7);
  expect(thin.verdict).toEqual({ volume: "fail", keep: "no data", minutes: "no data" });
});

test("the text names each source with its numbers and says what to do when nothing fills", () => {
  const root = makeBrain();
  proposal(root, "g1", "granola:n1@1", "2026-10-07", "accept");
  const out = renderFill(fill(root, 7));
  expect(out).toContain("granola: 1 proposed, 1 kept, 0 dropped, 0 open, 0 re-confirmed (keep 100%)");
  expect(out).toMatch(/volume fail/);
  const empty = renderFill(fill(makeBrain(), 7));
  expect(empty).toContain("Nothing reached the brain from a source");
});

// ---------- fill quality in the week report (backlog #219) ----------

test("quality per source: accepted, edited after accepting, rejected; acceptance counts an edited card as a miss", () => {
  const root = makeBrain();
  for (let i = 0; i < 6; i++) proposal(root, `g${i}`, `granola:n${i}`, "2026-10-06", "accept", "2026-10-06");
  proposal(root, "g6", "granola:n6", "2026-10-06", "reject", "2026-10-06");
  // The owner fixed the accepted fact by hand afterwards: the card was accepted but edited.
  log(root, "writes.jsonl", { at: "2026-10-07T09:00:00Z", agent: "owner", kind: "owner-edit", op: "set", key: "people/jane-roy#role", outcome: "committed" });
  const q = fillQuality(root, 7).sources.find((s) => s.source === "granola")!;
  expect(q).toMatchObject({ accepted: 6, edited: 6, rejected: 1 });
  expect(q.acceptance).toBeCloseTo(0); // every accepted card was edited after
});

test("owner seconds per card come from the owner's minutes over the cards decided in the window", () => {
  const root = makeBrain();
  for (let i = 0; i < 10; i++) proposal(root, `m${i}`, `gmail:m${i}`, "2026-10-07", i < 8 ? "accept" : "reject", "2026-10-07");
  log(root, "owner-time.jsonl", { at: "2026-10-07T08:00:00Z", via: "self", minutes: 5 });
  const q = fillQuality(root, 7);
  expect(q.decided).toBe(10);
  expect(q.secondsPerCard).toBe(30);
});

test("a source under 70% acceptance over 5+ decisions gets a nudge in the week report; a good one doesn't", () => {
  const root = makeBrain();
  for (let i = 0; i < 6; i++) proposal(root, `d${i}`, `discord:x${i}`, "2026-10-06", i < 3 ? "accept" : "reject", "2026-10-06");
  for (let i = 0; i < 6; i++) proposal(root, `g${i}`, `granola:n${i}`, "2026-10-06", "accept", "2026-10-06");
  proposal(root, "c1", "gcal:e1", "2026-10-06", "reject", "2026-10-06"); // one decision: too few to judge
  const text = week(root, "2026-10-08").text;
  expect(text).toContain("## Fill quality");
  expect(text).toMatch(/discord: 3 accepted, 0 edited, 3 rejected \(50% accepted\)/);
  expect(text).toMatch(/Turn down discord: 50% accepted/);
  expect(text).not.toMatch(/Turn down granola/);
  expect(text).not.toMatch(/Turn down gcal/);
});

test("no capture cards in the week: the week report says so in one line", () => {
  const text = week(makeBrain(), "2026-10-08").text;
  expect(text).toContain("## Fill quality");
  expect(text).toContain("No source proposals decided this week.");
});

test("only a change to the accepted value counts as edited: \"Still true\" and a note-text edit don't lower acceptance", () => {
  const root = makeBrain();
  for (let i = 0; i < 2; i++) proposal(root, `g${i}`, `granola:n${i}`, "2026-10-06", "accept", "2026-10-06");
  confirmFact(root, "people/jane-roy", "role");
  saveNoteBody(root, "people/jane-roy", "Jane, rewritten by hand.\n");
  expect(fillQuality(root, 7).sources[0]).toMatchObject({ accepted: 2, edited: 0, acceptance: 1 });
  setFact(root, "people/jane-roy", "role", "Head of research");
  expect(fillQuality(root, 7).sources[0]).toMatchObject({ accepted: 2, edited: 2 });
});
