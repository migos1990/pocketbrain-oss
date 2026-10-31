// SPDX-License-Identifier: AGPL-3.0-only
// The unknown-sender rule takes effect where captures file themselves (outside review 2026-10-25,
// G420; wired after file-in-write, G429): a mail from an address no person page holds on trusted
// evidence can't file a private or money fact; it waits for the owner with the reason, and the save
// path refuses the hub's own accept of it. A different value from it is weighed like any other
// (a conflict for the Gardener, live value kept), and anything else it says files as usual.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, saveNote, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { asked } from "./asked";
import { decideProposal } from "../src/write";
import { probeInit } from "../src/canary";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const inbox = (root: string) => existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")) : [];
const disputes = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute");
const mail = (id: string, from: string, line: string) => ({ id, threadId: id, internalDate: String(Date.parse("2026-10-07T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: from }, { name: "To", value: "me@example.org" }, { name: "Subject", value: "Course C" }] }, text: line });

async function pulled(from: string, line: string, knownFriend = false, plant?: (root: string) => string) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: "Write the exam", as_of: 2026-10-07, sources: ["gmail:f000000000000031"], verification: self-reported, by: planner, recorded: 2026-10-07 }\n---\n`);
  writeFileSync(join(root, "projects", "course-p.md"), `---\nid: projects/course-p\ntype: project\ntitle: Course P\narea: work\nsensitivity: private\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  writeFileSync(join(root, "projects", "course-d.md"), `---\nid: projects/course-d\ntype: project\ntitle: Course D\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\n---\n`);
  if (knownFriend) {
    const n = loadBrain(root).find((x) => x.fm.type === "person")!;
    n.fm.facts = { ...(n.fm.facts ?? {}), email: { value: "friend@example.com", as_of: "2026-10-01", sources: ["owner:2026-10-01/inbox/x"], verification: "confirmed-by-owner", by: "owner", recorded: "2026-10-01" } as never };
    saveNote(root, n);
  }
  if (plant) line = plant(root);
  writeFileSync(join(root, "m.json"), JSON.stringify([mail("aaaaaaaaaaaaaaa7", from, line)]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  await pullSource(root, "mail", { model });
  expect(inbox(root)).toHaveLength(1);
  return root;
}
const step = (root: string) => (loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord);

// Mac, 2026-10-27 05:30Z: 8 released held notes sat as proposals the owner's home never shows.
// A stranger's private fact is now saved under the serving hold instead (G454): served to no
// assistant until the owner taps Show, marked as from a sender no person page holds; no card.
test("a stranger's private fact is saved where only the owner sees it, marked unknown sender; no card", async () => {
  const root = await pulled("Stranger <stranger@example.net>", "Course P (project) next_step: Sign the settlement");
  const now = new Date();
  expect(runAuto(root, now).map((d) => d.picked)).toEqual(["saved it"]);
  expect(inbox(root)).toHaveLength(0);
  const rec = loadBrain(root).find((n) => n.fm.id === "projects/course-p")!.fm.facts?.next_step as FactRecord;
  expect(rec.value).toBe("Sign the settlement");
  expect(rec.unseen).toBe(true);
  expect(rec.sender).toBe("unknown");
  expect(JSON.stringify(rec)).not.toContain("example.net");
  expect(asked(root, now, "proposal")).toEqual([]);
});

test("a stranger's different value is a conflict for the Gardener; the live value stays", async () => {
  const root = await pulled("Stranger <stranger@example.net>", "Course C (project) next_step: Cancel the exam");
  expect(runAuto(root, new Date()).map((d) => d.picked)).toEqual(["held it as a conflict"]);
  expect(step(root).value).toBe("Write the exam");
  expect(disputes(root)).toHaveLength(1);
});

test("the same contradiction from a known sender is a conflict for the Gardener, as before", async () => {
  const root = await pulled("Friend <friend@example.com>", "Course C (project) next_step: Cancel the exam", true);
  expect(runAuto(root, new Date()).map((d) => d.picked)).toEqual(["held it as a conflict"]);
});

test("a stranger's new, ordinary fact still files itself", async () => {
  const root = await pulled("Stranger <stranger@example.net>", "Course D (project) next_step: Book the room");
  expect(runAuto(root, new Date()).map((d) => d.picked)).toEqual(["saved it"]);
});

test("the save path itself holds an unknown sender's private fact, whoever runs it", async () => {
  const root = await pulled("Stranger <stranger@example.net>", "Course P (project) next_step: Sign the settlement");
  const r = decideProposal(root, inbox(root)[0], "accept", "auto-decide", [], { hold: true });
  expect(r.outcome).toBe("committed");
  const rec = loadBrain(root).find((n) => n.fm.id === "projects/course-p")!.fm.facts?.next_step as FactRecord;
  expect([rec.unseen, rec.sender]).toEqual([true, "unknown"]);
});

test("a known sender's private fact is held as before, without the unknown-sender mark", async () => {
  const root = await pulled("Friend <friend@example.com>", "Course P (project) next_step: Sign the settlement", true);
  runAuto(root, new Date());
  const rec = loadBrain(root).find((n) => n.fm.id === "projects/course-p")!.fm.facts?.next_step as FactRecord;
  expect(rec.unseen).toBe(true);
  expect(rec.sender).toBeUndefined();
});

test("the same private fact from a known sender files itself", async () => {
  const root = await pulled("Friend <friend@example.com>", "Course P (project) next_step: Sign the settlement", true);
  expect(runAuto(root, new Date()).map((d) => d.picked)).toEqual(["saved it"]);
});

// Mac, 2026-10-27 05:30Z: a capture the write path refused for a value its agent was never shown
// (leak_tripwire) stayed open as a proposal. The refusal already alerts the owner; the
// proposal is dropped (G454), so the alert is the only thing that asks.
test("a capture refused by the leak tripwire is dropped from the inbox; the alert stays", async () => {
  const root = await pulled("Stranger <stranger@example.net>", "Course D (project) next_step: Book the room", false, (r) => {
    const c = probeInit(r).planted[0].canary;
    return `Course D (project) next_step: Ask about ${c}`;
  });
  const done = runAuto(root, new Date());
  expect(done).toHaveLength(1);
  expect(inbox(root)).toHaveLength(0);
  expect(asked(root, new Date(), "proposal")).toEqual([]);
  const alerts = readFileSync(join(root, "log", "alerts.jsonl"), "utf8");
  expect(alerts).toMatch(/canary|leak_tripwire/);
});
