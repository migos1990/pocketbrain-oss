// SPDX-License-Identifier: AGPL-3.0-only
// A tap is an approval, not the owner's own word (owner's choice 2026-10-25, outside review: 77 of
// 78 taps were yes, and each one raised an assistant's claim to the top rank). Accepting a
// proposal still settles it, but the fact keeps its source's rank and carries an approved: ref
// ("you approved"), so a stronger source later replaces it without asking and the trust audit
// doesn't count it as checked.
import { test, expect } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { write, decideProposal } from "../src/write";
import { loadBrain, type FactRecord } from "../src/brain";
import { git } from "../src/git";
import { refString, sourceRank } from "../src/sources";
import { factTrust } from "../src/trust";

function propose(root: string, value = "Book room 12", as_of = "2026-10-07") {
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-planner-step.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "planner", reason: "area owned by someone else", request: { agent: "planner", kind: "fact", id: "projects/course-a", attribute: "next_step", value, as_of, sources: ["agent:planner"] } }));
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "planner: propose"], "planner");
}
const step = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts!.next_step as FactRecord;

test("an accepted proposal settles but keeps its source's rank, marked approved", () => {
  const root = makeBrain();
  propose(root);
  expect(decideProposal(root, "2026-10-08-planner-step.yaml", "accept").outcome).toBe("committed");
  const f = step(root);
  expect(f.value).toBe("Book room 12");
  const refs = (f.sources ?? []).map(refString);
  expect(refs.some((r) => r.startsWith("approved:"))).toBe(true);
  expect(refs.some((r) => /^(owner|louis):/.test(r))).toBe(false);
  expect(f.verification).not.toBe("confirmed-by-owner");
  expect(sourceRank(f)).toBe(sourceRank({ sources: ["agent:planner"], verification: f.verification }));
});

test("the trust audit doesn't count an approval as checked", () => {
  const root = makeBrain();
  propose(root);
  decideProposal(root, "2026-10-08-planner-step.yaml", "accept");
  const t = factTrust(root).find((x) => x.key === "projects/course-a#next_step")!;
  expect(t.checked).toBeUndefined();
});

test("a later message the hub read replaces an approved value without a conflict card", () => {
  const root = makeBrain();
  propose(root);
  decideProposal(root, "2026-10-08-planner-step.yaml", "accept");
  const r = write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Book room 14", as_of: "2026-10-08", sources: ["gmail:f000000000000009"], verification: "verified-by-source" });
  expect(r.outcome).toBe("committed");
  expect(step(root).value).toBe("Book room 14");
});

// Slice audit 2026-10-25: approved: is the hub's record of a tap, so no writer may cite one itself.
test("an assistant citing an approved: ref itself is refused", () => {
  const root = makeBrain();
  for (const sources of [["approved:2026-10-08/inbox/x.yaml"], ["agent-relay:other/1", "approved:2026-10-08/inbox/x.yaml"]]) {
    const r = write(root, { agent: "planner", id: "projects/course-a", attribute: "next_step", value: "Book room 15", as_of: "2026-10-08", sources });
    expect(r.outcome).toBe("refused");
    expect(r.fails?.map((f) => f.check)).toContain("approved_ref");
  }
  expect(step(root).value).not.toBe("Book room 15");
});

test("accepting a proposal that claims the owner's word without a message saves it as an approval", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-planner-claim.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "planner", reason: "owner_message_registered", request: { agent: "planner", kind: "fact", id: "projects/course-a", attribute: "next_step", value: "Book room 16", as_of: "2026-10-07", sources: ["agent:planner"], verification: "confirmed-by-owner" } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "planner: propose"], "planner");
  expect(decideProposal(root, "2026-10-08-planner-claim.yaml", "accept").outcome).toBe("committed");
  expect(step(root).value).toBe("Book room 16");
  expect(step(root).verification).not.toBe("confirmed-by-owner");
});

// Second slice audit 2026-10-25: other places still read only confirmed-by-owner as the owner's yes.
test("an address approved on a card is trusted for same-person and standing", async () => {
  const root = makeBrain();
  const person = loadBrain(root).find((x) => x.fm.type === "person")!;
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-planner-mail.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "planner", reason: "area owned by someone else", request: { agent: "planner", kind: "fact", id: person.fm.id, attribute: "email", value: "card.addr@example.com", as_of: "2026-10-07", sources: ["agent:planner"] } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "planner: propose"], "planner");
  expect(decideProposal(root, "2026-10-08-planner-mail.yaml", "accept").outcome).toBe("committed");
  const { confirmedAddresses } = await import("../src/standing");
  expect(confirmedAddresses(root, person.fm.id)).toContain("card.addr@example.com");
});

test("auto-decide never carries an approved: ref a proposal file holds", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-08-x-capture.yaml"), YAML.stringify({ proposed: "2026-10-08", by: "steward", capture: "inbox/captures/x.md", request: { agent: "steward", kind: "fact", id: "projects/course-a", attribute: "next_step", value: "Book room 17", as_of: "2026-10-07", sources: ["gmail:f000000000000009", "approved:2026-10-08/inbox/y.yaml"] } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-qm", "steward: propose"], "steward");
  expect(decideProposal(root, "2026-10-08-x-capture.yaml", "accept", "auto-decide").outcome).not.toBe("refused");
  expect(readFileSync(join(root, "projects/course-a.md"), "utf8")).toContain("Book room 17");
  expect(readFileSync(join(root, "projects/course-a.md"), "utf8")).not.toContain("approved:2026-10-08/inbox/y.yaml");
});
