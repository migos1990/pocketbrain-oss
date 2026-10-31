// SPDX-License-Identifier: AGPL-3.0-only
// One logo for every tab: dark bar on light tabs, white bar on dark ones.
import { test, expect } from "bun:test";
import { FAVICON } from "../src/favicon";
import { layout } from "../src/dashboard/html";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";

test("the dashboard and the browser door use the same favicon", () => {
  expect(decodeURIComponent(FAVICON)).toContain("prefers-color-scheme:dark");
  expect(layout({ root: makeBrain() }, { title: "x", tab: "overview", body: "" })).toContain(`<link rel="icon" href="${FAVICON}">`);
});

test("the dashboard's CSP lets the inline favicon load (Firefox applies img-src to tab icons)", async () => {
  const H = "127.0.0.1:8788";
  const d = dashboardHandler(makeBrain(), { port: 8788, loginKey: "k".repeat(32) });
  const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const page = await d.handle(new Request(`http://${H}/overview`, { headers: { host: H, cookie } }));
  expect(page.headers.get("content-security-policy")).toMatch(/img-src 'self' data:/);
});

test("the favicon has no raw # (a browser would cut the data URL at it) and decodes to a whole SVG", () => {
  expect(FAVICON).not.toContain("#");
  const svg = decodeURIComponent(FAVICON.slice("data:image/svg+xml,".length));
  expect(svg).toStartWith("<svg");
  expect(svg).toEndWith("</svg>");
  expect(svg).toContain("fill=\"#ff4f8b\"");
});
