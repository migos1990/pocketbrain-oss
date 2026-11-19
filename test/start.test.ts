// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dueJobs, hubPlists } from "../src/start";

// Owner wall-clock in October (EDT, UTC-4): dueJobs counts the owner's day (src/clock.ts).
const toronto = (d: number, h: number, m: number) => new Date(Date.UTC(2026, 9, d, h + 4, m));

test("the nightly pass and the digest run once a day, even if the hub was asleep at their hour", () => {
  const root = makeBrain();
  expect(dueJobs(root, toronto(8, 2, 59))).toEqual([]);
  expect(dueJobs(root, toronto(8, 9, 30))).toEqual(["night", "digest"]); // woke up late: both
  expect(dueJobs(root, toronto(8, 23, 0))).toEqual([]);
  expect(dueJobs(root, toronto(9, 3, 1))).toEqual(["night"]);
  expect(dueJobs(root, toronto(9, 7, 0))).toEqual(["digest"]);
});

test("launchd files keep start and the tunnel running", () => {
  const [start, tunnel] = hubPlists("/b", { bun: "/opt/homebrew/bin/bun", app: "/Users/me/pocketbrain", home: "/Users/me", tunnel: "brain" });
  expect(start.text).toContain("<string>start</string>");
  expect(start.text).toContain("<string>/b</string>");
  expect(start.text).toContain("<key>KeepAlive</key><true/>");
  expect(tunnel.text).toContain("<string>run</string>\n    <string>brain</string>");
  // The tunnel runs with the ingress that forwards only the agent API, never cloudflared's default.
  expect(tunnel.text).toContain("<string>--config</string>\n    <string>/Users/me/.cloudflared/config.yml</string>");
  const [, own] = hubPlists("/b", { bun: "b", app: "a", home: "/Users/me", tunnel: "brain", tunnelConfig: "/etc/pb.yml" });
  expect(own.text).toContain("<string>/etc/pb.yml</string>");
});

test("start serves the agents and the dashboard from one process", async () => {
  const root = makeBrain();
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "start", "--brain", root, "--port", "18917", "--dashboard-port", "18918"], { stdout: "pipe", stderr: "pipe", env: { ...process.env } }); // the run's own settings: without them this hub began a real nightly slice check that outlived it by 25 minutes (G1020)
  try {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) { await Bun.sleep(100); ok = await fetch("http://127.0.0.1:18917/health").then((r) => r.ok, () => false); }
    expect(ok).toBe(true);
    expect((await fetch("http://127.0.0.1:18918/").catch(() => undefined))?.status).toBe(401); // dashboard up, not signed in
  } finally { p.kill(); }
  const out = await new Response(p.stdout).text();
  expect(out).toContain("text channel: off");
  expect(out).toContain("relay: off");
});

// Bug hunt #147: pullsDue ran outside the timer's try, so a rules file
// mid-edit rejected the serial() promise unhandled (the process could exit) and nothing said why.
test("a malformed sources.yaml is logged and shows as a failing job, never thrown", async () => {
  const { writeFileSync } = await import("node:fs");
  const { pullTick } = await import("../src/start");
  const { jobChecks } = await import("../src/probe");
  const root = makeBrain();
  writeFileSync(join(root, "rules", "sources.yaml"), "sources:\n  gmail: [unclosed\n");
  const lines: string[] = [];
  await pullTick(root, (s) => lines.push(s));
  expect(lines.some((l) => /pull failed/.test(l))).toBe(true);
  const failing = jobChecks(root).filter((c) => !c.ok).map((c) => c.name);
  expect(failing).toContain("pull");
  writeFileSync(join(root, "rules", "sources.yaml"), "sources: {}\n");
  await pullTick(root, () => {});
  expect(jobChecks(root).filter((c) => !c.ok).map((c) => c.name)).toEqual([]);
});

// G1011: dueJobs marks a job as run for the day before it runs. A hub killed during the night pass
// (a crash, a power cut, the watchdog's restart) came back with the night marked done, so that
// night's upkeep, page text and backfill never ran, and nothing said so for a day and a half.
test("G1011 a night pass cut off by a restart runs again when the hub comes back, once", async () => {
  const { resumeCutJobs, beginJob, endJob, lastRuns } = await import("../src/start");
  const { jobChecks } = await import("../src/probe");
  const root = makeBrain();
  expect(dueJobs(root, toronto(8, 3, 5))).toEqual(["night"]);
  beginJob(root, "night");
  // The hub dies here: no end was recorded. The next start puts the job back.
  expect(resumeCutJobs(root, toronto(8, 3, 20))).toEqual(["night"]);
  expect(dueJobs(root, toronto(8, 3, 21))).toEqual(["night"]);
  beginJob(root, "night");
  // Cut off again: it is not tried a third time that day (a pass that takes the hub down each
  // time must not loop), and the probe says so.
  expect(resumeCutJobs(root, toronto(8, 3, 40))).toEqual([]);
  expect(dueJobs(root, toronto(8, 3, 41))).toEqual([]);
  expect(lastRuns(root).night_error).toContain("stopped twice");
  expect(jobChecks(root, toronto(8, 3, 42)).filter((c) => !c.ok).map((c) => c.name)).toContain("night");
  // The next day is a new day.
  expect(dueJobs(root, toronto(9, 3, 1))).toEqual(["night"]);
  beginJob(root, "night"); endJob(root, "night");
  expect(resumeCutJobs(root, toronto(9, 3, 30))).toEqual([]);
  expect(dueJobs(root, toronto(9, 3, 31))).toEqual([]);
});

test("G1011 a job that ended, a job from another day and a mark left by older code are never run again", async () => {
  const { resumeCutJobs, beginJob, endJob } = await import("../src/start");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const root = makeBrain();
  expect(dueJobs(root, toronto(8, 9, 30))).toEqual(["night", "digest"]);
  beginJob(root, "night"); endJob(root, "night"); beginJob(root, "digest"); endJob(root, "digest");
  expect(resumeCutJobs(root, toronto(8, 10, 0))).toEqual([]);
  // Yesterday's cut-off pass is not today's: today's own run covers it.
  const other = makeBrain();
  expect(dueJobs(other, toronto(8, 23, 30))).toEqual(["night", "digest"]);
  beginJob(other, "night");
  expect(resumeCutJobs(other, toronto(9, 1, 0))).toEqual([]);
  // A state file from before this change has the day and no begin mark: the first start on new
  // code must not run the day's night pass and digest a second time.
  const old = makeBrain();
  mkdirSync(join(old, "log"), { recursive: true });
  writeFileSync(join(old, "log", "start-state.json"), JSON.stringify({ night: "2026-10-08", digest: "2026-10-08" }));
  expect(resumeCutJobs(old, toronto(8, 10, 0))).toEqual([]);
  expect(dueJobs(old, toronto(8, 10, 1))).toEqual([]);
});

// G1018 (code review of G1011): every due job is marked at once, before the first runs. A digest
// waiting behind a night pass that was cut off had not begun: it is simply due again, as often as
// it takes, and is never called a job that stopped mid-run.
test("G1018 a job still waiting behind a cut-off night pass is due again and never counted as cut off", async () => {
  const { resumeCutJobs, beginJob, endJob, lastRuns } = await import("../src/start");
  const root = makeBrain();
  expect(dueJobs(root, toronto(8, 9, 30))).toEqual(["night", "digest"]);
  beginJob(root, "night"); // killed here: the digest never started
  expect(resumeCutJobs(root, toronto(8, 9, 40))).toEqual(["night", "digest"]);
  expect(dueJobs(root, toronto(8, 9, 41))).toEqual(["night", "digest"]);
  beginJob(root, "night"); // killed again
  expect(resumeCutJobs(root, toronto(8, 9, 50))).toEqual(["digest"]);
  expect(lastRuns(root).digest_error).toBeUndefined();
  expect(dueJobs(root, toronto(8, 9, 51))).toEqual(["digest"]);
  beginJob(root, "digest"); endJob(root, "digest");
  expect(resumeCutJobs(root, toronto(8, 10, 0))).toEqual([]);
});
