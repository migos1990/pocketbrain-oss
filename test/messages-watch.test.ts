// SPDX-License-Identifier: AGPL-3.0-only
// Messages on the hub's Mac can hang on AppleEvents (2026-10-23/24: up 20 h, every iMessage send
// failed with "AppleEvent timed out (-1712)", nothing surfaced). Failed texts are a hub check, so
// the probe, the menu bar and a Mac notification say so; the watchdog relaunches Messages once (G380).
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { jobChecks } from "../src/probe";
import { watchdogTick } from "../src/watchdog";
import { appendJsonl } from "../src/util";

const NOW = new Date("2026-10-24T15:00:00Z");
const send = (root: string, at: string, ok: boolean, detail?: string, via = "imessage") => {
  mkdirSync(join(root, "textline"), { recursive: true });
  appendJsonl(join(root, "textline", "log.jsonl"), { at, sent: `t-${at}`, via, ok, ...(detail ? { detail } : {}), kind: "batch" });
};
const TIMEOUT = "osascript: execution error: Messages got an error: AppleEvent timed out. (-1712)";
const texts = (root: string, now = NOW) => jobChecks(root, now).find((c) => c.name === "texts");

test("three failed texts in a row are a failing hub check; one that went through clears it", () => {
  const root = makeBrain();
  expect(texts(root)).toBeUndefined(); // no text ever sent: nothing to say
  send(root, "2026-10-24T09:00:00Z", true);
  for (const h of ["10", "12", "14"]) send(root, `2026-10-24T${h}:00:00Z`, false, TIMEOUT);
  const c = texts(root)!;
  expect(c.ok).toBe(false);
  expect(c.detail).toContain("Messages");
  expect(c.detail).toContain("3");
  send(root, "2026-10-24T14:30:00Z", true);
  expect(texts(root)!.ok).toBe(true);
});

test("the watchdog relaunches a Messages that stopped answering, and says so", async () => {
  const root = makeBrain();
  for (const h of ["10", "12", "14"]) send(root, `2026-10-24T${h}:00:00Z`, false, TIMEOUT);
  const runs: string[][] = [];
  const said: string[] = [];
  const run = (cmd: string[]) => { runs.push(cmd); return { code: 0, out: "" }; };
  const o = { url: "http://127.0.0.1:8787", run, uid: 501, timeoutMs: 50, platform: "darwin" as const, notify: (t: string) => said.push(t), fetch: (async () => new Response("{}")) as unknown as typeof fetch };
  await watchdogTick(root, { ...o, now: NOW });
  expect(runs).toEqual([["killall", "Messages"], ["open", "-g", "-a", "Messages", "--args", "-NSAppSleepDisabled", "YES"]]);
  expect(said.some((t) => t.includes("Messages"))).toBe(true);
  const log = readFileSync(join(root, "textline", "log.jsonl"), "utf8");
  expect(log).toContain('"relaunched":"Messages"');
  await watchdogTick(root, { ...o, now: new Date(NOW.getTime() + 60 * 60_000) });
  expect(runs.length).toBe(2);
  send(root, new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString(), false, TIMEOUT);
  await watchdogTick(root, { ...o, now: new Date(NOW.getTime() + 2 * 60 * 60_000 + 60_000) });
  expect(runs.length).toBe(4);
});

test("a send failure that isn't Messages hanging (a wrong number, no permission) is reported but never relaunches it", async () => {
  const root = makeBrain();
  for (const h of ["10", "12", "14"]) send(root, `2026-10-24T${h}:00:00Z`, false, "osascript: execution error: Not authorized to send Apple events to Messages. (-1743)");
  const runs: string[][] = [];
  await watchdogTick(root, { url: "http://x", run: (c) => { runs.push(c); return { code: 0, out: "" }; }, uid: 501, platform: "darwin", now: NOW, notify: () => {}, fetch: (async () => new Response("{}")) as unknown as typeof fetch });
  expect(texts(root)!.ok).toBe(false);
  expect(runs).toEqual([]);
  // Off a Mac, never.
  expect(existsSync(join(root, "log", "watchdog.json"))).toBe(true);
});

test("an iMessage send that hangs gives up on time and never blocks the hub's event loop", async () => {
  const { runWithTimeout } = await import("../src/textline/transport");
  let ticked = 0;
  const iv = setInterval(() => ticked++, 20);
  const t0 = Date.now();
  const r = await runWithTimeout(["sleep", "5"], 300);
  clearInterval(iv);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(r.exitCode).not.toBe(0);
  expect(r.stderr).toContain("no answer from Messages");
  expect(ticked).toBeGreaterThan(5); // the loop kept running while the send waited
});

// 2026-10-24 17:43Z: one send timed out, Messages stayed hung, and the watchdog waited for 3
// failures that the poller's backoff never let happen (G382). One hung send is enough; a repeat
// needs a new failure after the last relaunch, 15 minutes apart, at most 6 a day.
test("one timed-out send relaunches Messages; another relaunch needs a new failure, 15 min apart, at most 6 a day", async () => {
  const root = makeBrain();
  const runs: string[][] = [];
  const said: string[] = [];
  const run = (cmd: string[]) => { runs.push(cmd); return { code: 0, out: "" }; };
  const o = { url: "http://127.0.0.1:8787", run, uid: 501, timeoutMs: 50, platform: "darwin" as const, notify: (t: string) => said.push(t), fetch: (async () => new Response("{}")) as unknown as typeof fetch };
  const at = (m: number) => new Date(Date.parse("2026-10-24T13:00:00Z") + m * 60_000);
  const relaunches = () => runs.filter((c) => c[0] === "open").length;
  send(root, at(0).toISOString(), true);
  await watchdogTick(root, { ...o, now: at(1) });
  expect(relaunches()).toBe(0); // the last send went out
  send(root, at(2).toISOString(), false, "no answer from Messages in 30 s");
  await watchdogTick(root, { ...o, now: at(3) });
  expect(relaunches()).toBe(1);
  await watchdogTick(root, { ...o, now: at(30) });
  expect(relaunches()).toBe(1); // no new failure since
  send(root, at(31).toISOString(), false, TIMEOUT);
  await watchdogTick(root, { ...o, now: at(32) });
  expect(relaunches()).toBe(2);
  send(root, at(35).toISOString(), false, TIMEOUT);
  await watchdogTick(root, { ...o, now: at(36) });
  expect(relaunches()).toBe(2); // within 15 minutes of the last relaunch
  await watchdogTick(root, { ...o, now: at(48) });
  expect(relaunches()).toBe(3);
  for (let i = 0; i < 6; i++) { send(root, at(60 + i * 20).toISOString(), false, TIMEOUT); await watchdogTick(root, { ...o, now: at(61 + i * 20) }); }
  expect(relaunches()).toBe(6); // the day's cap
  expect(said.filter((t) => t.includes("restarted")).length).toBe(1); // said once a day, logged every time
});
