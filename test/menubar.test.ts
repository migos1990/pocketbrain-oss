// SPDX-License-Identifier: AGPL-3.0-only
// The Mac menu-bar app's brain: what it shows (hub, real-use bar, agents, dashboard link) and what
// it does (install or restart the hub under launchd, pause or cut off an agent). The Swift app only
// draws this JSON, so its field names are checked against the Swift model here.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { menuState, menuTitle, dashboardLink, openDashboard, installedBrain, installHub, restartHub, setupBrain, type Run } from "../src/menubar";
import { loadRules } from "../src/rules";
import { main } from "../src/cli";

const home = () => mkdtempSync(join(tmpdir(), "pb-home-"));
const up = (async () => new Response("{}")) as unknown as typeof fetch;
const down = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;

test("the menu shows the hub, the day of the real-use bar and every outside agent with its switch", async () => {
  const root = makeBrain();
  const h = home();
  const s = await menuState(root, { home: h, fetch: down });
  expect(s).toMatchObject({ brain: root, hubUp: false, installed: false, barTarget: 14, dashboard: false });
  expect(s.barLine).toContain("Real-use bar");
  const outside = Object.entries(loadRules(root).policy.agents).filter(([, a]) => !a.inside_wall).map(([n]) => n).sort();
  expect(s.agents.map((a) => a.name)).toEqual(outside);
  expect(s.agents.every((a) => a.status === "active")).toBe(true);
  expect(menuTitle(s)).toBe(`○ day ${s.barDays}/14`);
  expect(menuTitle({ hubUp: true, barDays: 14, barTarget: 14, barMet: true })).toBe("● bar met");
});

test("the dashboard link is the newest one the hub printed, and only for this machine", async () => {
  const log = "owner dashboard (this machine only): http://127.0.0.1:8788/login?key=old1\nhub tick\nowner dashboard (this machine only): http://127.0.0.1:8788/login?key=new_2-x\n";
  expect(dashboardLink(log)).toBe("http://127.0.0.1:8788/login?key=new_2-x");
  expect(dashboardLink("owner dashboard (this machine only): http://evil.example:8788/login?key=abc")).toBeNull();
  expect(dashboardLink("")).toBeNull();
  const root = makeBrain();
  const h = home();
  mkdirSync(join(h, "Library", "Logs"), { recursive: true });
  writeFileSync(join(h, "Library", "Logs", "com.pocketbrain.start.log"), log);
  // The app learns only that the dashboard can be opened; the login key never leaves the CLI (rt-menubar-loginkey).
  const st = await menuState(root, { home: h, fetch: up });
  expect(st.dashboard).toBe(true);
  expect(JSON.stringify(st)).not.toContain("key=");
  // A stale link from a hub that is down would only show "wrong key": nothing to open then.
  expect((await menuState(root, { home: h, fetch: down })).dashboard).toBe(false);
  // Opening hands the link to the system's opener and prints nothing of it.
  const calls: string[][] = [];
  const said = openDashboard({ home: h, run: (cmd) => { calls.push(cmd); return { code: 0, out: "" }; } });
  expect(calls).toEqual([["open", "http://127.0.0.1:8788/login?key=new_2-x"]]);
  expect(said).not.toContain("key=");
  expect(() => openDashboard({ home: home(), run: () => ({ code: 0, out: "" }) })).toThrow(/no dashboard link/);
});

test("install writes the launchd file and loads it, finds the brain from it later, and never overwrites a running hub", async () => {
  const root = makeBrain();
  const h = home();
  const calls: string[][] = [];
  const run: Run = (cmd) => { calls.push(cmd); return { code: 0, out: "" }; };
  const done = installHub(root, { home: h, bun: "/opt/homebrew/bin/bun", app: "/Users/me/pocketbrain", uid: 501, run });
  expect(done).toEqual(["installed and started com.pocketbrain.start"]);
  const plist = join(h, "Library", "LaunchAgents", "com.pocketbrain.start.plist");
  expect(readFileSync(plist, "utf8")).toContain(`<string>${root}</string>`);
  expect(calls).toEqual([["launchctl", "bootstrap", "gui/501", plist]]);
  expect(installedBrain(h)).toBe(root);
  expect((await menuState(root, { home: h, fetch: down })).installed).toBe(true);
  expect(() => installHub(root, { home: h, bun: "b", app: "a", uid: 501, run })).toThrow(/already installed/);
  expect(calls.length).toBe(1);
  // Restart is a kickstart of the running job, never an unload.
  expect(restartHub({ home: h, uid: 501, run })).toBe("hub restarted");
  expect(calls[1]).toEqual(["launchctl", "kickstart", "-k", "gui/501/com.pocketbrain.start"]);
  expect(() => restartHub({ home: home(), uid: 501, run })).toThrow(/isn't installed/);
  const fail: Run = () => ({ code: 5, out: "Bootstrap failed: 5: Input/output error" });
  expect(() => installHub(root, { home: home(), bun: "b", app: "a", uid: 501, run: fail })).toThrow(/bootstrap .* failed: Bootstrap failed/);
});

test("the command line can only tighten an agent's switch; loosening one is the dashboard's, behind your login", async () => {
  const root = makeBrain({ git: true });
  const agent = Object.entries(loadRules(root).policy.agents).find(([, a]) => !a.inside_wall)![0];
  const status = () => loadRules(root).policy.agents[agent].status ?? "active";
  expect(await main(["agent", "read-only", agent, "--brain", root])).toBe(0);
  expect(status()).toBe("read-only");
  expect(await main(["agent", "pause", agent, "--brain", root])).toBe(0);
  expect(status()).toBe("paused");
  // A paused agent that can run a shell must not be able to unpause itself (rt-menubar-agentcli).
  expect(await main(["agent", "read-only", agent, "--brain", root])).toBe(1);
  expect(await main(["agent", "resume", agent, "--brain", root])).toBe(2);
  expect(status()).toBe("paused");
  expect(await main(["agent", "revoke", agent, "--brain", root])).toBe(0);
  expect(await main(["agent", "pause", "nobody-here", "--brain", root])).toBe(1);
  expect(await main(["agent", "sleep", agent, "--brain", root])).toBe(2);
});

test("the app runs only a bun and an app folder it was built with, never paths from a writable setting", () => {
  // rt-menubar-rce: any process of the user's could write the app's defaults and have it run its code.
  const dir = join(import.meta.dir, "../macos/PocketBrainBar");
  const runner = readFileSync(join(dir, "Sources/PocketBrainBar/Runner.swift"), "utf8");
  expect(runner).not.toMatch(/UserDefaults|defaults write|ProcessInfo\.processInfo\.environment\["(BUN|APP)/);
  expect(runner).toContain('Bundle.main.object(forInfoDictionaryKey: "PocketBrainApp")');
  for (const path of [...runner.matchAll(/"(\/[^"]*bun)"/g)].map((m) => m[1])) expect(["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]).toContain(path);
  expect(runner).toMatch(/isTrusted\(/);
  expect(readFileSync(join(dir, "build.sh"), "utf8")).toContain("<key>PocketBrainApp</key>");
});

// The fields of one `struct Name` in the Swift file, up to the next struct.
const swiftFields = (swift: string, name: string) => {
  const from = swift.indexOf(`struct ${name}`);
  const to = swift.indexOf("\nstruct ", from + 1);
  return [...swift.slice(from, to < 0 ? undefined : to).matchAll(/^\s+let (\w+):/gm)].map((m) => m[1]).sort();
};

test("every field the Swift app decodes is one the CLI sends", async () => {
  const swift = readFileSync(join(import.meta.dir, "../macos/PocketBrainBar/Sources/PocketBrainBar/Model.swift"), "utf8");
  const s = await menuState(makeBrain(), { home: home(), fetch: down });
  expect(swiftFields(swift, "MenuState")).toEqual(Object.keys(s).sort());
  expect(swiftFields(swift, "MenuAgent")).toEqual(Object.keys(s.agents[0]).sort());
  const r = setupBrain(join(home(), "brain"), { name: "Sam Owner" });
  expect(swiftFields(swift, "SetupResult")).toEqual(Object.keys(r).sort());
  expect(existsSync(join(import.meta.dir, "../macos/PocketBrainBar/build.sh"))).toBe(true);
});

test("with no brain yet the menu offers set-up, and set-up makes the brain, installs the hub and hands over the first agent", async () => {
  const h = home();
  const none = await menuState(join(h, "nowhere"), { home: h, fetch: down });
  expect(none).toMatchObject({ brainReady: false, agents: [], barDays: 0, installed: false });
  const notes = join(h, "notes.txt");
  writeFileSync(notes, "Sam works at Example Co as a designer.\n");
  const calls: string[][] = [];
  const run: Run = (cmd) => { calls.push(cmd); return { code: 0, out: "" }; };
  const r = setupBrain(join(h, "my-brain"), { name: "Sam Owner", agent: "claude", text: [notes], install: { home: h, bun: "/opt/homebrew/bin/bun", app: "/Users/me/pocketbrain", uid: 501, run } });
  expect(r).toMatchObject({ brain: join(h, "my-brain"), agent: "claude", mcpUrl: "http://127.0.0.1:8787/mcp", installed: ["installed and started com.pocketbrain.start"] });
  expect(r.token.length).toBeGreaterThan(20);
  expect(r.standing).toContain("pocketBrain");
  expect(r.notes).toBeGreaterThan(0);
  expect(calls[0].slice(0, 3)).toEqual(["launchctl", "bootstrap", "gui/501"]);
  expect(installedBrain(h)).toBe(join(h, "my-brain"));
  const ready = await menuState(r.brain, { home: h, fetch: down });
  expect(ready.brainReady).toBe(true);
  expect(ready.agents.map((a) => a.name)).toContain("claude");
  // Set-up never writes over an existing brain.
  expect(() => setupBrain(join(h, "my-brain"), { name: "Sam Owner" })).toThrow(/isn't empty/);
});

test("menubar setup on the command line prints the JSON the window reads, and says what is missing", async () => {
  const h = home();
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "menubar", "setup", "--name", "Sam Owner", "--dir", join(h, "b"), "--no-install"], { env: { ...process.env, HOME: h, PB_CONFIG_DIR: join(h, "cfg") } });
  expect(p.exitCode).toBe(0);
  const last = p.stdout.toString().trim().split("\n").filter((l) => l.startsWith("{")).at(-1)!;
  expect(JSON.parse(last)).toMatchObject({ brain: join(h, "b"), installed: [] });
  expect(readFileSync(join(h, "cfg", "brain"), "utf8").trim()).toBe(join(h, "b"));
  const bad = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "menubar", "setup"], { env: { ...process.env, HOME: h } });
  expect(bad.exitCode).toBe(2);
});
