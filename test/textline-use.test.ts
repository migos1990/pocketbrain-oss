// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain textline use` (backlog #232): the owner switches the alert transport with one
// command. It edits only the transport: block of rules/escalation.yaml, commits as the owner,
// and never echoes the handle (not on screen, not in the commit message). Temp brains removed after.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { ESCALATION_TEMPLATE, loadEscalation } from "../src/textline/policy";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });
const APP = join(import.meta.dir, "..");
const HANDLE = "+15145550177";
const run = (root: string, args: string[], stdin?: string) => {
  const p = Bun.spawnSync(["bun", "src/cli.ts", "textline", "use", ...args, "--brain", root], { cwd: APP, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin) });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString();
const brain = () => {
  const root = makeBrain(); roots.push(root);
  writeFileSync(join(root, "rules", "escalation.yaml"), ESCALATION_TEMPLATE);
  Bun.spawnSync(["git", "add", "rules/escalation.yaml"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-q", "-m", "owner: text channel escalation rules"], { cwd: root });
  return root;
};
const outside = (t: string) => t.slice(0, t.indexOf("\ntransport:"));

test("use imessage with the handle on stdin: only the transport block changes, committed as the owner, handle never echoed", () => {
  const root = brain();
  const before = readFileSync(join(root, "rules", "escalation.yaml"), "utf8");
  const r = run(root, ["imessage", "--to", "-"], `${HANDLE}\n`);
  expect(r.code).toBe(0);
  expect(r.out).not.toContain(HANDLE);
  expect(r.out).not.toContain("0177");
  const after = readFileSync(join(root, "rules", "escalation.yaml"), "utf8");
  expect(outside(after)).toBe(outside(before));
  const p = loadEscalation(root);
  expect(p.transport.use).toBe("imessage");
  expect(p.transport.imessage?.to).toBe(HANDLE);
  expect(git(root, "status", "--porcelain")).toBe("");
  const last = git(root, "log", "-1", "--format=%an%n%B");
  expect(last).not.toContain(HANDLE);
  expect(last).toContain("transport");
  expect(git(root, "log", "-1", "--name-only", "--format=")).toBe("rules/escalation.yaml\n");
});

test("use instinct switches back and keeps the iMessage handle for next time; a bad handle or transport changes nothing", () => {
  const root = brain();
  expect(run(root, ["imessage", "--to", HANDLE]).code).toBe(0);
  expect(run(root, ["instinct"]).code).toBe(0);
  const p = loadEscalation(root);
  expect(p.transport.use).toBe("instinct");
  expect(p.transport.imessage?.to).toBe(HANDLE);
  const head = git(root, "rev-parse", "HEAD");
  const bad = run(root, ["imessage", "--to", "call me maybe"]);
  expect(bad.code).not.toBe(0);
  expect(run(root, ["pigeon"]).code).not.toBe(0);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(loadEscalation(root).transport.use).toBe("instinct");
  // With a handle on file, `use imessage` alone switches back to it.
  expect(run(root, ["imessage"]).code).toBe(0);
  expect(loadEscalation(root).transport.imessage?.to).toBe(HANDLE);
});

test("imessage with no handle given and none on file is refused", () => {
  const root = brain();
  const head = git(root, "rev-parse", "HEAD");
  expect(run(root, ["imessage", "--to", "-"], "").code).not.toBe(0);
  expect(run(root, ["imessage"]).code).not.toBe(0);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

test("without rules/escalation.yaml it says to run textline init and writes nothing", () => {
  const root = makeBrain(); roots.push(root);
  const head = git(root, "rev-parse", "HEAD");
  const r = run(root, ["imessage", "--to", HANDLE]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("textline init");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
});
