// SPDX-License-Identifier: AGPL-3.0-only
// The owner's side of a new assistant's sign-in, at phone width in a real Chromium (found while
// recording the identity demo, 2026-11-15): the waiting card fits the screen (G885), Approve on
// the review page lands on the new assistant's page with the message that it worked (G884), and
// after Revoke that page says it is not connected (G886) in words that count keys and sign-ins
// for what they are (G887). Skipped when Chromium can't start.
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { serveDashboard } from "../src/dashboard/server";
import { setupOAuth, loadOAuth, clearJwksCache } from "../src/oauth";
import { runAction } from "../src/dashboard/actions";
import { startFakeAS, connect } from "./fake-as";

let browser: any;
try { browser = await (await import("playwright")).chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
const as = startFakeAS("user_owner");
afterAll(async () => { as.stop(); await browser?.close(); });

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;

run("a new assistant's sign-in on a phone: the card fits, Approve says it worked, Revoke says it is not connected", async () => {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const mcp = (token: string) => call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${token}`, "user-agent": "Notebook/1.0 (a longer agent string, as real clients send)" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: {} } }) });
  const d = serveDashboard(root, { port: 0 });
  try {
    const nb = await connect(call, RESOURCE, { dcr: { client_name: "Notebook", redirect_uri: "https://agent.example/cb" } });
    await mcp(nb.token());
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" })).newPage();
    page.on("dialog", (dl: any) => dl.accept());
    await page.goto(d.loginUrl);
    await page.goto(new URL("/agents", page.url()).href);

    // G885: nothing runs off a 390px screen, the id reads on a line, Decline can be tapped.
    const row = page.locator(".signins tr", { hasText: nb.client_id });
    expect(await row.count()).toBe(1);
    expect(await page.evaluate("document.scrollingElement.scrollWidth")).toBeLessThanOrEqual(390);
    const id = (await row.locator(".mono").first().boundingBox())!;
    expect(id.width).toBeGreaterThan(Math.min(300, nb.client_id.length * 7));
    const decline = (await row.getByRole("button", { name: "Decline" }).boundingBox())!;
    expect(decline.x + decline.width).toBeLessThanOrEqual(390);

    // G884: the review page's Approve lands on the assistant's own page, saying it worked.
    await row.locator("summary").click();
    await page.getByLabel(`name of a new agent, sign-in ${nb.client_id}`, { exact: true }).fill("notebook");
    await row.getByLabel("contacts-basic").check();
    await row.getByRole("button", { name: "See what it would get" }).click();
    await page.waitForLoadState("load");
    await page.getByRole("button", { name: "Approve notebook" }).click();
    await page.waitForLoadState("load");
    expect(loadOAuth(root)!.clients![nb.client_id]).toMatchObject({ agent: "notebook" });
    const body = await page.locator("body").textContent();
    expect(body).not.toContain("isn't waiting any more");
    expect(new URL(page.url()).pathname).toBe("/agent/notebook");
    expect((await page.locator(".flash").textContent()).trim()).toBe("notebook added as a trial agent; that connection now connects as notebook");
    expect(await page.locator("h1 .status").textContent()).toBe("active");

    // G886, G887: after Revoke the page says it has no way in, and offers no second Revoke.
    await page.getByRole("button", { name: "Revoke access" }).click();
    await page.waitForLoadState("load");
    expect((await page.locator(".flash").textContent()).trim()).toBe("revoked 1 sign-in for notebook");
    expect((await mcp(nb.token())).status).toBe(401);
    expect(await page.locator("h1 .status").textContent()).toBe("not connected");
    expect(await page.locator("h1 .status.st-active").count()).toBe(0);
    expect(await page.locator("body").textContent()).toContain("It has no key and no sign-in, so it gets nothing from your memory until you connect it.");
    expect(await page.getByRole("button", { name: "Revoke access" }).count()).toBe(0);
    expect(await page.evaluate("document.scrollingElement.scrollWidth")).toBeLessThanOrEqual(390);
  } finally { d.server.stop(true); }
}, 60000);

test("a new assistant that can't be added goes back to the list with the reason", async () => {
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const { dashboardHandler } = await import("../src/dashboard/server");
  const h = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) }).handle;
  const host = "127.0.0.1:8788";
  const login = await h(new Request(`http://${host}/login?key=${"k".repeat(32)}`, { headers: { host } }));
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = (await (await h(new Request(`http://${host}/agents`, { headers: { host, cookie } }))).text()).match(/name="csrf" value="([^"]+)"/)![1]!;
  const r = await h(new Request(`http://${host}/action/oauth-new-agent`, { method: "POST", headers: { host, cookie, origin: `http://${host}`, referer: `http://${host}/agents/new?client_id=gone&agent=notebook`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, client_id: "gone", agent: "notebook", slices: "contacts-basic" }).toString() }));
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toMatch(/^\/agents\?err=/);
});

test("the revoke message counts keys and sign-ins for what they are", async () => {
  const root = makeBrain();
  const { issueToken } = await import("../src/auth");
  issueToken(root, "helper");
  expect(runAction({ root }, "agent-revoke", { agent: "helper" })).toBe("revoked 1 key for helper");
  issueToken(root, "helper"); issueToken(root, "helper");
  expect(runAction({ root }, "agent-revoke", { agent: "helper" })).toBe("revoked 2 keys for helper");
  expect(runAction({ root }, "agent-revoke", { agent: "helper" })).toBe("helper had no key or sign-in to revoke");
});
