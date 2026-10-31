// SPDX-License-Identifier: AGPL-3.0-only
// Outside review v3 follow-up, 2026-10-26: a capture that files itself keeps an inbox record only
// to carry its Undo. That record is never an ask (the digest listed it as a proposal to accept
// while it waited for the hub's tick), and once filed it says the write filed it, not that anyone
// approved it.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { makeModel, type ModelRequest } from "../src/model";
import { pullSource } from "../src/pull";
import { runAuto } from "../src/filing";
import { digest } from "../src/digest";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
const textOf = (p: string) => p.match(/<<<\n([\s\S]*?)\n>>>/)?.[1] ?? "";
const model = makeModel({ provider: "fake", model: "fake-1" }, { fake: (r: ModelRequest) => JSON.stringify({ facts: [...textOf(r.prompt).matchAll(/^(.+?) \((\w+)\) (\w+): (.+)$/gm)].map(([line, entity, type, attribute, value]) => ({ entity, type, attribute, value, quote: line })) }) });

test("a capture filing itself is never an ask in the digest, and its record says nobody approved it", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  writeFileSync(join(root, "rules", "sources.yaml"), YAML.stringify({ sources: { mail: { kind: "gmail", fixture: "m.json" } } }));
  writeFileSync(join(root, "m.json"), JSON.stringify([{ id: "aaaaaaaaaaaaaac2", threadId: "aaaaaaaaaaaaaac2", internalDate: String(Date.parse("2026-10-07T10:00:00Z")), labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "Friend <friend@example.com>" }, { name: "To", value: "me@example.org" }, { name: "Subject", value: "Course D" }] }, text: "Course D (project) next_step: Book the exam hall" }]));
  sh(root, "git", "add", "-A"); sh(root, "git", "commit", "-qm", "owner: setup");
  await pullSource(root, "mail", { model });
  const waiting = readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"));
  expect(waiting.length).toBe(1);
  expect(digest(root).text).not.toContain(waiting[0]);
  expect(runAuto(root, new Date()).map((r) => r.picked)).toEqual(["saved it"]);
  const rec = YAML.parse(readFileSync(join(root, "inbox", "decided", waiting[0]), "utf8"));
  expect(rec.by).toBe("auto-decide");
  expect(rec.filed).toBe("by the hub's write path with Undo; nobody approved it");
});
