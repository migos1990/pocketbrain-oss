// SPDX-License-Identifier: AGPL-3.0-only
// The daily self-check (src/probe.ts selfChecks, docs/real-use-bar.md): what would otherwise need
// a hand fix before the owner notices. Each check appears only once the thing it watches exists,
// alerts once on ok -> failing through the probe's record(), and the digest carries one line.
import { test, expect, afterEach } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { selfChecks, record, selfCheckLine, recordStart } from "../src/probe";
import { digest } from "../src/digest";
import { measures } from "../src/measure";
import { useFreeDisk } from "../src/textline/items";

const NOW = new Date("2026-10-08T12:00:00Z");
const line = (root: string, file: string, e: Record<string, unknown>) => { mkdirSync(join(root, file, ".."), { recursive: true }); appendFileSync(join(root, file), JSON.stringify(e) + "\n"); };
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const byName = (root: string) => Object.fromEntries(selfChecks(root, NOW).map((c) => [c.name, c]));
afterEach(() => useFreeDisk(() => 50_000));
const ran = (root: string) => line(root, "log/starts.jsonl", { at: ago(30) });

test("a brand-new brain gets none; once the hub ran start, disk, logs and restarts appear and pass", () => {
  useFreeDisk(() => 50_000);
  const root = makeBrain();
  expect(selfChecks(root, NOW)).toEqual([]);
  ran(root);
  const c = byName(root);
  expect(Object.keys(c).sort()).toEqual(["disk", "logs", "restarts"]);
  expect(Object.values(c).every((x) => x.ok)).toBe(true);
});

test("a gardener's missed night is checked once, by jobChecks' gardener_runs, not again by the self-check", () => {
  const root = makeBrain();
  line(root, "log/gardener.jsonl", { at: ago(40), agent: "gardener", op: "upkeep_run", run: "r1" });
  expect(byName(root).gardener).toBeUndefined();
});

test("an assistant that used the brain and went quiet for 3 days fails (its connection may need a reconnect); one that never used it isn't flagged", () => {
  const root = makeBrain();
  line(root, "log/reads.jsonl", { at: ago(24 * 6), agent: "planner", op: "context_pack", ids: ["*"] });
  line(root, "log/reads.jsonl", { at: ago(2), agent: "helper", op: "context_pack", ids: ["*"] });
  const c = byName(root).connections;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("planner");
  expect(c.detail).not.toContain("helper");
  expect(c.detail).not.toContain("steward"); // never read: not a broken connection
  line(root, "log/reads.jsonl", { at: ago(1), agent: "planner", op: "search", ids: [] });
  expect(byName(root).connections.ok).toBe(true);
});

test("a paused assistant or the gardener going quiet is not a broken connection", () => {
  const root = makeBrain();
  const p = join(root, "rules", "policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace("planner: { tier: core,", "planner: { tier: core, status: paused,"));
  line(root, "log/reads.jsonl", { at: ago(24 * 6), agent: "planner", op: "context_pack", ids: ["*"] });
  line(root, "log/reads.jsonl", { at: ago(24 * 6), agent: "gardener", op: "context_pack", ids: ["*"] });
  expect(byName(root).connections?.ok ?? true).toBe(true);
});

test("low disk and a log folder over its size fail", () => {
  const root = makeBrain();
  ran(root);
  useFreeDisk(() => 300);
  expect(byName(root).disk).toMatchObject({ ok: false });
  expect(byName(root).disk.detail).toContain("300 MB free");
  process.env.PB_LOG_MAX_MB = "0.001";
  try {
    line(root, "log/reads.jsonl", { at: ago(1), agent: "helper", op: "search", ids: ["x".repeat(2000)] });
    expect(byName(root).logs).toMatchObject({ ok: false });
    expect(byName(root).logs.detail).toContain("reads.jsonl");
  } finally { delete process.env.PB_LOG_MAX_MB; }
});

test("five hub starts in six hours is a restart loop", () => {
  const root = makeBrain();
  for (const h of [30, 20]) line(root, "log/starts.jsonl", { at: ago(h) });
  expect(byName(root).restarts.ok).toBe(true);
  for (const h of [5, 4, 3, 2]) line(root, "log/starts.jsonl", { at: ago(h) });
  recordStart(root, NOW);
  expect(byName(root).restarts).toMatchObject({ ok: false });
  expect(byName(root).restarts.detail).toContain("5 times");
});

test("main ahead of the release branch for over 7 days fails, from the auto-update's deploy.json", () => {
  const root = makeBrain();
  const cfg = join(root, "cfg");
  process.env.PB_CONFIG_DIR = cfg;
  try {
    mkdirSync(cfg, { recursive: true });
    const deploy = (unreleased_since?: string | null) => writeFileSync(join(cfg, "deploy.json"), JSON.stringify({ status: "current", detail: "running v0.1.0", checked_at: ago(0.5), ...(unreleased_since !== undefined ? { unreleased_since } : {}) }));
    deploy(ago(24 * 2));
    expect(byName(root).release.ok).toBe(true);
    deploy(ago(24 * 9));
    expect(byName(root).release).toMatchObject({ ok: false });
    deploy(null);
    expect(byName(root).release.ok).toBe(true); // nothing unreleased
    deploy();
    expect(byName(root).release).toBeUndefined(); // an older deploy.json without the field: no check
  } finally { delete process.env.PB_CONFIG_DIR; }
});

test("a failing self-check alerts once through the probe's record, and the digest line counts them", () => {
  const root = makeBrain();
  ran(root);
  useFreeDisk(() => 300);
  record(root, selfChecks(root, NOW), NOW);
  record(root, selfChecks(root, NOW), NOW);
  const alerts = readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(alerts.filter((a) => a.check === "probe_disk").length).toBe(1);
  expect(selfCheckLine(root)).toMatch(/^- Self-check: 1 of 3 failing \(disk\)/);
  expect(digest(root, "2000-01-01").text).toContain("- Self-check: 1 of 3 failing (disk)");
  useFreeDisk(() => 50_000);
  record(root, selfChecks(root, NOW), NOW);
  expect(selfCheckLine(root)).toMatch(/^- Self-check: all 3 ok/);
  expect(existsSync(join(root, "log", "probe.json"))).toBe(true);
});

test("early warnings alert as probe_warn_* and don't break the real-use streak; a disk failure does", () => {
  const root = makeBrain();
  ran(root);
  line(root, "log/reads.jsonl", { at: ago(24 * 6), agent: "planner", op: "context_pack", ids: ["*"] });
  useFreeDisk(() => 300);
  record(root, selfChecks(root, NOW), NOW);
  const checks = readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).check).sort();
  expect(checks).toEqual(["probe_disk", "probe_warn_connections"]);
  const day = alertsDay(root);
  expect(measures(root, [day])[0].hubDownWhat).toEqual(["probe_disk"]);
});
const alertsDay = (root: string) => JSON.parse(readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n")[0]).at.slice(0, 10);
