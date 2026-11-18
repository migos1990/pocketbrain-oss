// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11-16 (G975): a tap on a side of a question showed nothing for a few
// seconds, so it was tapped five times. Each tap was sent, the first settled it and the last one's
// answer, "Nothing to settle there any more", was the page that came back. A tap shows at once, a
// form is sent once, a repeat of an answered question is no error, and the answer no longer waits
// for the page writer.
import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { uiRig } from "./ui-rig";
import { makeDemoBrain } from "./fixture";
import { DEMO_NOW } from "../scripts/demo-brain";
import { dashboardHandler } from "../src/dashboard/server";
import { appPage } from "../src/dashboard/html-app";

test("every page of the owner app sends a form once and marks it at the first tap", () => {
  const html = appPage("x", "mind", '<form method="post" action="/action/keep"><button>Keep</button></form>');
  expect(html).toContain("data-once");
  expect(html).toMatch(/form\.sending/);
});

test("five taps on a side with a slow hub: pressed at once, one answer sent, no error after", async () => {
  const r = await uiRig();
  try {
    const b = await chromium.launch();
    const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true })).newPage();
    await page.goto(r.loginUrl);
    await page.goto(r.dash + "/home");
    const href = await page.locator('a[href^="/settle/c-"]').first().getAttribute("href");
    await page.goto(r.dash + href!);
    let posts = 0, held = 0;
    // The hub answers late: every answer is held on its way until this test lets it go, so nothing
    // here depends on how fast the machine is (CI on 358b329: the page moved on mid-check).
    let release = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    await page.route(/\/action\/settle-/, async (route) => { held++; await gate; await route.continue(); });
    page.on("request", (q) => { if (q.method() === "POST" && q.url().includes("/action/settle-")) posts++; });
    const side = page.locator("form.pick:not(.both) button").first();
    await side.tap({ noWaitAfter: true });
    // At once, long before the hub answers.
    const seen = await page.evaluate(() => { const f = document.querySelector("form.pick.sending"); const btn = f?.querySelector("button"); return { n: document.querySelectorAll("form.pick.sending").length, busy: f?.getAttribute("aria-busy"), opacity: btn ? Number(getComputedStyle(btn).opacity) : 1 }; });
    expect(seen.n).toBe(1);
    expect(seen.busy).toBe("true");
    expect(seen.opacity).toBeLessThan(1);
    // Four more taps on the same side, and one on the other form: one answer per page.
    await page.evaluate(() => { const bs = [...document.querySelectorAll<HTMLButtonElement>("form.pick button")]; for (let i = 0; i < 4; i++) bs[0]!.click(); bs.at(-1)!.click(); });
    release();
    await page.waitForURL(/\/home/, { timeout: 30_000 });
    await page.waitForLoadState();
    expect(held).toBe(1);
    expect(posts).toBe(1);
    expect(await page.content()).not.toContain("Nothing to settle there any more");
    await b.close();
  } finally { r.stop(); }
}, 120_000);

test("an answer sent again for a question already settled is no error, and the answer does not wait for the page writer", async () => {
  process.env.PB_NOW = DEMO_NOW;
  try {
    const { root, conflicts } = await makeDemoBrain();
    const H = "127.0.0.1:8797";
    const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32) });
    const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
    const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
    const req = async (method: string, path: string, fields?: Record<string, string>) => {
      const body = fields ? new URLSearchParams(fields) : undefined;
      const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/home`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
      return { text: await r.text(), loc: r.headers.get("location") ?? "" };
    };
    const id = conflicts[0]!;
    const pg = await req("GET", `/settle/${id}`);
    const csrf = pg.text.match(/name="csrf" value="([^"]+)"/)![1]!;
    const { pageTextWaiting } = await import("../src/wiki");
    const first = await req("POST", "/action/settle-pick", { csrf, id, n: "1" });
    expect(first.loc).toContain("ok=");
    // The page's text is written after the answer, not in it.
    expect(pageTextWaiting(root)).toBe(true);
    const again = await req("POST", "/action/settle-pick", { csrf, id, n: "1" });
    expect(again.loc).toContain("ok=");
    expect(again.loc).not.toContain("err=");
    // Code review of PR 225: a request with no sign-in never runs the page writer.
    const key0 = (await import("../src/brain")).loadBrain(root).find((n) => n.fm.id === `disputes/${id}`)!.fm.fact_key as string;
    await d.handle(new Request(`http://${H}/p/${key0.split("#")[0]}`, { headers: { host: H } }));
    expect(pageTextWaiting(root)).toBe(true);
    // Opening a page writes it first, so its words never lag what was settled (G707).
    const key = (await import("../src/brain")).loadBrain(root).find((n) => n.fm.id === `disputes/${id}`)!.fm.fact_key as string;
    await req("GET", `/p/${key.split("#")[0]}`);
    expect(pageTextWaiting(root)).toBe(false);
    // And an owner answer from any other door (here the function itself, as the resolver's route
    // calls it) writes the pages in place: nothing is left waiting where no app screen would run it.
    const { ownerDecide, ownerConflicts } = await import("../src/core");
    const next = ownerConflicts(root, new Date(DEMO_NOW))[0];
    if (next) { ownerDecide(root, next.id, 1, "another-door"); expect(pageTextWaiting(root)).toBe(false); }
    expect(next).toBeDefined();
    // A question that never was is still an error.
    expect((await req("POST", "/action/settle-pick", { csrf, id: "c-9999", n: "1" })).loc).toContain("err=");
  } finally { delete process.env.PB_NOW; }
}, 120_000);
