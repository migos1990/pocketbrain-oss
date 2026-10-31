// SPDX-License-Identifier: AGPL-3.0-only
// A hub that is up but answers nothing (2026-10-20 to 10-22: the main thread blocked in a sync
// open() on a cloud-synced folder, so the in-process probe froze with it). The watchdog runs in its
// own launchd job, asks /health with a timeout, and after two missed checks restarts the hub and
// leaves an alert, so a hang lasts minutes, not days, and never passes for a clean day.
import { test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { watchdogTick } from "../src/watchdog";
import { hubPlists } from "../src/start";
import { noteStart, noteStop } from "../src/measure";
import { backupApart } from "../src/backup";

const cfg = process.env.PB_CONFIG_DIR;
afterEach(() => { if (cfg === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = cfg; });
const alerts = (root: string) => existsSync(join(root, "log", "alerts.jsonl")) ? readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const hang: typeof fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
const ok: typeof fetch = (async () => new Response('{"ok":true}')) as unknown as typeof fetch;

test("a hub that doesn't answer twice is restarted once, with a hub alert; one that answers resets the count", async () => {
  const root = makeBrain();
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-wd-cfg-"));
  const runs: string[][] = [];
  const run = (cmd: string[]) => { runs.push(cmd); return { code: 0, out: "" }; };
  const at = (m: number) => new Date(Date.parse("2026-10-20T01:00:00Z") + m * 60_000);
  const o = { url: "http://127.0.0.1:8787", run, uid: 501, timeoutMs: 50, platform: "darwin" as const, notify: () => {} };

  expect((await watchdogTick(root, { ...o, fetch: hang, now: at(0) })).action).toBe("waiting");
  expect(runs).toEqual([]);
  expect((await watchdogTick(root, { ...o, fetch: ok, now: at(5) })).action).toBe("ok");
  expect((await watchdogTick(root, { ...o, fetch: hang, now: at(10) })).action).toBe("waiting");
  expect((await watchdogTick(root, { ...o, fetch: hang, now: at(15) })).action).toBe("restarted");
  expect(runs).toEqual([["launchctl", "kickstart", "-k", "gui/501/com.pocketbrain.start"]]);
  expect(alerts(root)).toMatchObject([{ agent: "hub", check: "probe_hub_hung" }]);
  // Still down right after: no restart loop, it waits before trying again.
  expect((await watchdogTick(root, { ...o, fetch: hang, now: at(20) })).action).toBe("waiting");
  expect(runs.length).toBe(1);

  // The start that follows the watchdog's restart is not a hand restart.
  noteStart(root, { now: at(0), bootAt: new Date(0) });
  noteStop(root, "SIGTERM", at(15));
  expect(noteStart(root, { now: at(15.5), bootAt: new Date(0) })).toBeUndefined();
});

test("a 503 counts as down; off a Mac the watchdog alerts and restarts nothing", async () => {
  const root = makeBrain();
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-wd-cfg-"));
  const runs: string[][] = [];
  const down: typeof fetch = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
  const o = { url: "http://127.0.0.1:8787", run: (c: string[]) => { runs.push(c); return { code: 0, out: "" }; }, uid: 501, timeoutMs: 50, platform: "linux" as const, fetch: down };
  await watchdogTick(root, { ...o, now: new Date("2026-10-20T01:00:00Z") });
  expect((await watchdogTick(root, { ...o, now: new Date("2026-10-20T01:05:00Z") })).action).toBe("alerted");
  expect(runs).toEqual([]);
  expect(alerts(root)).toMatchObject([{ agent: "hub", check: "probe_hub_hung" }]);
});

test("the launchd files include the watchdog, every 5 minutes, separate from the hub", () => {
  const files = hubPlists("/b", { bun: "/opt/homebrew/bin/bun", app: "/Users/me/pocketbrain", home: "/Users/me" });
  const wd = files.find((f) => f.file === "com.pocketbrain.watchdog.plist")!;
  expect(wd.text).toContain("<string>watchdog</string>");
  expect(wd.text).toContain("<string>/b</string>");
  expect(wd.text).toContain("<key>StartInterval</key><integer>300</integer>");
  expect(wd.text).not.toContain("<key>KeepAlive</key>");
});

test("the hub's hourly backup runs in a child process with a time limit, so a stuck backup folder can't freeze the hub", async () => {
  const root = makeBrain();
  const killed: string[] = [];
  const started: string[][] = [];
  // A child that never exits, like one blocked opening a cloud-synced folder.
  const spawn = (cmd: string[]) => { started.push(cmd); return { exited: new Promise<number>(() => {}), kill: (s?: string) => { killed.push(String(s)); } }; };
  const t0 = Date.now();
  await expect(backupApart(root, { spawn, timeoutMs: 50, due: () => true })).rejects.toThrow(/didn't finish/);
  expect(Date.now() - t0).toBeLessThan(5000);
  expect(started[0]).toEqual(expect.arrayContaining(["backup", "--if-due", "--brain", root]));
  expect(killed).toEqual(["SIGKILL"]);
  // Not due: no child at all.
  started.length = 0;
  expect(await backupApart(root, { spawn, timeoutMs: 50, due: () => false })).toBeUndefined();
  expect(started).toEqual([]);
});
