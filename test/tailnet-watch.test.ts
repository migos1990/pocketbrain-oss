// SPDX-License-Identifier: AGPL-3.0-only
// A tailnet that is up and silent (2026-11-07/08, about 19 hours): `tailscale status` said the
// phone was online and Health was empty, while the phone's own Tailscale had a stuck receive path
// and the app showed "Still waiting for your hub". The watchdog pings the owner's listed phone
// over the tailnet; two failed runs in a row are one problem line, report-only (the menu bar and
// log/watchdog.json, no Mac notification), naming the kind of device only (G741).
import { test, expect } from "bun:test";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { watchdogTick, watchdogState } from "../src/watchdog";

const PHONE = "100.101.102.103", LAPTOP = "100.101.102.104";
const ok: typeof fetch = (async () => new Response('{"ok":true}')) as unknown as typeof fetch;
const at = (m: number) => new Date(Date.parse("2026-11-08T01:00:00Z") + m * 60_000);
const LINE = "tailnet: the hub can't reach your phone; toggle Tailscale on the phone first, restart it on the Mac only if that fails";

function brain(devices = [PHONE]) {
  const root = makeBrain();
  appendFileSync(join(root, "rules", "policy.yaml"), `\ndashboard_tailnet: true\ndashboard_tailnet_devices: [${devices.join(", ")}]\n`);
  return root;
}
const status = (peers: { ip: string; os: string; online: boolean; name?: string }[]) => JSON.stringify({
  BackendState: "Running",
  Self: { HostName: "mini", DNSName: "mini.tail0.ts.net.", OS: "macOS", UserID: 1, TailscaleIPs: ["100.64.0.1"] },
  Peer: Object.fromEntries(peers.map((p, i) => [`k${i}`, { HostName: p.name ?? `dev${i}`, DNSName: `dev${i}.tail0.ts.net.`, OS: p.os, UserID: 1, TailscaleIPs: [p.ip], Online: p.online }])),
});
function tailscale(o: { peers: Parameters<typeof status>[0]; ping: (ip: string) => boolean }) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "status") return { code: 0, out: status(o.peers) };
    if (args[0] === "ping") return o.ping(args.at(-1)!) ? { code: 0, out: "pong" } : { code: 1, out: "no reply" };
    return { code: 1, out: "" };
  };
  return { run, calls };
}
const tick = (root: string, ts: ReturnType<typeof tailscale>, m: number, said: string[] = []) =>
  watchdogTick(root, { url: "http://127.0.0.1:8787", run: () => ({ code: 0, out: "" }), uid: 501, fetch: ok, platform: "darwin", now: at(m), notify: (t) => said.push(t), tailscale: ts.run });
const tailnetProblems = (root: string) => (watchdogState(root).problems ?? []).filter((p) => p.name === "tailnet");

test("an online phone the hub can't ping twice in a row is one problem line, by kind only, never a notification (G741)", async () => {
  const root = brain(), said: string[] = [];
  const ts = tailscale({ peers: [{ ip: PHONE, os: "iOS", online: true, name: "louis-iphone" }], ping: () => false });
  await tick(root, ts, 0, said);
  expect(tailnetProblems(root)).toEqual([]); // one miss is a blip
  await tick(root, ts, 5, said);
  expect(tailnetProblems(root)).toEqual([{ name: "tailnet", detail: LINE }]);
  expect(ts.calls).toContainEqual(["ping", "--until-direct=false", "-c", "1", "--timeout", "5s", PHONE]);
  expect(said.filter((t) => t.includes("tailnet"))).toEqual([]); // report-only: the menu bar, no notification
  const file = readFileSync(join(root, "log", "watchdog.json"), "utf8");
  expect(file).not.toContain(PHONE);
  expect(file).not.toContain("louis-iphone");
});

test("a ping that answers clears it; a phone that is offline or not listed is never pinged (G741)", async () => {
  const root = brain();
  let up = false;
  const ts = tailscale({ peers: [{ ip: PHONE, os: "iOS", online: true }, { ip: LAPTOP, os: "macOS", online: true }], ping: () => up });
  await tick(root, ts, 0); await tick(root, ts, 5);
  expect(tailnetProblems(root)).toHaveLength(1);
  up = true;
  await tick(root, ts, 10);
  expect(tailnetProblems(root)).toEqual([]);
  expect(ts.calls.filter((c) => c[0] === "ping" && c.at(-1) === LAPTOP)).toEqual([]); // not listed

  const idle = brain(), off = tailscale({ peers: [{ ip: PHONE, os: "iOS", online: false }], ping: () => false });
  await tick(idle, off, 0); await tick(idle, off, 5);
  expect(tailnetProblems(idle)).toEqual([]);
  expect(off.calls.filter((c) => c[0] === "ping")).toEqual([]);
});

test("with no tailnet dashboard set up the watchdog doesn't call tailscale at all (G741)", async () => {
  const root = makeBrain(), ts = tailscale({ peers: [], ping: () => false });
  await tick(root, ts, 0); await tick(root, ts, 5);
  expect(ts.calls).toEqual([]);
  expect(tailnetProblems(root)).toEqual([]);
});

// fb492813 live, 2026-11-08 15:12Z/15:17Z: the line rose while the phone answered. `tailscale ping`
// waits for a direct path by default (--until-direct=true), so with -c 1 a pong over a DERP relay,
// which an idle iPhone often answers with first, exits 1 "direct connection not established".
// A pong by any path is the phone answering (G743).
const real = (args: string[]) => args.includes("--until-direct=false")
  ? { code: 0, out: `pong from phone (${PHONE}) via DERP(tor) in 41ms` }
  : { code: 1, out: `pong from phone (${PHONE}) via DERP(tor) in 41ms\ndirect connection not established` };

test("a phone that answers over a relay is reachable: no miss, no line (G743)", async () => {
  const root = brain();
  const calls: string[][] = [];
  const run = (args: string[]) => { calls.push(args); return args[0] === "status" ? { code: 0, out: status([{ ip: PHONE, os: "iOS", online: true }]) } : real(args); };
  await tick(root, { run, calls }, 0); await tick(root, { run, calls }, 5); await tick(root, { run, calls }, 10);
  expect(tailnetProblems(root)).toEqual([]);
  expect(watchdogState(root).tailnet_fails ?? 0).toBe(0);
  expect(calls.filter((c) => c[0] === "ping").every((c) => c.includes("--until-direct=false") && c.at(-1) === PHONE)).toBe(true);
});

test("the tailnet line never reaches a Mac notification, on any day, through the watchdog's own osascript either (G741, G743)", async () => {
  const root = brain(), ran: string[][] = [];
  const ts = tailscale({ peers: [{ ip: PHONE, os: "iOS", online: true }], ping: () => false });
  const go = (m: number) => watchdogTick(root, { url: "http://127.0.0.1:8787", run: (a) => { ran.push(a); return { code: 0, out: "" }; }, uid: 501, fetch: ok, platform: "darwin", now: at(m), tailscale: ts.run });
  for (const m of [0, 5, 60 * 24, 60 * 24 + 5, 60 * 48]) await go(m);
  expect(tailnetProblems(root)).toHaveLength(1);
  expect(ran.filter((a) => a[0] === "osascript" && a.join(" ").includes("tailnet"))).toEqual([]);
});
