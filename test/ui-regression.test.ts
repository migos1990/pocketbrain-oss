// SPDX-License-Identifier: AGPL-3.0-only
// UI regression: every dashboard page and every browser-door (/b) page, rendered by a real
// Chromium against the demo brain (scripts/demo-brain.ts, about 500 made-up facts and a replayed
// week, outside review 2026-10-29), must match its saved accessibility snapshot in
// test/ui/. The snapshot is what a person or a screen reader gets: headings, links, buttons,
// fields and their text, not pixels, so it is the same on a Mac and in CI.
//   PB_UI_UPDATE=1 bun test test/ui-regression.test.ts   rewrite the snapshots after a wanted change
//   PB_UI_SHOT_DIR=<dir>                                     also save a full-page screenshot per page
// A page with no saved snapshot fails: a new page ships with its snapshot. Never the real brain.
// Skipped when Chromium can't start.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { serve } from "../src/server";
import { serveDashboard } from "../src/dashboard/server";

let pw: any;
let browser: any;
try { pw = await import("playwright"); browser = await pw.chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
afterAll(async () => { await browser?.close(); });

const DIR = join(import.meta.dir, "ui");
const UPDATE = process.env.PB_UI_UPDATE === "1";
const SHOTS = process.env.PB_UI_SHOT_DIR;

// The demo brain's replay dates every commit and uses fixed tokens, so hashes and dates are the
// same on every run and machine. Pages render in UTC.
// The dashboard's day charts go by the hub's clock: pinned to the demo's morning, so the snapshot
// doesn't move at midnight.
const TZ = process.env.TZ, NOW = process.env.PB_NOW;
beforeAll(() => { process.env.TZ = "UTC"; process.env.PB_NOW = DEMO_NOW; });
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ; else process.env.TZ = TZ;
  if (NOW === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = NOW;
});

// Only what still changes is masked: the port, the wall clock, and the running version on
// Settings (it moves with every commit and release).
export function normalize(s: string): string {
  return s
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?\b/g, "TIMESTAMP")
    // The same, URL-encoded in a link (the browser door's look-back links go by the wall clock).
    .replace(/pocketBrain \d+\.\d+\.\d+[\w.-]*(?: · code [0-9a-f]{7})?/g, "pocketBrain VERSION")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}(%3A\d{2}(\.\d+)?)?Z?\b/g, "TIMESTAMP")
    .trimEnd() + "\n";
}

// Compare against the saved snapshot; problems come back as text so one run lists every page.
async function check(page: any, name: string, url: string): Promise<string | undefined> {
  const res = await page.goto(url);
  if (!res || res.status() >= 400) return `${name}: ${url} answered ${res?.status()}`;
  if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); }
  const got = normalize(await page.locator("body").ariaSnapshot());
  const file = join(DIR, `${name}.aria.yml`);
  if (UPDATE) { mkdirSync(DIR, { recursive: true }); writeFileSync(file, got); return; }
  if (!existsSync(file)) return `${name}: no saved snapshot test/ui/${name}.aria.yml (run with PB_UI_UPDATE=1 and commit it)`;
  const want = readFileSync(file, "utf8");
  if (got === want) return;
  const a = want.split("\n"), b = got.split("\n");
  const i = a.findIndex((l, k) => l !== b[k]);
  return `${name}: ${url} changed at line ${i + 1}\n  saved: ${a[i] ?? "(end)"}\n  now:   ${b[i] ?? "(end)"}\n  (a wanted change: PB_UI_UPDATE=1 bun test test/ui-regression.test.ts, then commit test/ui/)`;
}

export const DASHBOARD_PAGES: Record<string, string> = {
  "dashboard-overview": "/overview",
  "dashboard-brain": "/brain",
  "dashboard-note": "/note/projects/atlas-launch",
  "dashboard-history": "/history",
  "dashboard-note-history": "/history/people/maya-chen",
  "dashboard-map": "/map",
  "dashboard-agents": "/agents",
  "dashboard-agent": "/agent/claude",
  "dashboard-activity": "/activity",
  "dashboard-upkeep": "/upkeep",
  "dashboard-digest": "/digest",
  "dashboard-usage": "/usage?month=2026-10",
  // The owner's screens (phone UI spec §2, owner app brief 2026-10-30), on the demo brain's morning.
  "owner-home": "/home",
  "owner-memory": "/memory",
  "owner-ask": "/ask",
  "owner-who": "/who",
  "owner-let": "/let?key=projects%2Fproduct-discovery-course%23next_step&agent=gemini",
  "owner-page": "/p/people/maya-chen",
  "owner-project": "/p/projects/atlas-launch",
  "owner-settle": "/settle/c-0001",
};
export const DOOR_PAGES: Record<string, string> = {
  "door-start": "/b",
  "door-orientation": "/b/orientation",
  "door-changes": "/b/changes",
  "door-context": "/b/context?topic=Atlas",
  "door-search": "/b/search?q=Maya",
  "door-remember": "/b/remember",
};

run("dashboard pages match their saved snapshots", async () => {
  const { root } = await makeDemoBrain();
  const d = serveDashboard(root, { port: 0 });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await page.goto(d.loginUrl);
    const origin = new URL(d.loginUrl).origin;
    const problems = [];
    for (const [name, path] of Object.entries(DASHBOARD_PAGES)) problems.push(await check(page, name, origin + path));
    expect(problems.filter(Boolean)).toEqual([]);
  } finally { d.server.stop(true); }
}, 60_000);

run("browser door pages match their saved snapshots", async () => {
  const { root, tokens } = await makeDemoBrain();
  const token = tokens.gemini!;
  const s = serve(root, 0);
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const problems = [await check(page, "door-signin", origin + "/b")];
    await page.fill('input[name="agent"]', "gemini");
    await page.fill('input[type="password"]', token);
    await page.click('button[type="submit"]');
    for (const [name, path] of Object.entries(DOOR_PAGES)) problems.push(await check(page, name, origin + path));
    expect(problems.filter(Boolean)).toEqual([]);
  } finally { s.stop(true); }
}, 60_000);

test("a page missing from the snapshots folder is a failure, not a pass", () => {
  if (UPDATE) return;
  const names = [...Object.keys(DASHBOARD_PAGES), ...Object.keys(DOOR_PAGES), "door-signin"];
  expect(names.filter((n) => !existsSync(join(DIR, `${n}.aria.yml`)))).toEqual([]);
});

test("normalize masks only what changes between runs", () => {
  expect(normalize("- text: Since 2026-10-15T21:03:22.120Z on 127.0.0.1:51234")).toBe("- text: Since TIMESTAMP on 127.0.0.1:PORT\n");
  // git gives the time with an offset or with Z depending on the machine (the CI runner, 2026-10-30).
  expect(normalize("- paragraph: \"owner, 2026-10-08T14:00:00+00:00; changed: role\"")).toBe("- paragraph: \"owner, TIMESTAMP; changed: role\"\n");
  expect(normalize("- text: saved 3f9a2c1 at 14:03")).toBe("- text: saved 3f9a2c1 at 14:03\n");
  expect(normalize("- paragraph: pocketBrain 0.2.1 · code 3f9a2c1")).toBe("- paragraph: pocketBrain VERSION\n");
  expect(normalize("- heading \"Jane Roy\" [level=1]")).toBe("- heading \"Jane Roy\" [level=1]\n");
});
