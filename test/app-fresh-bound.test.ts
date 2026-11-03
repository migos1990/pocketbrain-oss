// SPDX-License-Identifier: AGPL-3.0-only
// Audit v11 High 1 (G642): the phone app's "Face ID makes a sign-in fresh" was a hub-side bearer.
// The device key alone made any cookie, or no cookie at all, a fresh owner sign-in, forever, with no
// nonce, cap or CSRF guard, and every use counted the 30 days again. Now the fresh door only takes
// the app's own request (no Origin, its header), on a live sign-in that phone made, with a one-time
// nonce, a few times an hour, and never moves the 30 days.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import * as server from "../src/dashboard/server";
import * as phoneApp from "../src/dashboard/phone-app";

const { dashboardHandler, mintPhoneLink, FRESH_MINUTES } = server;
const APP_HEADER: string = (server as Record<string, unknown>).APP_HEADER as string ?? "x-pocketbrain-app";
const APP_FRESH_PER_HOUR: number = (phoneApp as Record<string, unknown>).APP_FRESH_PER_HOUR as number ?? 12;

const PORT = 8788;
const PHONE = "100.88.1.2";
const TN = { address: "100.101.102.103", name: "mini.tail1234.ts.net", login: "robin@example.com", devices: [PHONE] };
const H = `${TN.name}:${PORT}`;

function hub(root: string) {
  const clock = { t: Date.parse("2026-11-01T12:00:00Z") };
  const d = dashboardHandler(root, { port: PORT, now: () => new Date(clock.t) });
  d.setTailnet(TN, PORT);
  const call = (path: string, o: { cookie?: string; json?: unknown; origin?: string; app?: boolean; form?: Record<string, string> } = {}) =>
    d.handleTailnet(new Request(`http://${H}${path}`, {
      method: o.json !== undefined || o.form ? "POST" : "GET",
      body: o.json !== undefined ? JSON.stringify(o.json) : o.form ? new URLSearchParams(o.form) : undefined,
      headers: { host: H, ...(o.origin ? { origin: o.origin } : {}), ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.app === false ? {} : { [APP_HEADER]: "1" }), ...(o.json !== undefined ? { "content-type": "application/json" } : {}), ...(o.form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    }), PHONE);
  return { call, clock };
}
const cookieOf = (r: Response) => r.headers.get("set-cookie")?.match(/pb_owner=([A-Za-z0-9_-]+)/)?.[1];

async function paired(root: string, h: ReturnType<typeof hub>) {
  const pair = await h.call("/app/pair", { json: { key: mintPhoneLink(root), name: "phone" } });
  return { sid: cookieOf(pair)!, device: ((await pair.json()) as { device: string }).device };
}
async function nonceFor(h: ReturnType<typeof hub>, sid: string) {
  const r = await h.call("/app/nonce", { json: {}, cookie: `pb_owner=${sid}` });
  return r.status === 200 ? ((await r.json()) as { nonce: string }).nonce : "";
}
const isSignedIn = async (h: ReturnType<typeof hub>, sid: string) => (await h.call("/home", { cookie: `pb_owner=${sid}` })).status === 200;

test("the device key alone never makes a sign-in: no cookie gets nothing", async () => {
  const root = makeBrain();
  const h = hub(root);
  const { device } = await paired(root, h);
  h.clock.t += (FRESH_MINUTES + 5) * 60_000;
  const r = await h.call("/app/fresh", { json: { device } });
  expect(r.status).toBe(401);
  expect(r.headers.get("set-cookie")).toBeNull();
});

test("the device key never makes another sign-in fresh, only one its own phone made", async () => {
  const root = makeBrain();
  const h = hub(root);
  const { device } = await paired(root, h);
  // A second sign-in (another phone's, or a browser's): the first phone's key can't touch it.
  const other = await paired(root, h);
  h.clock.t += (FRESH_MINUTES + 5) * 60_000;
  const r = await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, other.sid) }, cookie: `pb_owner=${other.sid}` });
  expect(r.status).toBe(401);
});

test("a fresh sign-in takes a one-time nonce the hub gave that sign-in", async () => {
  const root = makeBrain();
  const h = hub(root);
  const { sid, device } = await paired(root, h);
  h.clock.t += (FRESH_MINUTES + 5) * 60_000;
  const cookie = `pb_owner=${sid}`;
  expect((await h.call("/app/fresh", { json: { device }, cookie })).status).toBe(403);
  const nonce = await nonceFor(h, sid);
  expect(nonce).toBeTruthy();
  const ok = await h.call("/app/fresh", { json: { device, nonce }, cookie });
  expect(ok.status).toBe(200);
  expect(ok.headers.get("set-cookie")).toBeNull(); // the 30 days aren't counted again
  expect((await h.call("/app/fresh", { json: { device, nonce }, cookie })).status).toBe(403); // spent
  // Another sign-in's nonce, or one past two minutes, is refused too.
  const other = await paired(root, h);
  expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, other.sid) }, cookie })).status).toBe(403);
  const late = await nonceFor(h, sid);
  h.clock.t += 3 * 60_000;
  expect((await h.call("/app/fresh", { json: { device, nonce: late }, cookie })).status).toBe(403);
});

test("only the app's own request: any Origin, the hub's too, or no app header is refused", async () => {
  const root = makeBrain();
  const h = hub(root);
  const { sid, device } = await paired(root, h);
  const cookie = `pb_owner=${sid}`;
  expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, sid) }, cookie, origin: `http://${H}` })).status).toBe(403);
  expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, sid) }, cookie, app: false })).status).toBe(403);
  expect((await h.call("/app/nonce", { json: {}, cookie, origin: `http://${H}` })).status).toBe(403);
});

test("Face ID never moves the 30 days: the sign-in still ends 30 days after pairing", async () => {
  const root = makeBrain();
  const h = hub(root);
  const { sid, device } = await paired(root, h);
  const cookie = `pb_owner=${sid}`;
  h.clock.t += 29 * 86_400_000;
  expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, sid) }, cookie })).status).toBe(200);
  h.clock.t += 2 * 86_400_000;
  expect(await isSignedIn(h, sid)).toBe(false);
  expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, sid) }, cookie })).status).toBe(401);
});

test("one phone makes its sign-in fresh at most a few times an hour", async () => {
  const root = makeBrain();
  const h = hub(root);
  const { sid, device } = await paired(root, h);
  const cookie = `pb_owner=${sid}`;
  for (let i = 0; i < APP_FRESH_PER_HOUR; i++) expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, sid) }, cookie })).status).toBe(200);
  expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, sid) }, cookie })).status).toBe(429);
  h.clock.t += 61 * 60_000;
  expect((await h.call("/app/fresh", { json: { device, nonce: await nonceFor(h, sid) }, cookie })).status).toBe(200);
});
