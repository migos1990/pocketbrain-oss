// SPDX-License-Identifier: AGPL-3.0-only
// Self-reporting when the hub can't (owner, 2026-10-22: "self-healing, self-reporting"). The
// watchdog runs outside the hub, so what it finds reaches the owner on the Mac itself (a system
// notification, and the menu bar's problem lines) even with the hub dead; the hub in turn flags a
// watchdog that stopped running.
import { test, expect, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { watchdogTick } from "../src/watchdog";
import { selfChecks } from "../src/probe";
import { menuState, menuTitle } from "../src/menubar";

const cfg = process.env.PB_CONFIG_DIR;
afterEach(() => { if (cfg === undefined) delete process.env.PB_CONFIG_DIR; else process.env.PB_CONFIG_DIR = cfg; });
const ok: typeof fetch = (async () => new Response('{"ok":true}')) as unknown as typeof fetch;
const hang: typeof fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
const at = (h: number) => new Date(Date.parse("2026-10-20T12:00:00Z") + h * 3_600_000);

test("a job the hub stopped running reaches the owner as a notification from the watchdog, once a day", async () => {
  const root = makeBrain();
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-sr-cfg-"));
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "start-state.json"), JSON.stringify({ night_at: "2026-10-18T07:30:00Z" }));
  const said: string[] = [];
  const o = { url: "http://127.0.0.1:8787", run: () => ({ code: 0, out: "" }), uid: 501, timeoutMs: 50, platform: "darwin", notify: (t: string) => { said.push(t); } };
  await watchdogTick(root, { ...o, fetch: ok, now: at(0) });
  expect(said.length).toBe(1);
  expect(said[0]).toMatch(/night last ran 2026-10-18/);
  await watchdogTick(root, { ...o, fetch: ok, now: at(1) });
  expect(said.length).toBe(1);
  // A hung hub is said at once, beside the restart.
  await watchdogTick(root, { ...o, fetch: hang, now: at(2) });
  await watchdogTick(root, { ...o, fetch: hang, now: at(2.1) });
  expect(said.at(-1)).toMatch(/didn't answer/);
});

test("the menu bar shows the watchdog's problems, and a watchdog that stopped running; the hub flags it too", async () => {
  const root = makeBrain();
  process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-sr-cfg-"));
  const home = mkdtempSync(join(tmpdir(), "pb-sr-home-"));
  const down: typeof fetch = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  mkdirSync(join(root, "log"), { recursive: true });
  writeFileSync(join(root, "log", "start-state.json"), JSON.stringify({ night_at: "2026-10-18T07:30:00Z" }));
  const now = new Date();
  await watchdogTick(root, { url: "x", run: () => ({ code: 0, out: "" }), uid: 501, timeoutMs: 50, platform: "darwin", notify: () => {}, fetch: ok, now });
  const s = await menuState(root, { home, fetch: down });
  expect(s.problems.join("\n")).toMatch(/night last ran/);
  expect(menuTitle(s)).toMatch(/^⚠/);

  // Installed but silent for over 15 minutes: the menu says so, and so does the hub's self-check.
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.pocketbrain.watchdog.plist"), "<plist/>");
  writeFileSync(join(root, "log", "watchdog.json"), JSON.stringify({ fails: 0, last: new Date(Date.now() - 40 * 60_000).toISOString(), problems: [] }));
  expect((await menuState(root, { home, fetch: down })).problems.join("\n")).toMatch(/watchdog hasn't run since/);
  expect(selfChecks(root, new Date())).toContainEqual(expect.objectContaining({ name: "watchdog", ok: false }));
});
