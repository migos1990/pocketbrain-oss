// SPDX-License-Identifier: AGPL-3.0-only
// The cited-message check holds on the hub's own filing path too, for every kind of item the hub
// can read, and a ref the hub never read ranks as the writer's own word, not as an exact source
// (audit v3 2026-10-26, item 5; G441). Only the owner's own accept skips the check.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { write, decideProposal } from "../src/write";
import { recordCheckedRefs } from "../src/louis";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const FAKE = "gmail:00000000000fa4e1";
function brain(heldSources: string[], heldAsOf = "2026-10-05") {
  const root = makeBrain();
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: "Write the exam", as_of: ${heldAsOf}, sources: [${heldSources.map((s) => `"${s}"`).join(", ")}], verification: self-reported, by: planner, recorded: ${heldAsOf} }\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  return root;
}
const step = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord;
const say = (value: string, sources: string[], as_of = "2026-10-05") => ({ kind: "fact", agent: "planner", id: "projects/course-c", attribute: "next_step", value, as_of, sources, verification: "self-reported" }) as never;

test("a mail id the hub never read doesn't outrank an assistant's word on the same day", () => {
  const root = brain(["agent:planner/2026-10-05"]);
  const r = write(root, say("Cancel the exam", [FAKE]), {});
  // As strong as the word it contradicts on the same day: a conflict, never a replacement.
  expect(r.outcome).toBe("disputed");
  expect(step(root).value).not.toBe("Cancel the exam");
});

test("the same id once the hub has read it is an exact source and outranks it", () => {
  const root = brain(["agent:planner/2026-10-05"]);
  recordCheckedRefs(root, { [FAKE]: true });
  write(root, say("Cancel the exam", [FAKE]), {});
  expect(step(root).value).toBe("Cancel the exam");
});

test("a held value cited to an unread mail id gives way to a newer word like any word", () => {
  const root = brain([FAKE], "2026-10-02");
  const r = write(root, say("Cancel the exam", ["agent:planner/2026-10-06"], "2026-10-06"), {});
  expect(r.outcome).toBe("committed");
  expect(step(root).value).toBe("Cancel the exam");
});

test("the hub's own filing refuses a cited item found missing, of any kind it reads; the owner's accept doesn't", () => {
  for (const ref of [FAKE, "imessage:abc123@1"]) {
    const root = brain(["agent:planner/2026-10-05"]);
    recordCheckedRefs(root, { [ref]: false });
    mkdirSync(join(root, "inbox"), { recursive: true });
    writeFileSync(join(root, "inbox", "p.yaml"), YAML.stringify({ by: "steward", capture: "inbox/captures/x.md", request: { kind: "fact", agent: "steward", id: "projects/course-c", attribute: "room", value: "B-201", as_of: "2026-10-05", sources: [ref], verification: "self-reported" } }));
    sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "p");
    const r = decideProposal(root, "p.yaml", "accept", "auto-decide");
    expect(r.outcome).toBe("refused");
    expect(r.fails?.map((f) => f.check)).toContain("source_exists");
    expect(decideProposal(root, "p.yaml", "accept", "owner").outcome).not.toBe("refused");
  }
});
