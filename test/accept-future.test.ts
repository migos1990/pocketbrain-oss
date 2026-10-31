// SPDX-License-Identifier: AGPL-3.0-only
// Accepting a suggestion dated after today (owner, 2026-10-24: tapping Add on a Gardener question
// showed "as_of_not_future ... send it again with that date"). The owner's yes is his word as of
// today, so the accepted fact is dated today and saves; the as_of check still refuses an
// assistant's own write dated in the future, and a proposal the owner rejects is left as it was.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write, decideProposal } from "../src/write";
import { loadBrain, today, type FactRecord } from "../src/brain";
import { git } from "../src/git";

function future(root: string, as_of = "2099-01-01") {
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-gardener-q.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "gardener", reason: "gardener is a trial agent: propose-only", request: { agent: "gardener", kind: "fact", id: "projects/course-a", attribute: "open_question", value: "Did the check-in happen?", as_of, sources: ["agent:gardener"] } }));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "gardener: propose"], "gardener");
}

test("the owner accepting a future-dated suggestion saves it, dated today", () => {
  const root = makeBrain();
  future(root);
  const r = decideProposal(root, "2026-10-08-gardener-q.yaml", "accept");
  expect(r.outcome).not.toBe("refused");
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.open_question as FactRecord;
  expect(f.value).toBe("Did the check-in happen?");
  expect(f.as_of).toBe(today());
});

test("an assistant's own write dated after today is still refused", () => {
  const root = makeBrain();
  const r = write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "X", as_of: "2099-01-01", sources: ["gmail:f000000000000006"], verification: "verified-by-source" } as never);
  expect(r.outcome).toBe("refused");
  expect(r.message).toContain("as_of_not_future");
});

test("only the owner's yes redates it: the hub's auto-decide accepting it is still refused", () => {
  const root = makeBrain();
  future(root);
  const r = decideProposal(root, "2026-10-08-gardener-q.yaml", "accept", "auto-decide");
  expect(r.outcome).toBe("refused");
  expect(r.message).toContain("as_of_not_future");
  expect(existsSync(join(root, "inbox", "2026-10-08-gardener-q.yaml"))).toBe(true);
  expect(loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts?.open_question).toBeUndefined();
});

test("a proposal dated today keeps its date", () => {
  for (const as_of of [today()]) {
    const root = makeBrain();
    future(root, as_of);
    const r = decideProposal(root, "2026-10-08-gardener-q.yaml", "accept");
    expect(r.outcome).not.toBe("refused");
    const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.open_question as FactRecord;
    expect(String(f.as_of).slice(0, 10)).toBe(today());
  }
});

// The builder's gate, 2026-10-25: a proposal file git never tracked (written straight into inbox/)
// made the answer's commit fail after the fact was saved, and the owner read "fatal: pathspec ...".
test("answering a proposal git never tracked records the answer, with no git error", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-untracked.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "helper", reason: "helper is a trial agent: propose-only", request: { agent: "helper", kind: "fact", id: "projects/course-a", attribute: "room", value: "B-204", as_of: "2026-10-07", sources: ["gmail:f000000000000403"], verification: "verified-by-source" } }));
  const r = decideProposal(root, "2026-10-08-untracked.yaml", "accept");
  expect(r.outcome).not.toBe("refused");
  expect(r.message).not.toMatch(/pathspec|fatal/);
  expect(existsSync(join(root, "inbox", "2026-10-08-untracked.yaml"))).toBe(false);
  expect(git(root, ["status", "--porcelain", "--", "inbox"])).toBe("");
});
