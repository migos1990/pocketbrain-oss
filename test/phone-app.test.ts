// SPDX-License-Identifier: AGPL-3.0-only
// The phone app (docs/phone-app.md, owner 2026-11-01: "not dependent on the Safari experience").
// The app pairs once with a phone link (the same one-time, day-long link `dashboard phone-link`
// prints and the signed-out page texts) and gets a sign-in plus a device key it keeps behind Face
// ID. Later, Face ID and that key make the sign-in fresh again, instead of a texted link that opens
// in Safari. The hub keeps only the key's hash; neither key is ever written in clear, logged or
// echoed.
import { test, expect, afterEach } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler, mintPhoneLink, FRESH_MINUTES } from "../src/dashboard/server";
import { appPhones, removeAppPhones } from "../src/dashboard/phone-app";

const PORT = 8788;
const PHONE = "100.88.1.2";
const TN = { address: "100.101.102.103", name: "mini.tail1234.ts.net", login: "robin@example.com", devices: [PHONE] };
const H = `${TN.name}:${PORT}`;

function hub(root: string, clock = { t: Date.parse("2026-11-01T12:00:00Z") }) {
  const d = dashboardHandler(root, { port: PORT, now: () => new Date(clock.t) });
  d.setTailnet(TN, PORT);
  const call = (path: string, o: { method?: string; origin?: string; cookie?: string; json?: unknown; form?: Record<string, string>; peer?: string } = {}) =>
    d.handleTailnet(new Request(`http://${H}${path}`, {
      method: o.method ?? (o.json !== undefined || o.form ? "POST" : "GET"),
      body: o.json !== undefined ? JSON.stringify(o.json) : o.form ? new URLSearchParams(o.form) : undefined,
      headers: { host: H, ...(o.origin ? { origin: o.origin } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.json !== undefined ? { "content-type": "application/json" } : {}), ...(o.form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    }), o.peer ?? PHONE);
  const local = (path: string, json: unknown) => d.handle(new Request(`http://127.0.0.1:${PORT}${path}`, { method: "POST", body: JSON.stringify(json), headers: { host: `127.0.0.1:${PORT}`, "content-type": "application/json" } }));
  return { d, call, local, clock };
}
const cookieOf = (r: Response) => r.headers.get("set-cookie")?.match(/pb_owner=([A-Za-z0-9_-]+)/)?.[1];

// Everything the hub writes or prints during a test, to look for a key in clear.
const printed: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn };
for (const k of ["log", "error", "warn"] as const) console[k] = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); orig[k](...a); };
afterEach(() => { printed.length = 0; });
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => join(dir, f)).filter((p) => statSync(p).isFile());
}

test("a phone link pairs the app once: a sign-in and a device key, on the tailnet only", async () => {
  const root = makeBrain();
  const { call, local } = hub(root);
  const key = mintPhoneLink(root);
  const viaLoopback = await local("/app/pair", { key, name: "Robin's phone" });
  expect(viaLoopback.status).toBe(401); // never on loopback: it reads as signed out
  expect(viaLoopback.headers.get("set-cookie")).toBeNull();
  const r = await call("/app/pair", { json: { key, name: "Robin's phone" } });
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  const sid = cookieOf(r)!;
  expect(sid).toBeTruthy();
  expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  const body = await r.json() as { device: string };
  expect(body.device).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  expect(JSON.stringify(body)).not.toContain(key);
  expect((await call("/home", { cookie: `pb_owner=${sid}` })).status).toBe(200);
  // The link is spent, like the Sign in button spends it.
  expect((await call("/app/pair", { json: { key } })).status).toBe(403);
  expect(appPhones(root).map((p) => p.name)).toEqual(["Robin's phone"]);
});

test("pairing refuses another site's page, a bad body, and an unknown link alike", async () => {
  const root = makeBrain();
  const { call } = hub(root);
  const key = mintPhoneLink(root);
  expect((await call("/app/pair", { json: { key }, origin: "http://evil.example" })).status).toBe(403);
  expect((await call("/app/pair", { json: ["nope"] })).status).toBe(400);
  expect((await call("/app/pair", { json: { key: "x".repeat(5000) } })).status).toBe(413);
  expect((await call("/app/pair", { json: { key: "made-up" } })).status).toBe(403);
  expect((await call("/app/pair", { json: { key }, peer: "100.88.9.9" })).status).toBe(403); // not one of the owner's devices
  expect((await call("/app/pair", { json: { key }, origin: `http://${H}` })).status).toBe(200); // still unspent
});

test("Face ID makes a sign-in fresh again: the device key refreshes it past the 10 minutes", async () => {
  const root = makeBrain();
  const { call, clock } = hub(root);
  const pair = await call("/app/pair", { json: { key: mintPhoneLink(root) } });
  const sid = cookieOf(pair)!, { device } = await pair.json() as { device: string };
  clock.t += (FRESH_MINUTES + 5) * 60_000;
  const memory = async () => (await call("/memory", { cookie: `pb_owner=${sid}` })).text();
  const kept = () => JSON.parse(readFileSync(join(root, ".git", "pb-dashboard-sessions.json"), "utf8")) as Record<string, { at: string }>;
  const before = Object.values(kept())[0]!.at;
  const r = await call("/app/fresh", { json: { device }, cookie: `pb_owner=${sid}` });
  expect(r.status).toBe(200);
  expect(cookieOf(r)).toBe(sid); // the same sign-in, its 30 days counted again
  expect(Object.values(kept()).map((v) => v.at)).toEqual([new Date(clock.t).toISOString()]);
  expect(Date.parse(before)).toBeLessThan(clock.t);
  expect(await memory()).toBeTruthy();
  // A lapsed or missing sign-in: the key signs the paired phone in again, freshly.
  const again = await call("/app/fresh", { json: { device } });
  expect(again.status).toBe(200);
  const sid2 = cookieOf(again)!;
  expect(sid2).not.toBe(sid);
  expect((await call("/home", { cookie: `pb_owner=${sid2}` })).status).toBe(200);
  expect(appPhones(root)[0]!.last).toBe(new Date(clock.t).toISOString());
});

test("a key the hub doesn't know: no sign-in, one answer, and guessing is capped", async () => {
  const root = makeBrain();
  const { call } = hub(root);
  const bad = await call("/app/fresh", { json: { device: "a".repeat(32) } });
  expect(bad.status).toBe(401);
  expect(bad.headers.get("set-cookie")).toBeNull();
  const words = await bad.text();
  expect((await (await call("/app/fresh", { json: {} })).text())).toBe(words); // missing reads like wrong
  for (let i = 0; i < 8; i++) await call("/app/fresh", { json: { device: `b${i}`.repeat(20) } });
  expect((await call("/app/fresh", { json: { device: "c".repeat(32) } })).status).toBe(429);
  // A real key past the cap waits too: the cap is on the door, not the guesser's key.
  const pair = await call("/app/pair", { json: { key: mintPhoneLink(root) } });
  const { device } = await pair.json() as { device: string };
  expect((await call("/app/fresh", { json: { device } })).status).toBe(429);
  expect((await call("/app/fresh", { json: { device }, origin: "http://evil.example" })).status).toBe(403);
});

test("removing a phone ends its sign-ins and its key, after a hub restart too", async () => {
  const root = makeBrain();
  const first = hub(root);
  const pair = await first.call("/app/pair", { json: { key: mintPhoneLink(root), name: "old phone" } });
  const sid = cookieOf(pair)!, { device } = await pair.json() as { device: string };
  expect(removeAppPhones(root, "old phone")).toEqual(["old phone"]);
  expect(appPhones(root)).toEqual([]);
  const restarted = hub(root);
  expect((await restarted.call("/home", { cookie: `pb_owner=${sid}` })).status).toBe(401);
  expect((await restarted.call("/app/fresh", { json: { device } })).status).toBe(401);
  expect(removeAppPhones(root, "nobody")).toEqual([]);
});

test("neither the pairing key nor the device key is ever kept in clear, logged or printed", async () => {
  const root = makeBrain();
  const { call, clock } = hub(root);
  const key = mintPhoneLink(root);
  const pair = await call("/app/pair", { json: { key, name: "phone" } });
  const { device } = await pair.json() as { device: string };
  clock.t += 20 * 60_000;
  await call("/app/fresh", { json: { device } });
  await call("/app/fresh", { json: { device: device.slice(1) } });
  const kept = readFileSync(join(root, ".git", "pb-app-phones.json"), "utf8");
  expect(statSync(join(root, ".git", "pb-app-phones.json")).mode & 0o777).toBe(0o600);
  for (const f of filesUnder(root)) {
    const text = readFileSync(f).toString("latin1");
    expect(text.includes(device)).toBe(false);
    expect(text.includes(key)).toBe(false);
  }
  expect(kept).not.toContain(device);
  for (const line of printed) { expect(line).not.toContain(device); expect(line).not.toContain(key); }
});

test("the texted link's page offers to open the sign-in in the app", async () => {
  const root = makeBrain();
  const { call } = hub(root);
  const key = mintPhoneLink(root);
  const page = await (await call(`/login?key=${key}`)).text();
  expect(page).toContain(`href="pocketbrain://pair?hub=${encodeURIComponent(`http://${H}`)}&amp;key=${key}"`);
  expect(page).toContain("Open in the pocketBrain app");
});

test("pocketbrain dashboard phones lists paired phones by name, and removes one or all", async () => {
  const { main } = await import("../src/cli");
  const run = (root: string, ...args: string[]) => {
    const out: string[] = [];
    const log = console.log, err = console.error;
    console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
    console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
    let code: number;
    try { code = main([...args, "--brain", root]) as number; } finally { console.log = log; console.error = err; }
    return { code, out: out.join("\n") };
  };
  const root = makeBrain();
  expect(run(root, "dashboard", "phones").out).toContain("No phone is paired");
  const { call } = hub(root);
  const pair = await call("/app/pair", { json: { key: mintPhoneLink(root), name: "Robin's phone" } });
  const { device } = await pair.json() as { device: string };
  const list = run(root, "dashboard", "phones");
  expect(list.code).toBe(0);
  expect(list.out).toContain("Robin's phone");
  expect(list.out).not.toContain(device);
  expect(run(root, "dashboard", "phones", "remove", "someone else").code).toBe(1);
  const rm = run(root, "dashboard", "phones", "remove", "Robin's phone");
  expect(rm.code).toBe(0);
  expect(rm.out).toContain("Removed Robin's phone");
  expect(appPhones(root)).toEqual([]);
});
