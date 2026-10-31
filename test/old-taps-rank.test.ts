// SPDX-License-Identifier: AGPL-3.0-only
// A Yes tap from before G424 was saved as the owner's word (an owner:<date>/inbox/<proposal> ref
// and confirmed-by-owner), so a newer email bowed to an assistant's tapped claim as if the owner
// had typed it. At the hub's start each such tap becomes what a tap is now: an approved: ref, the
// fact ranked as the source it cites. The owner's typed word (a registered message, an answer to a
// conflict) stays his word. One hub commit with a why; a second run changes nothing.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { rankOldTaps, write } from "../src/write";
import { registerLouisMessages } from "../src/louis";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const rec = (value: string, sources: string[], verification = "confirmed-by-owner") => `{ value: "${value}", as_of: 2026-10-20, sources: [${sources.map((s) => `"${s}"`).join(", ")}], verification: ${verification}, by: planner, recorded: 2026-10-20 }`;
const fact = (root: string, id: string, attr: string) => loadBrain(root).find((n) => n.fm.id === id)!.fm.facts![attr] as FactRecord;

function brain() {
  const root = makeBrain();
  process.env.PB_TODAY = "2026-10-26";
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  // Tapped: an assistant's claim, cited to an assistant's memory, accepted on the deck.
  writeFileSync(join(root, "inbox", "decided", "2026-10-20-planner-aaaa1111.yaml"), YAML.stringify({ by: "owner", decision: "accept", request: { kind: "fact", agent: "planner", id: "people/kai-moss", attribute: "role", value: "Coach", sources: ["agent:planner/2026-10-20"], verification: "self-reported" } }));
  // Tapped, the proposal claiming the owner's word with no owner message: the claim is dropped.
  writeFileSync(join(root, "inbox", "decided", "2026-10-20-planner-bbbb2222.yaml"), YAML.stringify({ by: "owner", decision: "accept", request: { kind: "fact", agent: "planner", id: "people/kai-moss", attribute: "org", value: "Hill School", sources: ["gmail:f000000000000031"], verification: "confirmed-by-owner" } }));
  registerLouisMessages(root, ["louis:2026-10-19/msg-77"], "test");
  writeFileSync(join(root, "people", "kai-moss.md"), `---\nid: people/kai-moss\ntype: person\ntitle: Kai Moss\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  role: ${rec("Coach", ["agent:planner/2026-10-20", "owner:2026-10-20/inbox/2026-10-20-planner-aaaa1111.yaml"])}\n  org: ${rec("Hill School", ["gmail:f000000000000031", "owner:2026-10-20/inbox/2026-10-20-planner-bbbb2222.yaml"])}\n  phone_note: ${rec("Call after six", ["louis:2026-10-19/msg-77", "owner:2026-10-20/inbox/2026-10-20-planner-cccc3333.yaml"])}\n  city: ${rec("Laval", ["owner:2026-10-20/dashboard-c-0001"])}\nhistory:\n  title: [${rec("Teacher", ["agent:planner/2026-10-01", "owner:2026-10-02/inbox/2026-10-02-planner-dddd4444.yaml"])}]\n---\n`);
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  return root;
}

test("an old Yes tap ranks as its source; typed words stay the owner's", () => {
  const root = brain();
  expect(rankOldTaps(root).sort()).toEqual(["people/kai-moss#org", "people/kai-moss#phone_note", "people/kai-moss#role", "people/kai-moss#title"]);
  const role = fact(root, "people/kai-moss", "role");
  expect(role.sources).toEqual(["agent:planner/2026-10-20", "approved:2026-10-20/inbox/2026-10-20-planner-aaaa1111.yaml"]);
  expect(role.verification).toBe("self-reported");
  // The proposal claimed the owner's word without his message: as a tap does now, the claim goes.
  expect(fact(root, "people/kai-moss", "org").verification).toBe("self-reported");
  // His registered message is his word: the tap ref changes, the verification stays.
  const note = fact(root, "people/kai-moss", "phone_note");
  expect(note.verification).toBe("confirmed-by-owner");
  expect(note.sources).toEqual(["louis:2026-10-19/msg-77", "approved:2026-10-20/inbox/2026-10-20-planner-cccc3333.yaml"]);
  // His answer to a conflict on the dashboard is not a tap on a proposal.
  expect(fact(root, "people/kai-moss", "city").verification).toBe("confirmed-by-owner");
  const hist = loadBrain(root).find((n) => n.fm.id === "people/kai-moss")!.fm.history!.title[0];
  expect(hist.sources).toEqual(["agent:planner/2026-10-01", "approved:2026-10-02/inbox/2026-10-02-planner-dddd4444.yaml"]);
  expect(hist.verification).toBe("self-reported");
  const log = sh(root, "git", "log", "-1", "--format=%an%n%B").stdout.toString();
  expect(log).toMatch(/^hub\n/);
  expect(log).toMatch(/Why: .*G424/);
  expect(sh(root, "git", "status", "--porcelain").stdout.toString().trim()).toBe("");
  expect(rankOldTaps(root)).toEqual([]);
});

test("a newer claim from as strong a source updates an old tapped assistant claim once it ranks as one", () => {
  const newer = { kind: "fact", agent: "planner", id: "people/kai-moss", attribute: "role", value: "Head coach", as_of: "2026-10-24", sources: ["agent:planner/2026-10-24"] } as never;
  const before = brain();
  expect(write(before, newer, {}).outcome).not.toBe("committed");
  expect(fact(before, "people/kai-moss", "role").value).toBe("Coach");
  const root = brain();
  rankOldTaps(root);
  expect(write(root, newer, {}).outcome).toBe("committed");
  expect(fact(root, "people/kai-moss", "role").value).toBe("Head coach");
});
