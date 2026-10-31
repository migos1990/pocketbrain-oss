// SPDX-License-Identifier: AGPL-3.0-only
// Slice audit of owner app step 1: /memory opens on the 30-day sign-in, but its search ranks over the
// owner's full view, values included. /p hides a private or held value past 10 minutes; a search for
// a guessed value must not confirm it by which pages come back.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { dashboardHandler } from "../src/dashboard/server";

const H = "127.0.0.1:8797";
async function setup() {
  const root = makeBrain();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "home_town", value: "Rimouski-Est", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never);
  let t = Date.parse("2026-10-08T15:00:00Z");
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32), now: () => new Date(t) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  const found = async (q: string) => [...(await (await d.handle(new Request(`http://${H}/memory?q=${encodeURIComponent(q)}`, { headers: { host: H, cookie } }))).text()).matchAll(/href="\/p\/([^"]+)"/g)].map((m) => m[1]);
  return { found, later: (min: number) => { t += min * 60_000; } };
}

test("past 10 minutes, Memory's search can't confirm a private value or a held one", async () => {
  const { found, later } = await setup();
  later(11);
  // money/main-bank's bank is private ("Maple Trust Bank"); /p hides it on this sign-in.
  expect(await found("Maple")).toEqual(await found("Walnut"));
  // Jane Roy's home town is held (unseen) for the owner's Show.
  expect(await found("Rimouski")).toEqual(await found("Trois-Rivieres"));
});

test("right after a sign-in the search still finds them", async () => {
  const { found } = await setup();
  expect(await found("Maple")).toContain("money/main-bank");
  expect(await found("Rimouski")).toContain("people/jane-roy");
});
