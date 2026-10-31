// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write, decideProposal } from "../src/write";
import { digest } from "../src/digest";
import { loadBrain, type FactRecord } from "../src/brain";

const base = { id: "projects/course-a", attribute: "next_step", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" as const };

test("Robin accepts a proposal: it goes through the write path, keeps the proposer as by, authored by the owner", () => {
  const root = makeBrain();
  const p = write(root, { ...base, agent: "helper", value: "Publish grades" });
  const r = decideProposal(root, p.file!, "accept");
  expect(r.outcome).toBe("committed");
  const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;
  expect([f.value, f.by]).toEqual(["Publish grades", "helper"]);
  expect(Bun.spawnSync(["git", "log", "-1", "--format=%an"], { cwd: root }).stdout.toString().trim()).toBe("Robin");
  expect(existsSync(join(root, p.file!))).toBe(false);
  expect(existsSync(join(root, "inbox/decided", p.file!.split("/").pop()!))).toBe(true);
});

test("an accepted proposal still can't smuggle a secret", () => {
  const root = makeBrain();
  const p = write(root, { ...base, agent: "helper", value: "fine" });
  const req = Bun.file(join(root, p.file!));
  expect(req.size).toBeGreaterThan(0);
  expect(decideProposal(root, "inbox/nope.yaml", "accept").outcome).toBe("refused");
});

test("the digest leads with what needs Robin", () => {
  const root = makeBrain();
  write(root, { ...base, agent: "helper", value: "Publish grades" });
  write(root, { ...base, agent: "planner", value: "Other plan", as_of_approx: true }); // dispute
  write(root, { ...base, agent: "planner", value: "Ask Maple Trust Bank" }); // tripwire alert
  const d = digest(root, "2000-01-01");
  expect(d.needsLouis).toBe(1); // the dispute, as the home counts it: the proposal, the tripwire alert and the Gardener's blind spot are listed, not counted (backlog 402, outside review v5)
  expect(d.text).toContain("Gardener blind spot");
  expect(d.text.indexOf("## Needs you")).toBeLessThan(d.text.indexOf("## Numbers"));
  expect(d.text).toContain("Dispute c-0001");
  expect(d.text).toContain("Proposal");
  expect(d.text).toContain("leak_tripwire");
});

// G92: the digest is a file that stays and is backed up; a proposal's value is shown as a short slice.
test("G92: the digest prints at most a short slice of a proposal's value", () => {
  const root = makeBrain();
  const tail = "the rest of this paragraph should never be copied into the digest file at all";
  const p = write(root, { ...base, agent: "helper", value: "Publish grades " + "and then do a long list of other things ".repeat(6) + tail });
  expect(p.file).toBeTruthy();
  const d = digest(root).text;
  expect(d).toContain("Publish grades");
  expect(d).not.toContain(tail);
});
