// SPDX-License-Identifier: AGPL-3.0-only
// A new sign-in is never one tap from an existing assistant's slice (re-recorded identity demo,
// 2026-11-15, G905). The waiting card had a primary Approve beside a menu preset to the first
// assistant in the rules: one tap bound the stranger's sign-in to that assistant's whole cut.
// Now the card picks nobody, binds nothing itself, and the owner's choice opens a page that says
// what that assistant reads and what the yes replaces; only that page has the button.
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { dashboardHandler } from "../src/dashboard/server";
import { setupOAuth, loadOAuth, bindClient, clearJwksCache } from "../src/oauth";
import { startFakeAS, connect } from "./fake-as";

const as = startFakeAS("user_owner");
afterAll(() => as.stop());
const RESOURCE = "https://brain.test/mcp/oauth";
const H = "127.0.0.1:8788";
const plain = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

async function setup() {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request("https://brain.test" + path, init));
  // Its first call puts a sign-in on the waiting list.
  const sign = async () => {
    const c = await connect(call, RESOURCE, { dcr: { client_name: "Notebook", redirect_uri: "https://agent.example/cb" } });
    await call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${c.token()}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    return c;
  };
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const cookie = (await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }))).headers.get("set-cookie")!.split(";")[0]!;
  const get = async (path: string) => { const r = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } })); return { status: r.status, text: await r.text() }; };
  const post = async (action: string, fields: Record<string, string>, referer = "/agents") => {
    const csrf = (await get("/agents")).text.match(/name="csrf" value="([^"]+)"/)![1]!;
    return d.handle(new Request(`http://${H}/action/${action}`, { method: "POST", body: new URLSearchParams({ csrf, ...fields }), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}${referer}`, "content-type": "application/x-www-form-urlencoded" } }));
  };
  return { root, sign, get, post };
}

test("the waiting card picks no assistant and holds no button that binds", async () => {
  const { sign, get } = await setup();
  const nb = await sign();
  const page = (await get("/agents")).text;
  const card = page.slice(page.indexOf('title="OAuth connections"'), page.indexOf("</table>", page.indexOf('class="signins"')));
  expect(card).toContain(nb.client_id);
  // Nothing on the card posts a bind: the only way to an existing assistant is the review page.
  expect(card).not.toContain("/action/oauth-bind");
  const select = card.slice(card.indexOf("<select"), card.indexOf("</select>"));
  expect(select).toContain("required");
  // The first choice is nobody, and it is the chosen one.
  expect(select).toMatch(/<select[^>]*>\s*<option value="" selected disabled>Choose an assistant<\/option>/);
  expect(select.match(/ selected/g)!.length).toBe(1);
  expect(card).toContain('action="/agents/bind"');
});

test("choosing an existing assistant says what it reads and what the yes replaces, then binds", async () => {
  const { root, sign, get, post } = await setup();
  const old = await sign();
  bindClient(root, old.client_id, "helper");
  const nb = await sign();
  const pv = await get(`/agents/bind?client_id=${encodeURIComponent(nb.client_id)}&agent=helper`);
  expect(pv.status).toBe(200);
  const t = plain(pv.text);
  expect(t).toContain("Connect this sign-in as helper?");
  expect(t).toMatch(/It will read everything helper reads: \d+ of \d+ notes/);
  expect(t).toContain("No money notes.");
  expect(t).toContain("It replaces helper's 1 current sign-in, which stops working at once.");
  expect(pv.text).toContain('action="/action/oauth-bind"');
  // Nothing is bound by looking.
  expect(loadOAuth(root)!.clients![nb.client_id]).toBeUndefined();
  const r = await post("oauth-bind", { client_id: nb.client_id, agent: "helper" }, `/agents/bind?client_id=${nb.client_id}&agent=helper`);
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toMatch(/^\/agent\/helper\?ok=/);
  expect(loadOAuth(root)!.clients![nb.client_id]).toMatchObject({ agent: "helper" });
});

test("the review page answers for a waiting sign-in and a real assistant only, and a bind with no assistant is refused", async () => {
  const { root, sign, get, post } = await setup();
  const nb = await sign();
  expect((await get(`/agents/bind?client_id=made-up&agent=helper`)).status).toBe(404);
  expect((await get(`/agents/bind?client_id=${encodeURIComponent(nb.client_id)}&agent=nobody`)).status).toBe(404);
  expect((await get(`/agents/bind?client_id=${encodeURIComponent(nb.client_id)}&agent=`)).status).toBe(303);
  const r = await post("oauth-bind", { client_id: nb.client_id, agent: "" });
  expect(r.headers.get("location")).toMatch(/^\/agents\?err=/);
  expect(loadOAuth(root)!.clients ?? {}).toEqual({});
});

// Slice audit of G905 (2026-11-15), G906: the review page says only what it checked.
test("the review page says when the assistant is paused, and never offers another person's assistant", async () => {
  const { root, sign, get, post } = await setup();
  const nb = await sign();
  // "No money." claimed more than the page checks: it looks at money pages, and says so.
  expect(plain((await get(`/agents/bind?client_id=${encodeURIComponent(nb.client_id)}&agent=helper`)).text)).toContain("No money notes.");
  await post("agent-status", { agent: "helper", status: "paused" });
  const paused = plain((await get(`/agents/bind?client_id=${encodeURIComponent(nb.client_id)}&agent=helper`)).text);
  expect(paused).toContain("helper is paused now, so this sign-in gets nothing until you resume it.");
  // A coworker's assistant can't take the owner's sign-in (bindClient refuses): it isn't on the
  // menu, and its review page says why and has no button.
  const { addCoworker } = await import("../src/oauth");
  addCoworker(root, "user_alice", "Alice", "helper");
  const page = (await get("/agents")).text;
  const select = page.slice(page.indexOf("<select", page.indexOf('class="signins"')), page.indexOf("</select>", page.indexOf('class="signins"')));
  expect(select).not.toContain("<option>helper</option>");
  const pv = await get(`/agents/bind?client_id=${encodeURIComponent(nb.client_id)}&agent=helper`);
  expect(plain(pv.text)).toContain("helper is Alice's assistant. Connect your own sign-ins to an assistant of yours.");
  expect(pv.text).not.toContain("/action/oauth-bind");
});
