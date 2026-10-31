// SPDX-License-Identifier: AGPL-3.0-only
// What the Mac menu-bar app (macos/PocketBrainBar) shows and does, kept here so it is tested on
// any machine: the app itself only runs `pocketbrain menubar ...` and draws the JSON it gets back.
// The terminal is not the hero; this is the door for owners who never open one (docs/menubar.md).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadRules } from "./rules";
import { bar } from "./measure";
import { hubPlists } from "./start";
import { initBrain } from "./init";
import { standingInstruction } from "./orientation";
import { watchdogState } from "./watchdog";

export const START_LABEL = "com.pocketbrain.start";
export const TUNNEL_LABEL = "com.pocketbrain.tunnel";

export interface MenuAgent { name: string; status: "active" | "paused" | "read-only" }
// The JSON the app decodes. Keep in step with `struct MenuState` in macos/PocketBrainBar/Sources/Model.swift
// (test/menubar.test.ts checks the two agree).
export interface MenuState {
  brain: string;
  brainReady: boolean;
  hubUp: boolean;
  hubUrl: string;
  installed: boolean;
  tunnelInstalled: boolean;
  barDays: number;
  barTarget: number;
  barMet: boolean;
  barLine: string;
  agents: MenuAgent[];
  // Whether the dashboard can be opened now. Never the link itself: it carries the owner's login key.
  dashboard: boolean;
  // What the watchdog found from outside the hub (src/watchdog.ts), one line each; shown even with the hub down.
  problems: string[];
}

const plistDir = (home: string) => join(home, "Library", "LaunchAgents");
const plistFile = (home: string, label: string) => join(plistDir(home), `${label}.plist`);

// The brain the installed hub serves: the `--brain` argument in its launchd file. The app needs no
// setting of its own on a Mac where the hub is already installed.
export function installedBrain(home: string): string | undefined {
  const f = plistFile(home, START_LABEL);
  if (!existsSync(f)) return undefined;
  const args = [...readFileSync(f, "utf8").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  const i = args.indexOf("--brain");
  return i >= 0 ? args[i + 1] : undefined;
}

// The owner dashboard prints a fresh login link each time the hub starts; launchd sends it to the
// hub's log, which only the owner can read. The latest one is the live one.
export function dashboardLink(log: string): string | null {
  const all = [...log.matchAll(/owner dashboard \(this machine only\): (http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/login\?key=[A-Za-z0-9_-]+)/g)];
  return all.at(-1)?.[1] ?? null;
}

const latestDashboardLink = (home: string) => {
  const log = join(home, "Library", "Logs", `${START_LABEL}.log`);
  return existsSync(log) ? dashboardLink(readFileSync(log, "utf8")) : null;
};

// Opens the dashboard signed in, by handing the login link straight to the system's opener; the
// link (it holds the owner's login key) is never printed, so no other program reads it from us.
export function openDashboard(o: { home: string; run: Run }): string {
  const link = latestDashboardLink(o.home);
  if (!link) throw new Error("no dashboard link in the hub's log yet: is the hub running? (Restart hub prints a new one)");
  const r = o.run(["open", link]);
  if (r.code !== 0) throw new Error("couldn't open the browser");
  return "dashboard opened";
}

export async function menuState(root: string, o: { home: string; port?: number; fetch?: typeof fetch; end?: string }): Promise<MenuState> {
  const hubUrl = `http://127.0.0.1:${o.port ?? 8787}`;
  const f = o.fetch ?? fetch;
  const hubUp = await f(`${hubUrl}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
  // No brain yet (a new owner): the app offers the first-run window instead of the bar.
  const brainReady = existsSync(join(root, "rules", "policy.yaml"));
  const b = brainReady ? bar(root, o.end) : { days: 0, target: 14, met: false, text: "No brain yet: set up pocketBrain from the menu" };
  const agents = brainReady ? Object.entries(loadRules(root).policy.agents)
    .filter(([, a]) => !a.inside_wall)
    .map(([name, a]) => ({ name, status: a.status ?? "active" }))
    .sort((x, y) => x.name.localeCompare(y.name)) : [];
  return {
    brain: root,
    brainReady,
    hubUp,
    hubUrl,
    installed: existsSync(plistFile(o.home, START_LABEL)),
    tunnelInstalled: existsSync(plistFile(o.home, TUNNEL_LABEL)),
    barDays: Math.min(b.days, b.target),
    barTarget: b.target,
    barMet: b.met,
    barLine: b.text,
    agents,
    dashboard: hubUp && !!latestDashboardLink(o.home),
    problems: brainReady ? watchdogProblems(root, o.home) : [],
  };
}

// The watchdog's problem lines, and one more when it is installed but stopped running.
const WATCHDOG_LABEL = "com.pocketbrain.watchdog";
function watchdogProblems(root: string, home: string): string[] {
  const s = watchdogState(root);
  const out = (s.problems ?? []).map((p) => p.detail);
  if (existsSync(plistFile(home, WATCHDOG_LABEL)) && (!s.last || Date.now() - Date.parse(s.last) > 15 * 60_000))
    out.push(s.last ? `the watchdog hasn't run since ${s.last.slice(0, 16)}` : "the watchdog is installed but hasn't run yet");
  return out;
}

// One line for the menu bar itself: a warning sign when something is wrong, a dot for the hub, then the day count.
export function menuTitle(s: Pick<MenuState, "hubUp" | "barDays" | "barTarget" | "barMet"> & { problems?: string[] }): string {
  return `${s.problems?.length ? "⚠ " : ""}${s.hubUp ? "●" : "○"} ${s.barMet ? "bar met" : `day ${s.barDays}/${s.barTarget}`}`;
}

export type Run = (cmd: string[]) => { code: number; out: string };

// Install the hub under launchd: write the plist, then load it. Refuses to overwrite a hub that is
// already installed, since that one is running the owner's brain; restart it instead.
export function installHub(root: string, o: { home: string; bun: string; app: string; uid: number; run: Run; tunnel?: string; tunnelConfig?: string }): string[] {
  const plists = hubPlists(root, { bun: o.bun, app: o.app, home: o.home, tunnel: o.tunnel, tunnelConfig: o.tunnelConfig });
  // A job already installed is never rewritten (it may be running the owner's brain); one added
  // since (the watchdog, 2026-10-22) is installed beside it.
  const missing = plists.filter((p) => !existsSync(join(plistDir(o.home), p.file)));
  if (!missing.length) throw new Error(`already installed: ${plists.map((p) => p.file).join(", ")}. Use "Restart hub" (pocketbrain menubar restart)`);
  mkdirSync(plistDir(o.home), { recursive: true });
  const done: string[] = [];
  for (const p of missing) {
    const file = join(plistDir(o.home), p.file);
    writeFileSync(file, p.text);
    const r = o.run(["launchctl", "bootstrap", `gui/${o.uid}`, file]);
    if (r.code !== 0) throw new Error(`launchctl bootstrap ${p.file} failed: ${r.out.trim().slice(0, 200)}`);
    done.push(`installed and started ${p.file.replace(/\.plist$/, "")}`);
  }
  return done;
}

// Restart the running hub (launchd starts a fresh process). Never unloads it and never touches the tunnel.
// `before` runs once the hub is known to be installed, just before the kickstart.
export function restartHub(o: { home: string; uid: number; run: Run; before?: () => void }): string {
  if (!existsSync(plistFile(o.home, START_LABEL))) throw new Error("the hub isn't installed yet: use Install hub (pocketbrain menubar install)");
  o.before?.();
  const r = o.run(["launchctl", "kickstart", "-k", `gui/${o.uid}/${START_LABEL}`]);
  if (r.code !== 0) throw new Error(`launchctl kickstart failed: ${r.out.trim().slice(0, 200)}`);
  return "hub restarted";
}

// The first-run window's one call: a new brain from the owner's name (and a notes file, if any),
// then the hub under launchd, then what to paste into the first agent. The JSON the window shows;
// keep in step with `struct SetupResult` in Model.swift.
export interface SetupResult { brain: string; agent: string; notes: number; token: string; mcpUrl: string; standing: string; installed: string[] }

export function setupBrain(dir: string, o: { name: string; agent?: string; text?: string[]; install?: Parameters<typeof installHub>[1] }): SetupResult {
  const r = initBrain(dir, { owner: o.name, agent: o.agent, text: o.text ?? [], token: true });
  const mcpUrl = "http://127.0.0.1:8787/mcp";
  const installed = o.install ? installHub(r.root, o.install) : [];
  return { brain: r.root, agent: r.agent, notes: r.notes, token: r.token ?? "", mcpUrl, standing: standingInstruction(loadRules(r.root), "mcp", "http://127.0.0.1:8787"), installed };
}
