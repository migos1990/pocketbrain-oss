// SPDX-License-Identifier: AGPL-3.0-only
// Owner's phone, 2026-11-03 16:22Z, after the Face ID update: "Couldn't reach your hub. Is Tailscale
// on?" a minute after Face ID worked, with the hub healthy and nothing in any log to say what the
// phone was answered. Now the hub keeps a line per call to the app's doors (/app/pair, /app/nonce,
// /app/fresh): when, which door, the status and the hub's one-line reason, never a key, a nonce or a
// cookie; `pocketbrain dashboard phones log` prints them. And the app says "Couldn't reach your hub"
// only when it couldn't: any other answer is said with its status, and a dropped connection is
// tried once more (G651).
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler, mintPhoneLink, APP_HEADER } from "../src/dashboard/server";
import { fresh } from "../mobile/src/hub";

const PORT = 8788, PHONE = "100.88.1.2";
const TN = { address: "100.101.102.103", name: "mini.tail1234.ts.net", login: "robin@example.com", devices: [PHONE] };
const H = `${TN.name}:${PORT}`;
function hub(root: string) {
  const d = dashboardHandler(root, { port: PORT, now: () => new Date("2026-11-01T12:00:00Z") });
  d.setTailnet(TN, PORT);
  return (path: string, json: unknown, cookie?: string) => d.handleTailnet(new Request(`http://${H}${path}`, {
    method: "POST", body: JSON.stringify(json),
    headers: { host: H, "content-type": "application/json", [APP_HEADER]: "1", ...(cookie ? { cookie } : {}) },
  }), PHONE);
}
const logOf = (root: string) => { const f = join(root, ".git", "pb-app-door.jsonl"); return existsSync(f) ? readFileSync(f, "utf8") : ""; };

test("each call to the app's doors leaves a line with its status, never a key, nonce or cookie", async () => {
  const root = makeBrain();
  const call = hub(root);
  const key = mintPhoneLink(root);
  const pair = await call("/app/pair", { key, name: "phone" });
  expect(pair.status).toBe(200);
  const sid = pair.headers.get("set-cookie")!.match(/pb_owner=([A-Za-z0-9_-]+)/)![1]!;
  const { device } = await pair.json() as { device: string };
  const { nonce } = await (await call("/app/nonce", {}, `pb_owner=${sid}`)).json() as { nonce: string };
  expect((await call("/app/fresh", { device, nonce }, `pb_owner=${sid}`)).status).toBe(200);
  expect((await call("/app/fresh", { device, nonce }, `pb_owner=${sid}`)).status).toBe(403); // spent
  expect((await call("/app/nonce", {})).status).toBe(401); // no sign-in
  const raw = logOf(root);
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { door: string; status: number; cookie: boolean; why?: string });
  expect(lines.map((l) => [l.door, l.status, l.cookie])).toEqual([["/app/pair", 200, false], ["/app/nonce", 200, true], ["/app/fresh", 200, true], ["/app/fresh", 403, true], ["/app/nonce", 401, false]]);
  expect(lines[3]!.why).toContain("old or already used");
  for (const secret of [key, device, nonce, sid]) expect(raw).not.toContain(secret);
});

const answer = (status: number, body: unknown) => async () => ({ status, json: async () => body, text: async () => String(body) });

test("the app blames the network only when the hub didn't answer, and tries a dropped call once more", async () => {
  const r = await fresh(answer(409, "busy") as never, "https://hub", "d");
  expect(r).not.toBe("offline");
  expect(r).toEqual({ error: 409 });
  let n = 0;
  const flaky = async (url: string) => { n++; if (n === 1) throw new Error("connection lost"); return url.endsWith("/app/nonce") ? answer(200, { nonce: "n" })() : answer(200, { fresh: true })(); };
  expect(await fresh(flaky as never, "https://hub", "d")).toBe("fresh");
  expect(await fresh((async () => { throw new Error("down"); }) as never, "https://hub", "d")).toBe("offline");
});

test("a page that loads clears the last banner: it said the hub couldn't be reached on every page after (owner's phone, 16:25Z)", async () => {
  const hubMod = await import("../mobile/src/hub") as Record<string, unknown>;
  const pageClears = hubMod.pageClears as ((e: string) => boolean) | undefined;
  const freshWords = hubMod.freshWords as ((r: unknown) => string) | undefined;
  expect(typeof pageClears).toBe("function");
  expect(pageClears!("ready")).toBe(true);
  expect(pageClears!("blank")).toBe(true);
  expect(pageClears!("fresh")).toBe(false);
  expect(freshWords!("fresh")).toBe("");
  expect(freshWords!({ error: 409 })).toBe("Your hub answered 409 to Face ID. Try again.");
  expect(freshWords!("offline")).toContain("Couldn't reach your hub");
  expect(freshWords!({ error: 404 })).toBe("Your hub needs the update that goes with this app.");
  // The app clears it when the page says it loaded.
  const app = (await import("node:fs")).readFileSync("mobile/App.tsx", "utf8");
  expect(app).toMatch(/pageClears\(m\)\) setMsg\(""\)/);
});
