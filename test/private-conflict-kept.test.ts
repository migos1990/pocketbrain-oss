// SPDX-License-Identifier: AGPL-3.0-only
// A conflict on a page that holds a private fact is the owner's (the write path hands it back), so
// filing waits for the owner instead of logging "held it as a conflict" and losing it; and the save
// path never answers a proposal as accepted when the write handed back that same proposal
// (north-star replay 2026-10-26, G431).
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { asked } from "./asked";
import { decideProposal } from "../src/write";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
const mail = (id: string, line: string) => ({ id, threadId: id, internalDate: String(Date.parse("2026-10-07T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "Friend <friend@example.com>" }, { name: "To", value: "me@example.org" }, { name: "Subject", value: "Kai" }] }, text: line });

// Kai's org holds a private record (someone else's school is private); a mail says another org.
async function pulled() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  writeFileSync(join(root, "people", "kai-moss.md"), `---\nid: people/kai-moss\ntype: person\ntitle: Kai Moss\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  org: { value: "Hill School", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07, sensitivity: private }\n---\n`);
  writeFileSync(join(root, "m.json"), JSON.stringify([mail("aaaaaaaaaaaaaab1", "Kai Moss (person) org: Bay Institute")]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  await pullSource(root, "mail", { model });
  expect(inbox(root)).toHaveLength(1);
  return root;
}
const org = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/kai-moss")!.fm.facts!.org as FactRecord;

test("a conflict on a page with a private fact waits for the owner; nothing is logged held and lost", async () => {
  const root = await pulled();
  const now = new Date();
  expect(runAuto(root, now)).toEqual([]);
  expect(inbox(root)).toHaveLength(1);
  expect(org(root).value).toBe("Hill School");
  expect(asked(root, now).some((c) => c.kind === "proposal")).toBe(true);
});

test("the save path never answers it accepted with nothing saved: the value still waits for the owner", async () => {
  const root = await pulled();
  const r = decideProposal(root, inbox(root)[0], "accept", "auto-decide", [], { contest: true });
  expect(["committed", "disputed"]).not.toContain(r.outcome);
  // Handed back as this same proposal (the replay's case) it stays; under another name it is filed
  // again. Either way exactly one proposal of the value waits, and the live value is untouched.
  const left = inbox(root).map((f) => (YAML.parse(readFileSync(join(root, "inbox", f), "utf8")) as { request: { value: string } }).request.value);
  expect(left).toEqual(["Bay Institute"]);
  expect(org(root).value).toBe("Hill School");
});
