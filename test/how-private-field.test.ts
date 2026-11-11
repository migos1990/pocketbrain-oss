// SPDX-License-Identifier: AGPL-3.0-only
// "How private" on a page (Who sees this, Change who sees it): its field and its Save are drawn in
// the app's own look and are a full tap target, not the browser's small grey controls (G783,
// screens review pass 3).
import { test, expect } from "bun:test";
import { uiRig } from "./ui-rig";

let pw: typeof import("playwright") | undefined, browser: import("playwright").Browser | undefined;
try { pw = await import("playwright"); browser = await pw.chromium.launch(); } catch { browser = undefined; }

test("G783 How private: the field and Save are 44px tall and in the app's type", async () => {
  expect(browser).toBeDefined();
  const r = await uiRig({ busy: true });
  try {
    const c = await browser!.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", reducedMotion: "reduce" });
    const p = await c.newPage();
    await p.goto(r.loginUrl);
    await p.goto(`${r.dash}/p/people/helene-lefebvre`);
    await p.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));
    const look = (sel: string) => p.locator(sel).first().evaluate((e) => { const s = getComputedStyle(e), b = e.getBoundingClientRect(); return { h: b.height, size: parseFloat(s.fontSize), family: s.fontFamily, body: getComputedStyle(document.body).fontFamily, radius: s.borderRadius }; });
    const field = await look('#who select[name="sensitivity"]'), save = await look('#who form[action="/action/note-sensitivity"] button');
    for (const x of [field, save]) {
      expect(x.h).toBeGreaterThanOrEqual(44);
      expect(x.size).toBeGreaterThanOrEqual(15);
      expect(x.family).toBe(x.body);
    }
    expect(field.radius).toBe("0px");
    await c.close();
  } finally { r.stop(); }
}, 60000);
