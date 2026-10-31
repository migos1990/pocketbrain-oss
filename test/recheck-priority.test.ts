// SPDX-License-Identifier: AGPL-3.0-only
// Backlog 310 (docs/gardener.md, "What gets rechecked first"): a recheck pass reads first the
// sources behind facts that rest on one source, weakly backed, that agents read most; a fresh
// single-source fact agents read is rechecked once a month; the week report shows how much of
// what agents read rests on two or more sources. Fixtures only; no model.
import { test, expect, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { recheckCandidates, recheckDue, readCounts } from "../src/pull";
import { corroboration, week } from "../src/measure";

afterEach(() => { process.env.PB_TODAY = "2026-10-08"; });

const note = (root: string, id: string, attr: string, rec: string) => {
  mkdirSync(join(root, id.split("/")[0]), { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: project\ntitle: ${id.split("/")[1]}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nby: planner\nfacts:\n  ${attr}: ${rec}\n---\n`);
};
const reads = (root: string, agent: string, id: string, n: number, at = "2026-10-05T10:00:00Z") => {
  mkdirSync(join(root, "log"), { recursive: true });
  for (let i = 0; i < n; i++) appendFileSync(join(root, "log/reads.jsonl"), JSON.stringify({ at, agent, op: "read", ids: [id] }) + "\n");
};

function setup() {
  const root = makeBrain({ git: false });
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { gmail: { kind: "gmail", where: ["Label_school"], fixture: "mail.json" } } }));
  writeFileSync(join(root, "mail.json"), "[]");
  // Stale, two sources, exact, read a lot: well backed.
  note(root, "projects/strong", "next_step", `{ value: Book room B-201, as_of: 2026-01-01, sources: ["gmail:a000000000000001", "gmail:a000000000000002"], verification: verified-by-source, by: planner }`);
  reads(root, "planner", "projects/strong", 9);
  // Due, one self-reported source, read 5 times: the most at stake.
  note(root, "projects/weak-read", "next_step", `{ value: Send the grades, as_of: 2026-09-20, sources: ["gmail:b000000000000001"], verification: self-reported, by: helper }`);
  reads(root, "helper", "projects/weak-read", 5);
  // Fresh, one self-reported source, read twice, never confirmed: rechecked though not due.
  note(root, "projects/fresh-read", "next_step", `{ value: Order the textbooks, as_of: 2026-10-07, sources: ["gmail:c000000000000001"], verification: self-reported, by: helper }`);
  reads(root, "planner", "projects/fresh-read", 2);
  // Stale, one exact source, never read.
  note(root, "projects/unread", "next_step", `{ value: Renew the lab, as_of: 2026-01-01, sources: ["gmail:d000000000000001"], verification: verified-by-source, by: planner }`);
  // Fresh, one source, not read: not a candidate.
  note(root, "projects/quiet", "next_step", `{ value: File the report, as_of: 2026-10-07, sources: ["gmail:e000000000000001"], verification: self-reported, by: helper }`);
  // Fresh, one source, read only by the gardener: its reads don't count.
  note(root, "projects/tended", "next_step", `{ value: Clean the lab, as_of: 2026-10-07, sources: ["gmail:f100000000000001"], verification: self-reported, by: helper }`);
  reads(root, "gardener", "projects/tended", 7);
  // Fresh, one source, read, confirmed last week: not again yet.
  note(root, "projects/confirmed", "next_step", `{ value: Print the exam, as_of: 2026-10-07, sources: ["gmail:f200000000000001"], verification: self-reported, last_confirmed: 2026-10-01, by: helper }`);
  reads(root, "planner", "projects/confirmed", 3);
  return root;
}

test("the weakest, most-read facts' sources come first; fresh read ones join; the rest wait", () => {
  const root = setup();
  const picks = recheckCandidates(root);
  const order = picks.map((p) => p.keys[0]);
  expect(order.slice(0, 2)).toEqual(["projects/weak-read#next_step", "projects/fresh-read#next_step"]);
  expect(order.indexOf("projects/unread#next_step")).toBeLessThan(order.indexOf("projects/strong#next_step"));
  for (const k of ["projects/quiet#next_step", "projects/tended#next_step", "projects/confirmed#next_step"]) expect(order).not.toContain(k);
  // A pass capped at two reads only the two most at stake.
  expect(picks.slice(0, 2).map((p) => p.ref)).toEqual(["gmail:b000000000000001", "gmail:c000000000000001"]);
});

test("a recheck pass with a cap reads the riskiest first", async () => {
  const root = setup();
  const r = await recheckDue(root, { max: 1, sample: 0 });
  expect(r.checked).toBe(1);
  // The weak, most-read fact's mail isn't in the fixture: unreachable, and nothing else was read.
  expect(r.unreachable).toBe(1);
});

test("only facts the caller may see are picked", () => {
  const root = setup();
  const picks = recheckCandidates(root, { allow: (id) => id !== "projects/weak-read" });
  expect(picks.map((p) => p.keys[0])).not.toContain("projects/weak-read#next_step");
  expect(picks[0].keys[0]).toBe("projects/fresh-read#next_step");
});

test("read counts leave out the gardener and reads older than the window", () => {
  const root = setup();
  reads(root, "planner", "projects/quiet", 4, "2026-08-01T10:00:00Z");
  const c = readCounts(root, 30, "2026-10-08");
  expect(c.get("projects/weak-read")).toBe(5);
  expect(c.has("projects/tended")).toBe(false);
  expect(c.has("projects/quiet")).toBe(false);
});

test("the week report shows how much of what assistants read rests on two or more sources", () => {
  const root = setup();
  expect(corroboration(root, "2026-10-08")).toEqual({ backed: 1, total: 4 });
  expect(week(root, "2026-10-08").text).toContain("Corroboration: 1 of 4 values on notes your assistants read this week rest on two or more sources (25%)");
});
