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
  for (const bad of [`http://mini.tail1234.ts.net:8788/login?key=${K}`, `${HUB}/login?key=short`, `${HUB}/home?key=${K}`, "hello", `pocketbrain://pair?key=${K}`, `pocketbrain://pair?hub=javascript:alert(1)&key=${K}`])
    expect("error" in parsePairLink(bad)).toBe(true);
  expect((parsePairLink(`http://mini.tail1234.ts.net:8788/login?key=${K}`) as { error: string }).error).toContain("https");
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
  expect(inject(false)).not.toContain("postMessage");
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
