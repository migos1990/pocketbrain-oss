// SPDX-License-Identifier: AGPL-3.0-only
// The phone app's own logic (mobile/src, docs/phone-app.md), run in the hub's test suite: what it
// accepts as a phone link, and how it reads the hub's answers to pair and fresh.
import { test, expect } from "bun:test";
import { parsePairLink } from "../mobile/src/pair";
import { pair, fresh } from "../mobile/src/hub";
import { inject } from "../mobile/src/inject";

const K = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const HUB = "https://mini.tail1234.ts.net:8443";

test("a phone link: the app button's and the texted one, https only, whole key only", () => {
  expect(parsePairLink(`pocketbrain://pair?hub=${encodeURIComponent(HUB)}&key=${K}`)).toEqual({ hub: HUB, key: K });
  expect(parsePairLink(`  ${HUB}/login?key=${K}\n`)).toEqual({ hub: HUB, key: K });
  expect(parsePairLink(`pocketbrain://pair?hub=${encodeURIComponent(`${HUB}/evil/path`)}&key=${K}`)).toEqual({ hub: HUB, key: K }); // origin only
  for (const bad of [`http://100.88.1.2:8788/login?key=${K}`, `http://hub.example.com/login?key=${K}`, `${HUB}/login?key=short`, `${HUB}/home?key=${K}`, "hello", `pocketbrain://pair?key=${K}`, `pocketbrain://pair?hub=javascript:alert(1)&key=${K}`])
    expect("error" in parsePairLink(bad)).toBe(true);
  expect((parsePairLink(`http://100.88.1.2:8788/login?key=${K}`) as { error: string }).error).toContain("https");
});

test("the pair screen takes what the owner pastes: a tailnet name's plain link goes to its https door, and a whole text message gives up its link", () => {
  // The Terminal's old link (2026-11-02): the tailnet listener's http address. Its name has an
  // https door on 8443 (tailscale serve), so the app pairs there; an address without a name can't.
  expect(parsePairLink(`http://mini.tail1234.ts.net:8788/login?key=${K}`)).toEqual({ hub: HUB, key: K });
  expect(parsePairLink(`pocketbrain://pair?hub=${encodeURIComponent("http://mini.tail1234.ts.net:8788")}&key=${K}`)).toEqual({ hub: HUB, key: K });
  // The texted sign-in message pasted whole.
  expect(parsePairLink(`pocketBrain sign-in link for your phone (works once, for a day): ${HUB}/login?key=${K}`)).toEqual({ hub: HUB, key: K });
  expect(parsePairLink(`open on your phone or paste in the pocketBrain app (works once, for a day): ${HUB}/login?key=${K}.`)).toEqual({ hub: HUB, key: K });
});

const answer = (status: number, body: unknown) => async () => ({ status, json: async () => body, text: async () => typeof body === "string" ? body : JSON.stringify(body) });

test("pair and fresh read the hub's answers; the key goes only in the body, to the hub's own address", async () => {
  const seen: { url: string; body: string }[] = [];
  const f = async (url: string, init: { body: string }) => { seen.push({ url, body: init.body }); return answer(200, { device: "d".repeat(43) })(); };
  expect(await pair(f as never, HUB, K, "phone")).toEqual({ device: "d".repeat(43) });
  expect(seen[0]).toEqual({ url: `${HUB}/app/pair`, body: JSON.stringify({ key: K, name: "phone" }) });
  expect(await pair(answer(403, "This sign-in link was already used\nFix: …") as never, HUB, K, "phone")).toEqual({ error: "This sign-in link was already used", status: 403 });
  expect(await pair(answer(200, {}) as never, HUB, K, "phone")).toMatchObject({ status: 502 });
  expect(await fresh(answer(200, { fresh: true }) as never, HUB, "d")).toBe("fresh");
  expect(await fresh(answer(401, "no") as never, HUB, "d")).toBe("unpaired");
  expect(await fresh(answer(429, "wait") as never, HUB, "d")).toBe("wait");
  expect(await fresh((async () => { throw new Error("offline"); }) as never, HUB, "d")).toBe("offline");
});

test("in a page, Sign in again and a signed-out page ask the app for Face ID, and nothing else", () => {
  const on = inject(true);
  expect(on).toContain('"/action/sign-in-again"');
  expect(on).toContain('form[action="/send-link"]');
  expect(on).not.toMatch(/cookie|innerText|textContent|fetch\(/);
  // Face ID cancelled or a sign-in that didn't stick: the page's own buttons work, nothing asks again.
  expect(inject(false)).not.toContain('"fresh"');
});

test("the app icon is the logo with the film's eyes: Night tile, full bleed, and the checked-in images match", async () => {
  const { iconSvg, MARK } = await import("../mobile/src/logo");
  const { readFileSync } = await import("node:fs");
  const tile = iconSvg("icon");
  expect(tile).toContain(`fill="${MARK.night}"`); // the tile is Night
  expect(tile).not.toContain("rx=\"22"); // the phone rounds the corners, never the image
  expect(MARK.eyes.length).toBe(2);
  for (const e of MARK.eyes) expect(Math.abs(e.cy - (MARK.bar.y + MARK.bar.h / 2))).toBeLessThan(1.5); // the eyes sit on the bar
  expect(iconSvg("adaptive")).not.toContain(`<rect width="100"`); expect(tile).toContain(`<rect width="100" height="100" fill="${MARK.night}"/>`); // Android's foreground is see-through
  const png = (f: string) => { const b = readFileSync(`mobile/assets/${f}`); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }; };
  expect(png("icon.png")).toEqual({ w: 1024, h: 1024, colorType: 2 }); // RGB: the App Store refuses an icon with alpha
  expect(png("adaptive-icon.png")).toMatchObject({ w: 1024, h: 1024, colorType: 6 });
  expect(png("splash-icon.png")).toMatchObject({ w: 1024, h: 1024, colorType: 6 });
  const config = (require("../mobile/app.config.js") as { expo: Record<string, any> }).expo;
  expect(config.icon).toBe("./assets/icon.png");
  expect(config.android.adaptiveIcon).toEqual({ foregroundImage: "./assets/adaptive-icon.png", backgroundColor: MARK.night });
  expect(config.splash).toMatchObject({ image: "./assets/splash-icon.png", backgroundColor: MARK.night });
});

test("the app builds under the owner's Expo project, and a copy on another account names its own", () => {
  const path = require.resolve("../mobile/app.config.js");
  const load = () => { delete require.cache[path]; return (require(path) as { expo: { extra: { eas?: { projectId?: string } } } }).expo.extra.eas?.projectId; };
  const before = process.env.EAS_PROJECT_ID;
  try {
    delete process.env.EAS_PROJECT_ID;
    expect(load()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    process.env.EAS_PROJECT_ID = "00000000-0000-4000-8000-000000000000";
    expect(load()).toBe("00000000-0000-4000-8000-000000000000");
  } finally { if (before === undefined) delete process.env.EAS_PROJECT_ID; else process.env.EAS_PROJECT_ID = before; delete require.cache[path]; }
});

test("a build names an update channel only when the app has expo-updates, so eas build never stops to ask", async () => {
  const { readFileSync } = await import("node:fs");
  const eas = JSON.parse(readFileSync("mobile/eas.json", "utf8")) as { build: Record<string, { channel?: string }> };
  const deps = (JSON.parse(readFileSync("mobile/package.json", "utf8")) as { dependencies: Record<string, string> }).dependencies;
  for (const [name, profile] of Object.entries(eas.build))
    if (profile.channel) expect(`${name}: expo-updates ${deps["expo-updates"] ? "present" : "missing"}`).toBe(`${name}: expo-updates present`);
});

test("the page never stays blank: iOS unloading it, a failed load or an empty page reloads once, then shows Try again (owner, 2026-11-02)", async () => {
  const { pageStep, START } = await import("../mobile/src/page");
  // What the owner hit: back from the background, iOS had dropped the page and the app showed paper.
  let r = pageStep({ ...START, phase: "shown" }, { kind: "gone" });
  expect(r).toMatchObject({ reload: true, state: { phase: "loading" } });
  // A load that fails (Tailscale off, hub down) shows the brand screen with Try again, never paper.
  r = pageStep(START, { kind: "error" });
  expect(r).toMatchObject({ reload: false, state: { phase: "failed" } });
  expect(pageStep(r.state, { kind: "retry" })).toMatchObject({ reload: true, state: { phase: "loading", tries: 0 } });
  expect(pageStep(START, { kind: "http", status: 502 }).state.phase).toBe("failed");
  // The hub's own signed-out page (401) is a real page: the app's Face ID script takes it from there.
  expect(pageStep(START, { kind: "http", status: 401 }).state.phase).toBe("loading");
  // A page that loaded but drew nothing: one quiet reload, then Try again.
  r = pageStep(START, { kind: "loaded", blank: true });
  expect(r).toMatchObject({ reload: true, state: { tries: 1 } });
  expect(pageStep(r.state, { kind: "loaded", blank: true }).state.phase).toBe("failed");
  expect(pageStep(r.state, { kind: "loaded", blank: false })).toMatchObject({ reload: false, state: { phase: "shown", tries: 0 } });
  // Back from the background: a failed page, or one left for over 10 minutes, loads again.
  const away = pageStep({ ...START, phase: "shown" }, { kind: "background", at: 0 }).state;
  expect(pageStep(away, { kind: "foreground", at: 60_000 }).reload).toBe(false);
  expect(pageStep(away, { kind: "foreground", at: 11 * 60_000 }).reload).toBe(true);
  const failedAway = pageStep({ ...START, phase: "failed" }, { kind: "background", at: 0 }).state;
  expect(pageStep(failedAway, { kind: "foreground", at: 1000 }).reload).toBe(true);
});

test("each page tells the app whether it drew anything, and nothing else", () => {
  for (const on of [true, false]) {
    const js = inject(on);
    expect(js).toContain('postMessage(document.body && document.body.childElementCount ? "ready" : "blank")');
    expect(js).not.toMatch(/cookie|innerText|textContent|fetch\(/);
  }
});

test("the shell around the page is Night until the page is shown, so the opening logo has no paper bars (owner, 2026-11-02)", async () => {
  const { shell } = await import("../mobile/src/page");
  const { MARK } = await import("../mobile/src/logo");
  // What the owner saw: the Night logo with a paper bar under the status bar and one at the bottom.
  expect(shell("loading")).toEqual({ background: MARK.night, bar: "light-content" });
  expect(shell("failed")).toEqual({ background: MARK.night, bar: "light-content" });
  expect(shell("shown")).toEqual({ background: MARK.paper, bar: "dark-content" });
});

test("JS-only changes reach the phone over the air, and only builds with the same native code take them (owner, 2026-11-02)", async () => {
  process.env.APP_ENV = "production";
  const { expo } = require("../mobile/app.config.js") as { expo: Record<string, any> };
  // An update is matched to builds by a fingerprint of the native code, so a JS bundle can never
  // land on a build missing a native module it needs (expo-clipboard, 2026-11-02).
  expect(expo.runtimeVersion).toEqual({ policy: "fingerprint" });
  expect(expo.updates.url).toBe(`https://u.expo.dev/${expo.extra.eas.projectId}`);
  // Launch never waits on the network: the app opens what it has and takes a new update next launch.
  expect(expo.updates.fallbackToCacheTimeout).toBe(0);
  const eas = JSON.parse(require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../mobile/eas.json"), "utf8"));
  expect(eas.build.production.channel).toBe("production");
  expect(eas.build.preview.channel).toBe("preview");
  const pkg = JSON.parse(require("node:fs").readFileSync(require("node:path").join(import.meta.dir, "../mobile/package.json"), "utf8"));
  expect(pkg.dependencies["expo-updates"]).toBeTruthy();
  expect(pkg.scripts["update:production"]).toBe("APP_ENV=production eas update --channel production --environment production");
});

test("an unpaired phone first asks whether pocketBrain is on a computer yet, and a paired phone never sees that (owner, 2026-11-02)", async () => {
  const { firstScreen, INSTALL_COMMAND, shareText } = await import("../mobile/src/first");
  expect(firstScreen("https://mini.tail1234.ts.net:8443", undefined)).toBe("page");
  expect(firstScreen("https://mini.tail1234.ts.net:8443", "not-yet")).toBe("page");
  expect(firstScreen(null, undefined)).toBe("welcome");
  expect(firstScreen(null, "not-yet")).toBe("steps");
  expect(firstScreen(null, "have")).toBe("pair");
  expect(INSTALL_COMMAND).toBe("curl -fsSL https://pocketbrain.dev/install.sh | sh");
  // Sent from the phone's own share sheet: the steps in words, nothing sent by us.
  const t = shareText();
  expect(t).toContain(INSTALL_COMMAND);
  expect(t).toContain("pocketbrain init");
  expect(t).toContain("pocketbrain dashboard phone-link");
  expect(t).toContain("https://pocketbrain.dev");
  expect(t).not.toContain("pocketbrain.dev/start"); // no such page
});

test("the brain has two legs and three poses, drawn inside the mark's square, and the icon keeps no legs (owner, 2026-11-02)", async () => {
  const { MARK, LEGS, POSES, iconSvg, segBox } = await import("../mobile/src/logo");
  expect(POSES).toEqual(["stand", "step", "sit"]);
  for (const p of POSES) {
    const { body, segs } = LEGS[p];
    expect(segs).toHaveLength(4); // two legs, each a shin and a foot
    for (const [x1, y1, x2, y2] of segs) for (const [x, y] of [[x1, y1 + body], [x2, y2 + body]]) {
      // A leg never leaves the 64-unit square, so a screen's layout doesn't move when it gets legs.
      expect(x).toBeGreaterThanOrEqual(MARK.legs.w / 2); expect(x).toBeLessThanOrEqual(64 - MARK.legs.w / 2);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(64 - MARK.legs.w / 2);
    }
  }
  // Standing: both feet on one floor, pointing right.
  expect(LEGS.stand.segs.map((s) => s[3])).toEqual([62, 62, 62, 62]);
  // A segment drawn as a rotated rounded box: centre, length with its round caps, and angle.
  expect(segBox([26, 52, 26, 62], 2)).toEqual({ cx: 26, cy: 57, len: 12, deg: 90 });
  expect(segBox([26, 62, 31, 62], 2)).toEqual({ cx: 28.5, cy: 62, len: 7, deg: 0 });
  expect(iconSvg("icon")).not.toContain("<line"); // icon and splash unchanged
});

test("pulling the page down from the top loads it again, with a GET, and only past the threshold (owner, 2026-11-03)", async () => {
  // What the owner saw: the built-in pull to refresh left its spinner up and the page never loaded again.
  const { chromium } = await import("playwright");
  const b = await chromium.launch();
  try {
    const page = await (await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
    let gets = 0;
    await page.route("https://hub.test/**", (r) => { if (r.request().method() === "GET") gets++; r.fulfill({ contentType: "text/html", body: `<main style="height:2000px">page</main><textarea id="t"></textarea>` }); });
    await page.goto("https://hub.test/home");
    await page.evaluate(`window.ReactNativeWebView = { postMessage() {} }; ${inject(true)}`);
    const pull = (dy: number, sel = "main") => page.evaluate(([dy, sel]) => {
      const el = document.querySelector(sel as string)!;
      const t = (y: number) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
      el.dispatchEvent(new TouchEvent("touchstart", { touches: [t(100)], bubbles: true }));
      el.dispatchEvent(new TouchEvent("touchmove", { touches: [t(100 + (dy as number))], bubbles: true }));
      el.dispatchEvent(new TouchEvent("touchend", { changedTouches: [t(100 + (dy as number))], bubbles: true }));
    }, [dy, sel] as const);
    expect(gets).toBe(1);
    await pull(40); // a small pull does nothing
    await page.waitForTimeout(200);
    expect(gets).toBe(1);
    await pull(60, "#t"); // nor does a pull inside the text box
    await page.waitForTimeout(200);
    expect(gets).toBe(1);
    await pull(120);
    await page.waitForLoadState("load");
    await page.waitForTimeout(200);
    expect(gets).toBe(2);
    expect(page.url()).toBe("https://hub.test/home");
  } finally { await b.close(); }
}, 30_000);

test("the app's own pull to refresh replaces the built-in one, which left its spinner up", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  expect(readFileSync(join(import.meta.dir, "..", "mobile", "App.tsx"), "utf8")).not.toContain("pullToRefreshEnabled");
});
