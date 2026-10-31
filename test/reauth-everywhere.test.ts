// SPDX-License-Identifier: AGPL-3.0-only
// Audit v5 (2026-10-27): the 10-minute re-sign-in held only on /p. The edit page, the brain search
// and Settings rendered private values on the 30-day cookie. Now every page but the three owner
// screens (/home, /p, /settle) opens only within 10 minutes of signing in, and offers Sign in again.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { write } from "../src/write";

const H = "127.0.0.1:8793";
const SECRET_LOOKING = "Rimouski-Est";

async function setup() {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "home_town", value: SECRET_LOOKING, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
  let t = Date.parse("2026-10-08T15:00:00Z");
  const d = dashboardHandler(root, { port: 8793, loginKey: "k".repeat(32), now: () => new Date(t) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string) => { const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } })); return { status: r.status, text: await r.text() }; };
  return { get, later: (min: number) => { t += min * 60_000; } };
}

const OLD_PAGES = ["/note/people/jane-roy", "/brain?q=Rimouski", "/brain/results?q=Rimouski", "/overview", "/why/people/jane-roy?fact=home_town", "/history/people/jane-roy", "/map", "/activity"];

test("past 10 minutes, every page but the three owner screens asks to sign in again and shows no value", async () => {
  const { get, later } = await setup();
  // Fresh: the edit page shows the private value.
  expect((await get("/note/people/jane-roy")).text).toContain(SECRET_LOOKING);
  later(11);
  for (const p of OLD_PAGES) {
    const r = await get(p);
    expect(r.text, p).not.toContain(SECRET_LOOKING);
    expect(r.text, p).toContain(`action="/action/sign-in-again"`);
  }
  // The owner screens stay open on the 30-day sign-in, values shut as before.
  expect((await get("/home")).status).toBe(200);
  const page = await get("/p/people/jane-roy");
  expect(page.status).toBe(200);
  expect(page.text).not.toContain(SECRET_LOOKING);
});
