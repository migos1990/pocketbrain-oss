// SPDX-License-Identifier: AGPL-3.0-only
// The dashboard's background requests (the Map and FGA grids poll every 2 s) aren't the owner's
// time, the owner-time log stays bounded, and odd POSTs get a 4xx instead of a 500.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8788";
async function setup() {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const get = (path: string, headers: Record<string, string> = {}) => d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie, ...headers } }));
  const post = (path: string, body: string, headers: Record<string, string>) => d.handle(new Request(`http://${H}${path}`, { method: "POST", body, headers: { host: H, cookie, origin: `http://${H}`, ...headers } }));
  const lines = () => { try { return readFileSync(join(root, "log", "owner-time.jsonl"), "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  return { get, post, lines };
}

test("background polls and fetches don't count as the owner's time", async () => {
  const { get, lines } = await setup();
  const before = lines();
  for (let i = 0; i < 30; i++) await get("/map/grid");
  for (let i = 0; i < 5; i++) await get("/fga/grid");
  await get("/brain/results?q=x", { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
  expect(lines()).toBe(before);
});

test("page loads count, but at most one line a minute however many pages are opened", async () => {
  const { get, lines } = await setup();
  // The cap is per wall-clock minute (server.ts): start well inside one, so the loads can't straddle two.
  const s = new Date().getSeconds();
  if (s >= 50) await Bun.sleep((61 - s) * 1000);
  const before = lines();
  for (let i = 0; i < 20; i++) await get(i % 2 ? "/agents" : "/", { "sec-fetch-mode": "navigate" });
  expect(lines() - before).toBe(1);
}, 20_000);

test("a POST that isn't a form, or has a malformed Referer, gets a 4xx, not a 500", async () => {
  const { get, post } = await setup();
  const csrf = (await (await get("/overview")).text()).match(/name="csrf" value="([^"]+)"/)![1];
  expect((await post("/action/x", "{}", { "content-type": "application/json" })).status).toBe(400);
  expect((await post("/action/x", "x", {})).status).toBeLessThan(500);
  const bad = await post("/action/nope", `csrf=${csrf}`, { referer: "not a url", "content-type": "application/x-www-form-urlencoded" });
  expect(bad.status).toBeLessThan(500);
});
