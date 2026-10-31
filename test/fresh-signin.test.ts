// SPDX-License-Identifier: AGPL-3.0-only
// A fresh sign-in for what can't be taken back or shouldn't show on a borrowed phone (phone UI spec
// §8, audit v4): forgetting from the box, a private or held value on a page, and Show need a sign-in
// from the last 10 minutes; past that the screen offers "Sign in again" instead. The smallest honest
// step under the freeze: the dashboard's own sign-in, asked again; no WebAuthn yet.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { write } from "../src/write";
import { loadBrain } from "../src/brain";
import { ownerSay } from "../src/owner-say";

const H = "127.0.0.1:8797";
function setup(root = makeBrain()) {
  let t = Date.parse("2026-10-08T15:00:00Z");
  const d = dashboardHandler(root, { port: 8797, loginKey: "k".repeat(32), now: () => new Date(t) });
  let cookie = "";
  const req = async (method: string, path: string, fields?: Record<string, string>) => {
    const body = fields ? new URLSearchParams(fields) : undefined;
    const r = await d.handle(new Request(`http://${H}${path}`, { method, body, headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) } }));
    return { status: r.status, text: await r.text(), loc: r.headers.get("location") ?? "" };
  };
  const login = async () => { const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } })); cookie = r.headers.get("set-cookie")!.split(";")[0]!; };
  const csrf = async () => (await req("GET", "/")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
  return { root, req, login, csrf, later: (min: number) => { t += min * 60_000; } };
}

test("'yes, forget' forgets only after a fresh sign-in; otherwise it offers Sign in again", async () => {
  const { root, req, login, csrf, later } = setup();
  await login();
  expect(ownerSay(root, "forget Paul Advisor").kind).toBe("say.forget-confirm");
  later(30);
  const stale = await req("POST", "/say", { csrf: await csrf(), q: "yes, forget Paul Advisor" });
  expect(stale.text).toContain("Sign in again");
  expect(stale.text).toContain(`action="/action/sign-in-again"`);
  expect(loadBrain(root).some((n) => n.fm.id === "people/paul-advisor")).toBe(true);
  const out = await req("POST", "/action/sign-in-again", { csrf: await csrf() });
  expect(out.status).toBe(303);
  expect((await req("GET", "/")).status).toBe(401);
  await login();
  const yes = await req("POST", "/say", { csrf: await csrf(), q: "yes, forget Paul Advisor" });
  expect(yes.text).toContain("Forgotten: Paul Advisor");
  expect(loadBrain(root).some((n) => n.fm.id === "people/paul-advisor")).toBe(false);
});

test("a private or held value on a page needs a fresh sign-in; Show does too", async () => {
  const { root, req, login, csrf, later } = setup();
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "fee", value: "1200 dollars a year", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
  await login();
  expect((await req("GET", "/p/people/jane-roy")).text).toContain("1200 dollars a year");
  later(30);
  const page = (await req("GET", "/p/people/jane-roy")).text;
  expect(page).not.toContain("1200 dollars a year");
  expect(page).toContain(`action="/action/sign-in-again"`);
  const show = await req("POST", "/action/diary-seen", { csrf: await csrf(), key: "people/jane-roy#fee" });
  expect(decodeURIComponent(show.loc)).not.toContain("1200");
  expect(flashOf(show.loc).err).toContain("Sign in again");
});
