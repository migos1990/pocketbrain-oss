// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain agent tier <agent> core|trial` (docs/gardener.md, "Letting the Gardener file"): the
// owner's one switch for an agent's tier. It changes the agent's tier and, going to core, drops its
// daily proposal cap; nothing else in policy.yaml moves, and the change is one owner commit with a Why.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const cli = (root: string, ...a: string[]) => {
  const r = Bun.spawnSync(["bun", CLI, ...a], { env: { ...process.env, PB_BRAIN: root } });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const git = (root: string, ...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: root }).stdout.toString().trim();
const policy = (root: string) => readFileSync(join(root, "rules", "policy.yaml"), "utf8");
const agents = (root: string) => (YAML.parse(policy(root)) as { agents: Record<string, Record<string, unknown>> }).agents;

test("agent tier gardener core changes only the gardener's tier and cap, in place, as one owner commit with a Why", () => {
  const root = makeBrain();
  const before = policy(root), was = agents(root);
  expect(was.gardener).toMatchObject({ tier: "trial", max_proposals_per_day: 13 });
  const r = cli(root, "agent", "tier", "gardener", "core");
  expect(r.code).toBe(0);
  const now = agents(root);
  const { max_proposals_per_day: _, ...rest } = was.gardener;
  expect(now.gardener).toEqual({ ...rest, tier: "core" });
  for (const a of Object.keys(was).filter((a) => a !== "gardener")) expect(now[a]).toEqual(was[a]);
  expect({ ...YAML.parse(policy(root)), agents: 0 }).toEqual({ ...YAML.parse(before), agents: 0 });
  // One line changed; the comments and the other agents' lines stay as written.
  const a = before.split("\n"), b = policy(root).split("\n");
  expect(b.length).toBe(a.length);
  expect(a.filter((l, i) => l !== b[i]).length).toBe(1);
  expect(git(root, "show", "--name-only", "--format=", "HEAD")).toBe("rules/policy.yaml");
  const msg = git(root, "log", "-1", "--format=%an%n%B");
  expect(msg).toMatch(/^Robin\nowner: gardener tier core/);
  expect(msg).toMatch(/\nWhy: .+/);
  // A terminal widened what an agent may write: the owner hears of it, with the way back.
  const alerts = existsSync(join(root, "log", "alerts.jsonl")) ? readFileSync(join(root, "log", "alerts.jsonl"), "utf8") : "";
  expect(alerts).toContain("agent tier gardener trial");
  // Again: nothing to change, no commit.
  const head = git(root, "rev-parse", "HEAD");
  expect(cli(root, "agent", "tier", "gardener", "core").out).toContain("already");
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

test("--dry-run prints the change and writes nothing", () => {
  const root = makeBrain();
  const before = policy(root), head = git(root, "rev-parse", "HEAD");
  const r = cli(root, "agent", "tier", "gardener", "core", "--dry-run");
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/^- .*gardener: \{ tier: trial.*max_proposals_per_day: 13/m);
  expect(r.out).toMatch(/^\+ .*gardener: \{ tier: core/m);
  expect(r.out).not.toMatch(/^\+ .*max_proposals_per_day/m);
  expect(policy(root)).toBe(before);
  expect(git(root, "rev-parse", "HEAD")).toBe(head);
});

test("back to trial is the same switch, and leaves the cap off", () => {
  const root = makeBrain();
  expect(cli(root, "agent", "tier", "gardener", "core").code).toBe(0);
  expect(cli(root, "agent", "tier", "gardener", "trial").code).toBe(0);
  expect(agents(root).gardener.tier).toBe("trial");
  expect(agents(root).gardener.max_proposals_per_day).toBeUndefined();
});

test("refuses an agent or tier that isn't one, and an edit that would move anything else", () => {
  const root = makeBrain();
  const before = policy(root);
  expect(cli(root, "agent", "tier", "nobody", "core").code).toBe(2);
  expect(cli(root, "agent", "tier", "gardener", "owner").code).toBe(2);
  expect(cli(root, "agent", "tier", "gardener").code).toBe(2);
  expect(policy(root)).toBe(before);
  // A policy where the in-place edit can't be checked to touch only the tier and cap: refused, not reprinted.
  writeFileSync(join(root, "rules", "policy.yaml"), before.replace(/^  gardener: \{ tier: trial,/m, "  gardener: { tier: trial, note: \"tier: trial\","));
  git(root, "add", "-A"); git(root, "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "by hand");
  const odd = policy(root);
  const r = cli(root, "agent", "tier", "gardener", "core");
  if (r.code === 0) {
    const g = agents(root).gardener;
    expect(g.tier).toBe("core");
    expect(g.note).toBe("tier: trial");
  } else {
    expect(r.code).toBe(1);
    expect(policy(root)).toBe(odd);
  }
});
