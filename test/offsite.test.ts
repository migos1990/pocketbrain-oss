// SPDX-License-Identifier: AGPL-3.0-only
// Backups off the cloud-synced folder (finals plan row 413): the hub writes backups to a local
// folder only, and a separate launchd job copies new ones to the owner's synced folder (Drive).
// A Drive that hangs can then only stall that copy, cut at its time limit, never the hub
// (2026-10-20: a sync open() on the Drive symlink froze the hub for two days).
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { offsiteCopy, offsiteOn, offsiteOff, OFFSITE_LABEL } from "../src/offsite";
import { jobChecks } from "../src/probe";

const dirs = () => { const d = mkdtempSync(join(tmpdir(), "pb-offsite-")); const from = join(d, "local"), to = join(d, "drive"); mkdirSync(from); mkdirSync(to); return { from, to }; };

test("the copy sends only new backups, never partial ones, and records success for the probe", async () => {
  const root = makeBrain();
  const { from, to } = dirs();
  writeFileSync(join(from, "brain-2026-10-23.tar.age"), "one");
  writeFileSync(join(from, "brain-2026-10-24.tar.age"), "two");
  writeFileSync(join(from, ".brain-2026-10-25.tar.age.partial"), "half");
  writeFileSync(join(to, "brain-2026-10-23.tar.age"), "one");
  const r = await offsiteCopy(root, to, { from });
  expect(r.copied).toEqual(["brain-2026-10-24.tar.age"]);
  expect(readFileSync(join(to, "brain-2026-10-24.tar.age"), "utf8")).toBe("two");
  expect(existsSync(join(to, ".brain-2026-10-25.tar.age.partial"))).toBe(false);
  expect(jobChecks(root).find((c) => c.name === "offsite")?.ok).toBe(true);
  expect((await offsiteCopy(root, to, { from })).copied).toEqual([]);
});

test("a copy that hangs is cut at its time limit, recorded as failed, and the probe says so", async () => {
  const root = makeBrain();
  const { from, to } = dirs();
  writeFileSync(join(from, "brain-2026-10-24.tar.age"), "two");
  const hang = () => new Promise<{ code: number; out: string }>(() => {});
  const t0 = Date.now();
  const r = await offsiteCopy(root, to, { from, timeoutMs: 100, run: hang });
  expect(Date.now() - t0).toBeLessThan(3000);
  expect(r.error).toContain("no answer");
  const c = jobChecks(root).find((x) => x.name === "offsite")!;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("offsite");
});

test("offsite on installs its own launchd job; off removes it; neither touches the hub's jobs", () => {
  const root = makeBrain();
  const home = mkdtempSync(join(tmpdir(), "pb-offsite-home-"));
  const runs: string[][] = [];
  const run = (cmd: string[]) => { runs.push(cmd); return { code: 0, out: "" }; };
  const to = join(home, "Drive", "pocketbrain-backups");
  offsiteOn(root, to, { home, uid: 501, bun: "/opt/homebrew/bin/bun", app: "/app", run });
  const plist = join(home, "Library", "LaunchAgents", `${OFFSITE_LABEL}.plist`);
  const text = readFileSync(plist, "utf8");
  expect(text).toContain("<string>offsite</string>");
  expect(text).toContain(`<string>${to}</string>`);
  expect(text).toContain("StartInterval");
  expect(runs.at(-1)).toEqual(["launchctl", "bootstrap", "gui/501", plist]);
  offsiteOff(root, { home, uid: 501, run });
  expect(existsSync(plist)).toBe(false);
  expect(runs.at(-1)).toEqual(["launchctl", "bootout", `gui/501/${OFFSITE_LABEL}`]);
  expect(runs.flat().some((a) => a.includes("com.pocketbrain.start"))).toBe(false);
  expect(jobChecks(root).find((c) => c.name === "offsite")).toBeUndefined();
});
