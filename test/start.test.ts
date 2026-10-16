// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dueJobs, hubPlists } from "../src/start";

test("the nightly pass and the digest run once a day, even if the hub was asleep at their hour", () => {
  const root = makeBrain();
  expect(dueJobs(root, new Date(2026, 9, 8, 2, 59))).toEqual([]);
  expect(dueJobs(root, new Date(2026, 9, 8, 9, 30))).toEqual(["night", "digest"]); // woke up late: both
  expect(dueJobs(root, new Date(2026, 9, 8, 23, 0))).toEqual([]);
  expect(dueJobs(root, new Date(2026, 9, 9, 3, 1))).toEqual(["night"]);
  expect(dueJobs(root, new Date(2026, 9, 9, 7, 0))).toEqual(["digest"]);
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
  const p = Bun.spawn(["bun", join(import.meta.dir, "../src/cli.ts"), "start", "--brain", root, "--port", "18917", "--dashboard-port", "18918"], { stdout: "pipe", stderr: "pipe" });
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
