// SPDX-License-Identifier: AGPL-3.0-only
// The owner's phone, 2026-11-01 ("certain web uis are still the old one"): after the owner app
// moved to Two inks, the pages behind Settings and the sign-in pages kept the old look, the
// loopback sign-in and every error came back as bare text, and the Sent page gave no next step
// (G621). Every page now wears the Two inks paper, typeface and headline ink, an error is a page,
// and Sent says to open Messages, and names the https door when the phone came in over plain http.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { dashboardHandler } from "../src/dashboard/server";
import { FONT_PATH } from "../src/dashboard/html-app";

const PORT = 8789;
const PHONE = "100.88.1.2";
const TN = { address: "100.101.102.103", name: "mini.tail1234.ts.net", login: "robin@example.com", devices: [PHONE] };
const H = `${TN.name}:${PORT}`;
const twoInks = (page: string) => page.includes(FONT_PATH) && page.includes("--headline-ink") && page.includes("--paper");

function hub() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "transport:\n  use: fake\n  fake: { trusted: true }\n");
  const key = "k".repeat(32);
  const d = dashboardHandler(root, { port: PORT, loginKey: key });
  d.setTailnet(TN, PORT);
  const local = (path: string, cookie?: string) => d.handle(new Request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, ...(cookie ? { cookie } : {}) } }));
  const tn = (path: string, o: { method?: string; origin?: string } = {}) =>
    d.handleTailnet(new Request(`http://${H}${path}`, { method: o.method ?? "GET", headers: { host: H, ...(o.origin ? { origin: o.origin } : {}) } }), PHONE);
  const evil = (path: string) => d.handle(new Request(`http://evil.example${path}`, { headers: { host: "evil.example" } }));
  return { root, key, local, tn, evil };
}

test("signed out on this computer: a page in the new look, not bare text", async () => {
  const { local } = hub();
  const r = await local("/home");
  expect(r.status).toBe(401);
  expect(r.headers.get("content-type")).toContain("text/html");
  const page = await r.text();
  expect(page).toContain("<h1>");
  expect(twoInks(page)).toBe(true);
});

test("Settings and the pages behind it wear Two inks", async () => {
  const { local, key } = hub();
  const r0 = await local(`/login?key=${key}`);
  const cookie = r0.headers.get("set-cookie")!.split(";")[0]!;
  for (const p of ["/overview", "/brain", "/agents"]) expect(twoInks(await (await local(p, cookie)).text())).toBe(true);
});

test("Sent says to open Messages and names the https door on plain http", async () => {
  const { tn } = hub();
  const out = await tn("/overview");
  expect(twoInks(await out.text())).toBe(true);
  const sent = await tn("/send-link", { method: "POST", origin: `http://${H}` });
  expect(sent.status).toBe(200);
  const page = await sent.text();
  expect(twoInks(page)).toBe(true);
  expect(page).toContain("Messages");
  expect(page).toContain(`https://${TN.name}:8443`);
  expect(page).toContain("Not Secure");
});

// Security review of this change: an error page is now a full page, and some are served before any
// sign-in (a wrong Host, a spent link). Those must not carry the brain's owner name or its folder,
// which the signed-in header shows.
test("a page served before sign-in names neither the owner nor the brain's folder", async () => {
  const { root, local, tn, evil } = hub();
  const owner = /name:\s*(.+)/.exec(readFileSync(join(root, "rules", "policy.yaml"), "utf8"))?.[1]?.trim();
  const pages = [
    await (await local("/home")).text(),
    await (await evil("/")).text(),
    await (await local("/login?key=nope")).text(),
    await (await tn("/overview")).text(),
    await (await tn("/send-link", { method: "POST", origin: `http://${H}` })).text(),
  ];
  for (const p of pages) {
    expect(p).not.toContain(root);
    if (owner) expect(p).not.toContain(`${owner}'s brain`);
    expect(p).not.toContain(">Your brain<");
  }
});
