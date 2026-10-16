// SPDX-License-Identifier: AGPL-3.0-only
// UI regression: every dashboard page and every browser-door (/b) page, rendered by a real
// Chromium against the fictional sample brain, must match its saved accessibility snapshot in
// test/ui/. The snapshot is what a person or a screen reader gets: headings, links, buttons,
// fields and their text, not pixels, so it is the same on a Mac and in CI.
//   PB_UI_UPDATE=1 bun test test/ui-regression.test.ts   rewrite the snapshots after a wanted change
//   PB_UI_SHOT_DIR=<dir>                                     also save a full-page screenshot per page
// A page with no saved snapshot fails: a new page ships with its snapshot. Never the real brain.
// Skipped when Chromium can't start.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { serve } from "../src/server";
import { issueToken } from "../src/auth";
import { serveDashboard } from "../src/dashboard/server";

let pw: any;
let browser: any;
try { pw = await import("playwright"); browser = await pw.chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
afterAll(async () => { await browser?.close(); });

const DIR = join(import.meta.dir, "ui");
const UPDATE = process.env.PB_UI_UPDATE === "1";
const SHOTS = process.env.PB_UI_SHOT_DIR;

// The sample brain's commit gets a fixed date, so hashes and dates are the same on every run and
// machine (the env is put back after, other test files share this process). Pages render in UTC.
function fixedBrain(): string {
  const keep = { a: process.env.GIT_AUTHOR_DATE, c: process.env.GIT_COMMITTER_DATE };
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = "2026-10-08T12:00:00Z";
  try { return makeBrain(); } finally {
    if (keep.a === undefined) delete process.env.GIT_AUTHOR_DATE; else process.env.GIT_AUTHOR_DATE = keep.a;
    if (keep.c === undefined) delete process.env.GIT_COMMITTER_DATE; else process.env.GIT_COMMITTER_DATE = keep.c;
  }
}
// The dashboard's day charts go by the hub's clock: pinned, so the snapshot doesn't move at midnight.
const TZ = process.env.TZ, NOW = process.env.PB_NOW;
beforeAll(() => { process.env.TZ = "UTC"; process.env.PB_NOW = "2026-10-15T12:00:00Z"; });
afterAll(() => {
  if (TZ === undefined) delete process.env.TZ; else process.env.TZ = TZ;
  if (NOW === undefined) delete process.env.PB_NOW; else process.env.PB_NOW = NOW;
});

// Only what still changes is masked: the port and the wall clock.
export function normalize(s: string): string {
  return s
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:PORT")
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?\b/g, "TIMESTAMP")
    // The same, URL-encoded in a link (the browser door's look-back links go by the wall clock).
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
  "dashboard-overview": "/",
  "dashboard-brain": "/brain",
  "dashboard-note": "/note/people/jane-roy",
  "dashboard-history": "/history",
  "dashboard-note-history": "/history/people/jane-roy",
  "dashboard-map": "/map",
  "dashboard-agents": "/agents",
  "dashboard-agent": "/agent/planner",
  "dashboard-activity": "/activity",
  "dashboard-upkeep": "/upkeep",
  "dashboard-digest": "/digest",
  "dashboard-usage": "/usage?month=2026-10",
};
export const DOOR_PAGES: Record<string, string> = {
  "door-start": "/b",
  "door-orientation": "/b/orientation",
  "door-changes": "/b/changes",
  "door-context": "/b/context?topic=course",
  "door-search": "/b/search?q=Jane",
  "door-remember": "/b/remember",
};

run("dashboard pages match their saved snapshots", async () => {
  const root = fixedBrain();
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
  const root = fixedBrain();
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(/^  helper: \{ /m, "  helper: { browser: true, "));
  const token = issueToken(root, "helper");
  const s = serve(root, 0);
  try {
    const origin = `http://127.0.0.1:${s.port}`;
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const problems = [await check(page, "door-signin", origin + "/b")];
    await page.fill('input[name="agent"]', "helper");
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
  expect(normalize("- text: saved 3f9a2c1 at 14:03")).toBe("- text: saved 3f9a2c1 at 14:03\n");
  expect(normalize("- heading \"Jane Roy\" [level=1]")).toBe("- heading \"Jane Roy\" [level=1]\n");
});
