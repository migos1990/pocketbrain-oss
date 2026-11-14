// SPDX-License-Identifier: AGPL-3.0-only
// See as over the owner's door: /see/<agent> and /see/<agent>/<page id> open on the 30-day sign-in
// like the page screen, with a private value shut until a fresh one; a name the rules don't hold,
// a page that isn't there and a signed-out caller get what any missing page gets.
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { write } from "../src/write";

const H = "127.0.0.1:8797";
function setup(root = makeBrain()) {
  let t = Date.parse("2026-10-08T15:00:00Z");
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32), now: () => new Date(t) });
  let cookie = "";
  const get = async (path: string) => {
    const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } }));
    return { status: r.status, text: await r.text() };
  };
  const login = async () => { const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } })); cookie = r.headers.get("set-cookie")!.split(";")[0]!; };
  return { root, get, login, later: (min: number) => { t += min * 60_000; } };
}

test("See as opens on the 30-day sign-in, keeps a private value shut until a fresh one, and logs no read", async () => {
  const { root, get, login, later } = setup();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "fee", value: "1200 dollars a year", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  expect((await get("/see/planner")).status).toBe(401);
  await login();
  const log = join(root, "log", "reads.jsonl"), before = existsSync(log) ? readFileSync(log, "utf8") : "";
  const list = await get("/see/planner");
  expect(list.status).toBe(200);
  expect(list.text).toContain('href="/see/planner/people/jane-roy"');
  const fresh = await get("/see/planner/people/jane-roy");
  expect(fresh.status).toBe(200);
  later(30);
  const old = await get("/see/planner/people/jane-roy");
  expect(old.status).toBe(200);
  expect(old.text).not.toContain("1200 dollars a year");
  expect((await get("/see/planner")).status).toBe(200);
  for (const p of ["/see/nobody", "/see/__proto__", "/see/constructor/people/jane-roy", "/see/planner/people/no-such-page"]) {
    const r = await get(p), missing = await get("/p/people/no-such-page");
    expect(r.status).toBe(missing.status);
    expect(r.text).toBe(missing.text);
  }
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(before);
});
