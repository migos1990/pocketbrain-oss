// SPDX-License-Identifier: AGPL-3.0-only
// The home is the front door (audit v4, owner 2026-10-26): sign-in and "/" land on the home, the old
// overview moves to /overview, and every old page links back home.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { APP_COPY } from "../src/dashboard/html-app";

const H = "127.0.0.1:8796";
test("sign-in and / open the home; Settings (the overview) is on Who knows and links home", async () => {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: 8796, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  expect(r0.headers.get("location")).toBe("/");
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string) => (await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }))).text();
  const root_ = await get("/");
  expect(root_).toContain(`action="/say"`);
  expect(root_).not.toMatch(/to decide today/);
  expect(await get("/who")).toContain(`href="/overview">${APP_COPY.settings}`);
  const over = await get("/overview");
  expect(over).not.toMatch(/to decide today/);
  expect(over).toContain(`href="/"`);
  expect(over).toMatch(/<a[^>]*href="\/"[^>]*>Home<\/a>/);
  expect(await get("/home")).toContain(`action="/say"`);
});
