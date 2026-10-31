// SPDX-License-Identifier: AGPL-3.0-only
// The owner dashboard and the browser door, page by page, in a real Chromium on a copy of the demo
// brain (test/ui-rig.ts): accessibility (labels, names, landmarks, headings, contrast), keyboard
// focus, light and dark, a lived-in day, busy and error states. With PB_UI_SHOTS=1 each page is also compared with its
// screenshot baseline in test/screenshots/<platform>/ (docs/ui-quality.md). Skipped when
// Chromium can't start.
import { test, expect, afterAll, setSystemTime } from "bun:test";
import { join } from "node:path";
import { audit, keyboard, matchScreenshot } from "./ui-audit";
import { uiRig, DASHBOARD_PAGES, BUSY_PAGES, DOOR_PAGES, ASK_SAYS } from "./ui-rig";

let pw: any;
let browser: any;
try { pw = await import("playwright"); browser = await pw.chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
afterAll(async () => { await browser?.close(); setSystemTime(); });

const SHOTS = process.env.PB_UI_SHOTS === "1";
// Times on the pages come from this process's clock; git commit times are masked instead.
const CLOCK = new Date("2026-10-08T14:00:00Z");
const MASK = [".b-when", ".h-date", "time"];
const SCHEMES = ["light", "dark"] as const;

async function check(page: any, url: string, name: string, scheme: string, problems: string[], o: { keys?: boolean } = {}) {
  const res = await page.goto(url);
  if (res.status() >= 500) problems.push(`${name}: HTTP ${res.status()}`);
  for (const p of await audit(page)) problems.push(`${name} (${scheme}): ${p}`);
  if (o.keys) for (const p of await keyboard(page)) problems.push(`${name} (keyboard): ${p}`);
  if (SHOTS) { const d = await matchScreenshot(page, `${process.platform}/${name}-${scheme}`, { mask: MASK }); if (d) problems.push(d); }
}

run("every dashboard page passes the accessibility checks in light and dark, empty and busy, and keeps its look", async () => {
  setSystemTime(CLOCK);
  const quiet = await uiRig({ ports: [18961, 18962] }); // the demo brain's own day
  const busy = await uiRig({ busy: true, ports: [18963, 18964] });
  const problems: string[] = [];
  try {
    for (const scheme of SCHEMES) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.goto(quiet.loginUrl);
      for (const [name, path] of DASHBOARD_PAGES) await check(page, quiet.dash + path, name, scheme, problems, { keys: scheme === "light" });
      await page.goto(busy.loginUrl);
      for (const [name, path] of BUSY_PAGES) {
        if (name === "ask-busy") for (const q of ASK_SAYS) { await page.goto(busy.dash + "/ask"); await page.fill("#q", q); await page.press("#q", "Enter"); await page.waitForLoadState(); }
        await check(page, busy.dash + path, name, scheme, problems, { keys: scheme === "light" });
      }
      await ctx.close();
    }
  } finally { quiet.stop(); busy.stop(); }
  expect(problems).toEqual([]);
}, 240_000);

run("every browser-door page passes the same checks, follows the system's dark mode and keeps its look", async () => {
  setSystemTime(CLOCK);
  const r = await uiRig({ ports: [18965, 18966] });
  const problems: string[] = [];
  try {
    for (const scheme of SCHEMES) {
      const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await check(page, `${r.api}/b`, "door-signin", scheme, problems, { keys: scheme === "light" });
      const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bg).toBe(scheme === "dark" ? "rgb(25, 25, 25)" : "rgb(255, 255, 255)");
      await page.fill("input[name=agent]", "gemini");
      await page.fill("input[name=password]", r.tokens.gemini);
      await page.click("button[type=submit]");
      for (const [name, path] of DOOR_PAGES) await check(page, r.api + path, name, scheme, problems, { keys: scheme === "light" });
      await ctx.close();
    }
  } finally { r.stop(); }
  expect(problems).toEqual([]);
}, 240_000);

run("on a phone the overview and the door's start page fit the screen without sideways scrolling", async () => {
  setSystemTime(CLOCK);
  const r = await uiRig({ ports: [18967, 18968] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await ctx.newPage();
    const wide = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.goto(`${r.api}/b`);
    expect(await wide()).toBeLessThanOrEqual(0);
    await page.goto(r.loginUrl);
    expect(await wide()).toBeLessThanOrEqual(0);
    await ctx.close();
  } finally { r.stop(); }
}, 60_000);
