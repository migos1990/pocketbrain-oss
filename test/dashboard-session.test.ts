// SPDX-License-Identifier: AGPL-3.0-only
// The owner's dashboard sign-in outlives a hub restart: a restart (an update, a key change) used to
// end it, and the owner met "not signed in" the next morning. The session is kept on disk under
// .git/, hashed, so the file alone signs nobody in; the login link itself still changes each start.
import { test, expect } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8791";
const get = (d: ReturnType<typeof dashboardHandler>, path: string, cookie = "") => d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));

test("a dashboard sign-in still works after the hub restarts; the old login link doesn't", async () => {
  const root = makeBrain();
  const first = dashboardHandler(root, { port: 8791, loginKey: "a".repeat(32) });
  const r = await get(first, `/login?key=${"a".repeat(32)}`);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const page = await (await get(first, "/home", cookie)).text();
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1];

  // The hub restarts: a new handler with a new login key, same brain.
  const second = dashboardHandler(root, { port: 8791, loginKey: "b".repeat(32) });
  const again = await get(second, "/home", cookie);
  expect(again.status).toBe(200);
  expect((await again.text()).match(/name="csrf" value="([^"]+)"/)![1]).toBe(csrf);
  expect((await get(second, `/login?key=${"a".repeat(32)}`)).status).not.toBe(303);
  expect((await get(second, "/brain", "pb_owner=made-up")).status).toBe(401);

  // What's on disk can't be replayed as a cookie, and only the owner can read it.
  const file = join(root, ".git", "pb-dashboard-sessions.json");
  expect(readFileSync(file, "utf8")).not.toContain(cookie.split("=")[1]);
  expect(statSync(file).mode & 0o077).toBe(0);
});

test("a kept sign-in lapses after 30 days", async () => {
  const root = makeBrain();
  const first = dashboardHandler(root, { port: 8791, loginKey: "a".repeat(32), now: () => new Date("2026-10-01T00:00:00Z") });
  const cookie = (await get(first, `/login?key=${"a".repeat(32)}`)).headers.get("set-cookie")!.split(";")[0];
  const later = dashboardHandler(root, { port: 8791, loginKey: "b".repeat(32), now: () => new Date("2026-11-01T00:00:00Z") });
  expect((await get(later, "/brain", cookie)).status).toBe(401);
});
