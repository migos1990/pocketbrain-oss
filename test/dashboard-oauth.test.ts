// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth approval on the dashboard's Agents page, in a real Chromium: an assistant signs in
// through the (fake) hosted authorization server, waits, the owner picks its agent and clicks
// Approve, and the assistant then gets that agent's slice. Decline cuts a second one off for
// good. Skipped when Chromium can't start.
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { serveDashboard } from "../src/dashboard/server";
import { setupOAuth, loadOAuth, listPending, clearJwksCache } from "../src/oauth";
import { git } from "../src/git";
import { startFakeAS, connect } from "./fake-as";

let browser: any;
try { browser = await (await import("playwright")).chromium.launch(); } catch { browser = undefined; }
const run = browser ? test : test.skip;
const as = startFakeAS("user_owner");
afterAll(async () => { as.stop(); await browser?.close(); });

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;

run("OAuth: the owner approves a waiting connection as Helper, and declines another", async () => {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const mcp = (token: string, ua = "MuseBot/1.0") => call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${token}`, "user-agent": ua }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: {} } }) });
  const d = serveDashboard(root, { port: 0 });
  try {
    const helper = await connect(call, RESOURCE, { dcr: { client_name: "Helper", redirect_uri: "https://agent.example/cb" } });
    // Waiting: only request_access works, so context_pack is refused and gives nothing.
    expect(await (await mcp(helper.token(), '<img src=x onerror="window.pwned=1">')).json()).toMatchObject({ result: { isError: true } });
    const other = await connect(call, RESOURCE, { dcr: { client_name: "x", redirect_uri: "https://x.example/cb" } });
    expect(await (await mcp(other.token())).json()).toMatchObject({ result: { isError: true } });

    const page = await (await browser.newContext()).newPage();
    page.on("dialog", (dl: any) => dl.accept());
    await page.goto(d.loginUrl);
    await page.getByRole("link", { name: "Assistants" }).click();
    expect(await page.locator("h2[title=\"OAuth connections\"]", { hasText: "Sign-in connections" }).count()).toBe(1);
    // The user agent came from whoever signed in: shown as text, never run.
    expect(await page.locator("body").textContent()).toContain('<img src=x onerror="window.pwned=1">');
    expect(await page.evaluate("window.pwned")).toBeUndefined();

    await page.getByLabel(`agent for ${helper.client_id}`).selectOption("helper");
    await page.getByLabel(`label for ${helper.client_id}`).fill("Helper");
    await page.locator("tr", { hasText: helper.client_id }).getByRole("button", { name: "Approve" }).click();
    await page.waitForLoadState("load");
    expect((await page.locator(".flash").textContent()).trim()).toBe("connection approved: it now connects as helper");
    expect(loadOAuth(root)!.clients![helper.client_id]).toMatchObject({ agent: "helper", name: "Helper" });
    expect(git(root, ["log", "-1", "--format=%s", "--", "rules/oauth.yaml"])).toContain("oauth client bound to helper");
    const ok = await mcp(helper.token());
    expect(ok.status).toBe(200);
    const ctx = JSON.stringify(await ok.json());
    expect(ctx).toContain("Course A");
    expect(ctx).not.toContain("Maple Trust");

    await page.locator("tr", { hasText: other.client_id }).getByRole("button", { name: "Decline" }).click();
    await page.waitForLoadState("load");
    expect((await page.locator(".flash").textContent()).trim()).toBe("connection declined");
    expect(listPending(root)).toEqual([]);
    expect((await mcp(other.token())).status).toBe(401);
    expect(await page.locator("body").textContent()).toContain("No connection is waiting for approval.");
  } finally { d.server.stop(true); }
}, 30000);

test("Approve only binds a connection that is actually waiting", async () => {
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const { runAction } = await import("../src/dashboard/actions");
  expect(() => runAction({ root }, "oauth-bind", { client_id: "made-up", agent: "helper" })).toThrow(/isn't waiting/);
  expect(loadOAuth(root)!.clients ?? {}).toEqual({});
});
