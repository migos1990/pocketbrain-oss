// SPDX-License-Identifier: AGPL-3.0-only
// Slice audit of PR #42 (tree aa497751). Drop into test/ and run alone.
// Removing a paired phone from the CLI while the hub runs: the phone's cookie keeps its sign-in until restart.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { dashboardHandler, mintPhoneLink, APP_HEADER } from "../src/dashboard/server";
import { removeAppPhones } from "../src/dashboard/phone-app";

const PORT = 8788, PHONE = "100.88.1.2";
const TN = { address: "100.101.102.103", name: "mini.tail1234.ts.net", login: "robin@example.com", devices: [PHONE] };
const H = `${TN.name}:${PORT}`;

test("a removed phone's sign-in ends on the running hub, not only after a restart", async () => {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: PORT, now: () => new Date("2026-11-01T12:00:00Z") });
  d.setTailnet(TN, PORT);
  const call = (path: string, o: { cookie?: string; json?: unknown } = {}) => d.handleTailnet(new Request(`http://${H}${path}`, {
    method: o.json !== undefined ? "POST" : "GET", body: o.json !== undefined ? JSON.stringify(o.json) : undefined,
    headers: { host: H, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.json !== undefined ? { "content-type": "application/json" } : {}) },
  }), PHONE);
  const r = await call("/app/pair", { json: { key: mintPhoneLink(root), name: "lost" } });
  const sid = r.headers.get("set-cookie")!.match(/pb_owner=([A-Za-z0-9_-]+)/)![1]!;
  expect((await call("/home", { cookie: `pb_owner=${sid}` })).status).toBe(200);
  expect(removeAppPhones(root, "lost")).toEqual(["lost"]); // `pocketbrain dashboard phones remove lost`
  expect((await call("/home", { cookie: `pb_owner=${sid}` })).status).not.toBe(200); // fails at be8ebcc6: still 200
}, 60_000);

test("removing a phone ends every sign-in it made, not only its last few", async () => {
  const root = makeBrain();
  const d = dashboardHandler(root, { port: PORT, now: () => new Date("2026-11-01T12:00:00Z") });
  d.setTailnet(TN, PORT);
  const call = (path: string, o: { cookie?: string; json?: unknown } = {}) => d.handleTailnet(new Request(`http://${H}${path}`, {
    method: o.json !== undefined ? "POST" : "GET", body: o.json !== undefined ? JSON.stringify(o.json) : undefined,
    headers: { host: H, ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.json !== undefined ? { "content-type": "application/json", [APP_HEADER]: "1" } : {}) },
  }), PHONE);
  const r = await call("/app/pair", { json: { key: mintPhoneLink(root), name: "lost" } });
  const first = r.headers.get("set-cookie")!.match(/pb_owner=([A-Za-z0-9_-]+)/)![1]!;
  const { device } = await r.json() as { device: string };
  // The key alone makes no sign-in any more (audit v11, G642): six tries with no cookie make none.
  for (let i = 0; i < 6; i++) expect((await call("/app/fresh", { json: { device } })).status).toBe(401);
  // Face ID on its own sign-in, six times, keeps that one sign-in.
  for (let i = 0; i < 6; i++) {
    const n = await call("/app/nonce", { json: {}, cookie: `pb_owner=${first}` });
    const { nonce } = await n.json() as { nonce: string };
    expect((await call("/app/fresh", { json: { device, nonce }, cookie: `pb_owner=${first}` })).status).toBe(200);
  }
  removeAppPhones(root, "lost");
  expect((await call("/home", { cookie: `pb_owner=${first}` })).status).not.toBe(200);
}, 60_000);
