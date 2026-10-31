// SPDX-License-Identifier: AGPL-3.0-only
// Source backfill (backlog 376): a fact with no live source (an agent's word, a vague pointer)
// gets the exact ref of a mail that still says it, found by searching the mailbox for the value.
// The value never changes, only the ref is added; the mail must name the note's subject too, and a
// mail more sensitive than the note is never attached. Nothing is stored from the mail.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { hasLiveSource } from "../src/health";
import { sourceBackfill } from "../src/backfill";

const SOURCES = "consent: 2026-10-01\nsources:\n  mail:\n    kind: gmail\n    account: personal\n    where: [INBOX]\n    forwarded:\n      - { to: \"@school.example\", account: school, min_sensitivity: private }\n";
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();

// Jane's role, told by an agent: no live source yet.
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), SOURCES);
  const file = join(root, "people", "jane-roy.md");
  writeFileSync(file, readFileSync(file, "utf8").replace('role: { value: Course coordinator, as_of: 2026-09-01, sources: ["gmail:f000000000000001"], verification: verified-by-source', 'role: { value: Course coordinator, as_of: 2026-09-01, sources: ["agent:planner"], verification: unverified'));
  git(root, "add", "-A"); git(root, "commit", "-qm", "agent-told role");
  return root;
}
const role = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.role as FactRecord;
const mail = (id: string, text: string, headers: Record<string, string> = {}) => ({
  id, text, internalDate: String(Date.parse("2026-09-20T12:00:00Z")), labelIds: ["INBOX"],
  payload: { headers: [{ name: "Subject", value: "Next term" }, ...Object.entries(headers).map(([name, value]) => ({ name, value }))] },
});

test("a mail that names the subject and states the value becomes the fact's source; the value stays", async () => {
  const root = brain();
  expect(hasLiveSource(role(root))).toBe(false);
  const asked: string[] = [];
  const r = await sourceBackfill(root, "mail", { search: async (_cfg, q) => { asked.push(q); return [mail("m1", "Hi all, Jane Roy stays on as course coordinator next term.")]; } });
  expect(r.attached).toEqual(["people/jane-roy#role"]);
  const f = role(root);
  expect(f.value).toBe("Course coordinator");
  expect(f.sources).toContain("gmail:personal/m1");
  expect(hasLiveSource(f)).toBe(true);
  expect(asked.some((q) => q.includes("Course coordinator"))).toBe(true);
  expect(git(root, "log", "-1", "--format=%s")).toContain("confirms people/jane-roy#role");
  // Nothing from the mail is kept: no capture, no copy of its text anywhere in the brain.
  expect(git(root, "grep", "-c", "stays on as", "HEAD").trim()).toBe("");
});

test("a mail that states the value about someone else is not attached", async () => {
  const root = brain();
  const r = await sourceBackfill(root, "mail", { search: async () => [mail("m2", "Marc Tremblay is the course coordinator now.")] });
  expect(r.attached).toEqual([]);
  expect(hasLiveSource(role(root))).toBe(false);
});

test("a mail more sensitive than the note (a private forwarded mailbox) is never attached", async () => {
  const root = brain();
  const r = await sourceBackfill(root, "mail", { search: async () => [mail("m3", "Jane Roy, course coordinator.", { "Delivered-To": "robin@school.example" })] });
  expect(r.attached).toEqual([]);
  expect(hasLiveSource(role(root))).toBe(false);
});

test("only facts with no live source are searched, at most max per run, and a tried fact waits", async () => {
  const root = brain();
  const asked: string[] = [];
  const search = async (_c: unknown, q: string) => { asked.push(q); return []; };
  await sourceBackfill(root, "mail", { search, max: 1 });
  expect(asked.length).toBe(1);
  // Jane's phone has an exact gmail ref already: never searched.
  expect(asked.some((q) => q.includes("5145550100"))).toBe(false);
  const again = await sourceBackfill(root, "mail", { search, max: 50 });
  expect(asked.some((q, i) => i > 0 && q === asked[0])).toBe(false);
  expect(again.tried).toBeGreaterThanOrEqual(0);
});

test("a dry run says what it would attach and writes nothing", async () => {
  const root = brain();
  const head = git(root, "rev-parse", "HEAD");
  const r = await sourceBackfill(root, "mail", { dryRun: true, search: async () => [mail("m1", "Jane Roy stays on as course coordinator.")] });
  expect(r.attached).toEqual(["people/jane-roy#role"]);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
  expect(hasLiveSource(role(root))).toBe(false);
  expect(existsSync(join(root, "log", "sources", "mail-backfill.json"))).toBe(false);
});

test("a live mailbox needs the owner's consent first", async () => {
  const root = brain();
  writeFileSync(join(root, "rules", "sources.yaml"), SOURCES.replace("consent: 2026-10-01\n", ""));
  const r = await sourceBackfill(root, "mail", {});
  expect(r.refused).toContain("consent");
  expect(YAML.parse(readFileSync(join(root, "rules", "sources.yaml"), "utf8")).consent).toBeUndefined();
});

test("a private fact or a fact on a private note is never sent to the mailbox as a search", async () => {
  const root = brain();
  const file = join(root, "people", "jane-roy.md");
  writeFileSync(file, readFileSync(file, "utf8").replace("sensitivity: personal", "sensitivity: private"));
  git(root, "commit", "-qam", "private note");
  const asked: string[] = [];
  await sourceBackfill(root, "mail", { search: async (_c, q) => { asked.push(q); return []; } });
  expect(asked.some((q) => q.includes("Course coordinator"))).toBe(false);
});
