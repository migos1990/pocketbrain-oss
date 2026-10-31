// SPDX-License-Identifier: AGPL-3.0-only
// What "Filed for you" says is what the write did (audit v3, 2026-10-26, item 4; G436): a newer mail
// over an older value from a different kind of source (an assistant's word) is an update by the
// write path's rule (newer, as strong a source), so it is never logged "held it as a conflict"
// while the value was replaced with no conflict. A same-day different value is still a conflict.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });
const disputes = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute");

async function pulled(heldAsOf: string) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: planner\nfacts:\n  next_step: { value: "Write the exam", as_of: ${heldAsOf}, sources: ["agent:planner/${heldAsOf}"], verification: self-reported, by: planner, recorded: ${heldAsOf} }\n---\n`);
  writeFileSync(join(root, "m.json"), JSON.stringify([{ id: "aaaaaaaaaaaaaac1", threadId: "aaaaaaaaaaaaaac1", internalDate: String(Date.parse("2026-10-07T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "Friend <friend@example.com>" }, { name: "To", value: "me@example.org" }, { name: "Subject", value: "Course C" }] }, text: "Course C (project) next_step: Book the exam hall" }]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  await pullSource(root, "mail", { model });
  return root;
}
const step = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/course-c")!.fm.facts!.next_step as FactRecord;

test("a newer mail over an assistant's older word is logged as the update the write made", async () => {
  const root = await pulled("2026-10-02");
  const rows = runAuto(root, new Date());
  expect(step(root).value).toBe("Book the exam hall");
  expect(disputes(root)).toEqual([]);
  expect(rows.map((r) => r.picked)).toEqual(["saved it"]);
});

test("a different value on the same day is held as a conflict, and logged as one", async () => {
  const root = await pulled("2026-10-07");
  const rows = runAuto(root, new Date());
  expect(step(root).value).toBe("Write the exam");
  expect(disputes(root)).toHaveLength(1);
  expect(rows.map((r) => r.picked)).toEqual(["held it as a conflict"]);
});
