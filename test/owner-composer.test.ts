// SPDX-License-Identifier: AGPL-3.0-only
// The box as a messaging app's composer (owner, 2026-10-31: "the box doesn't look like a modern
// app", "the experience in app should feel premium"; the box grows as text wraps, the text never
// slides off to the right; he said yes to the proposal at 18:35Z). One composer, pinned above the
// tabs on On your mind, Ask and a page: a text area that grows line by line to a few lines and
// then scrolls inside, a round send arrow that lights up once there is text, Enter sends and
// Shift+Enter breaks the line, and what was said shows at once while the page loads.
import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { uiRig } from "./ui-rig";
import { APP_CSS, COMPOSER_MAX } from "../src/dashboard/html-app";

const pinnedComposer = /<div class="pinned">(?:(?!<\/div>)[\s\S])*?<form class="box composer" data-focus-ring(?:="")? method="post" action="\/say">[\s\S]*?<textarea id="q" name="q" rows="1"[^>]*><\/textarea><button class="send" aria-label="Send">/;

test("On your mind, Ask and a page share one composer pinned above the tabs, and the home has nothing between its count and its cards", async () => {
  const r = await uiRig();
  try {
    const b = await chromium.launch();
    const page = await (await b.newContext()).newPage();
    await page.goto(r.loginUrl);
    for (const path of ["/home", "/ask", "/p/people/maya-chen"]) {
      await page.goto(r.dash + path);
      const html = await page.content();
      expect(html).toMatch(pinnedComposer);
      expect(html.match(/<textarea/g)).toHaveLength(1);
    }
    await page.goto(r.dash + "/home");
    expect(await page.content()).toMatch(/<\/header><p class="count">[\s\S]*?<\/p>\s*<ul class="mind">/);
    await b.close();
  } finally { r.stop(); }
}, 90_000);

test("the composer grows as the text wraps, up to a few lines, never sideways; the arrow lights up; Enter sends what was said", async () => {
  const r = await uiRig();
  try {
    const b = await chromium.launch();
    const page = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    await page.goto(r.loginUrl);
    await page.goto(r.dash + "/ask");
    const q = page.locator("#q");
    const h0 = (await q.boundingBox())!.height;
    expect(await page.locator("form.composer").getAttribute("class")).not.toContain("ready");
    await q.fill("what is the role of the person who runs the September usability sessions with Kenji on Atlas?");
    const h1 = (await q.boundingBox())!.height;
    expect(h1).toBeGreaterThan(h0 * 1.5);
    expect(await q.evaluate((t) => (t as HTMLTextAreaElement).scrollWidth <= (t as HTMLTextAreaElement).clientWidth)).toBe(true);
    expect(await page.locator("form.composer").getAttribute("class")).toContain("ready");
    await q.fill("x ".repeat(400));
    expect((await q.boundingBox())!.height).toBeLessThanOrEqual(COMPOSER_MAX + 4);
    await q.fill("who is Maya Chen?");
    await Promise.all([page.waitForNavigation(), q.press("Enter")]);
    await page.waitForLoadState();
    expect(await page.content()).toContain('<p class="bubble you">who is Maya Chen?</p>');
    // Shift+Enter breaks the line instead; the hub reads it as one line.
    await page.locator("#q").fill("who is");
    await page.locator("#q").press("Shift+Enter");
    expect(await page.locator("#q").inputValue()).toBe("who is\n");
    await page.locator("#q").type("Isabelle Roy?");
    await Promise.all([page.waitForNavigation(), page.locator("#q").press("Enter")]);
    await page.waitForLoadState();
    expect(await page.content()).toContain('<p class="bubble you">who is Isabelle Roy?</p>');
    await b.close();
  } finally { r.stop(); }
}, 90_000);

test("the composer is a raised bar with a round send arrow, in the two inks", () => {
  expect(APP_CSS).toMatch(/form\.composer\{[^}]*border-radius:2\dpx[^}]*box-shadow:/);
  expect(APP_CSS).toMatch(/form\.composer button\.send\{[^}]*border-radius:50%[^}]*background:var\(--headline-ink\)/);
  expect(APP_CSS).toMatch(new RegExp(`form\\.composer textarea\\{[^}]*max-height:${COMPOSER_MAX}px[^}]*overflow-y:auto`));
});
