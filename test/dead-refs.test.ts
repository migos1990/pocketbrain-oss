// SPDX-License-Identifier: AGPL-3.0-only
// Dead source refs (docs/sources-pull.md, "Sources that vanish"): each night the hub also checks
// a few live facts' cited items still exist, oldest check first, even fresh facts nobody reads.
// An item gone at the source (mail deleted, event cancelled) turns the facts citing it due with
// "source gone"; a fact whose only source vanished stops reading as verified-by-source. Nothing is
// deleted and the value never changes. Fixtures only; no model.
import { test, expect, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { recheckCandidates, recheckDue, sampleRefs, verifySource } from "../src/pull";

afterEach(() => { process.env.PB_TODAY = "2026-10-08"; });

const MAIL = (id: string, text: string, deleted = false) => ({ id, labelIds: ["Label_school"], internalDate: "1760300000000", payload: { headers: [{ name: "Subject", value: "Course" }] }, text, ...(deleted ? { deleted: true } : {}) });
const note = (root: string, id: string, rec: string) => {
  mkdirSync(join(root, id.split("/")[0]), { recursive: true });
  writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: project\ntitle: ${id.split("/")[1]}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nby: planner\nfacts:\n  next_step: ${rec}\n---\n`);
};
const fact = (root: string, id: string) => loadBrain(root).find((n) => n.fm.id === id)!.fm.facts!.next_step as FactRecord;
const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_NAME: "x", GIT_COMMITTER_EMAIL: "x@x" } });

function setup() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { gmail: { kind: "gmail", where: ["Label_school"], fixture: "mail.json" } } }));
  writeFileSync(join(root, "mail.json"), JSON.stringify([
    MAIL("a000000000000001", "Book room B-201 for the final", true),
    MAIL("b000000000000001", "Order the textbooks"),
    MAIL("c000000000000001", "Renew the lab", true),
    MAIL("c000000000000002", "Renew the lab"),
  ]));
  // Fresh, one exact source, nobody reads it: no recheck would ever look. Its mail was deleted.
  note(root, "projects/vanished", `{ value: Book room B-201, as_of: 2026-10-07, sources: ["gmail:a000000000000001"], verification: verified-by-source, by: planner }`);
  // Fresh, its mail still there.
  note(root, "projects/present", `{ value: Order the textbooks, as_of: 2026-10-07, sources: ["gmail:b000000000000001"], verification: verified-by-source, by: planner }`);
  // Fresh, two sources, one deleted: still backed by the other.
  note(root, "projects/two", `{ value: Renew the lab, as_of: 2026-10-07, sources: ["gmail:c000000000000001", "gmail:c000000000000002"], verification: verified-by-source, by: planner }`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "louis: notes");
  return root;
}

test("a fresh fact nobody reads still has its source checked; gone at the source, it turns due and loses verified-by-source", async () => {
  const root = setup();
  expect(recheckCandidates(root).map((p) => p.keys[0])).not.toContain("projects/vanished#next_step");
  const r = await recheckDue(root);
  expect(r.due).toContain("projects/vanished#next_step");
  const f = fact(root, "projects/vanished");
  expect(f.value).toBe("Book room B-201");
  expect(f.recheck?.why).toBe("source gone");
  expect(f.review_after).toBe("2026-10-08");
  expect(f.verification).toBe("unverified");
  expect(f.note).toContain("source gone");
  // The note is still there, active.
  expect(loadBrain(root).find((n) => n.fm.id === "projects/vanished")!.fm.status).toBe("active");
});

test("an item still there changes nothing; a fact with another source keeps its verification but turns due", async () => {
  const root = setup();
  await recheckDue(root);
  const p = fact(root, "projects/present");
  expect(p.recheck).toBeUndefined();
  expect(p.verification).toBe("verified-by-source");
  const two = fact(root, "projects/two");
  expect(two.recheck?.why).toBe("source gone");
  expect(two.verification).toBe("verified-by-source");
});

test("the sample is capped and rotates: the refs checked longest ago go first", async () => {
  const root = setup();
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  // a000… and b000… were checked yesterday; c000…01 never.
  for (const ref of ["gmail:a000000000000001", "gmail:b000000000000001", "gmail:c000000000000002"]) appendFileSync(join(root, "log", "sources", "verify.jsonl"), JSON.stringify({ at: "2026-10-07T03:30:00Z", agent: "hub", ref, result: "present" }) + "\n");
  const order = sampleRefs(root);
  expect(order.indexOf("gmail:c000000000000001")).toBeLessThan(order.indexOf("gmail:a000000000000001"));
  expect(order.indexOf("gmail:c000000000000001")).toBeLessThan(order.indexOf("gmail:b000000000000001"));
  // Capped: with room for every never-checked item but not the ones checked yesterday, the
  // deleted mail checked yesterday waits for a later night.
  const r = await recheckDue(root, { sample: order.indexOf("gmail:c000000000000001") + 1 });
  expect(r.sampled).toBe(order.indexOf("gmail:c000000000000001") + 1);
  expect(fact(root, "projects/two").recheck?.why).toBe("source gone");
  expect(fact(root, "projects/vanished").recheck).toBeUndefined();
});

test("a fact already flagged by its gone source isn't checked again every night", async () => {
  const root = setup();
  await recheckDue(root);
  const before = fact(root, "projects/vanished").recheck;
  process.env.PB_TODAY = "2026-10-09";
  const r = await recheckDue(root);
  expect(r.due).not.toContain("projects/vanished#next_step");
  expect(fact(root, "projects/vanished").recheck).toEqual(before!);
});

test("only facts the caller may see are sampled", async () => {
  const root = setup();
  const r = await recheckDue(root, { allow: (id) => id !== "projects/vanished" });
  expect(r.due).not.toContain("projects/vanished#next_step");
  expect(fact(root, "projects/vanished").recheck).toBeUndefined();
});

test("verify_source on a deleted item says the source is gone and marks the fact", async () => {
  const root = setup();
  const v = await verifySource(root, "gardener", "gmail:a000000000000001", "Book room B-201", 40, undefined, () => true);
  expect(v.result).toBe("no-match");
  expect(v.due).toEqual(["projects/vanished#next_step"]);
  expect(fact(root, "projects/vanished").verification).toBe("unverified");
});
