// SPDX-License-Identifier: AGPL-3.0-only
// One-tap approval of a new assistant on the dashboard: a sign-in waits, the owner picks a name
// and slices, sees exactly what it would get (notes, areas, no money, no private), and one
// Approve creates a trial agent and lets that connection in. Requests lapse and are rate-limited.
import { test, expect, afterAll } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { setupOAuth, loadOAuth, listPending, clearJwksCache, PENDING_PER_HOUR } from "../src/oauth";
import { previewNewAgent } from "../src/addagent";
import { startFakeAS, connect } from "./fake-as";

const as = startFakeAS("user_owner");
afterAll(() => as.stop());
const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const H = "127.0.0.1:8788";

async function setup() {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const mcp = async (token: string) => (await call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: {} } }) }));
  const signIn = async () => { const c = await connect(call, RESOURCE, { dcr: { client_name: "Newbot", redirect_uri: "https://agent.example/cb" } }); await mcp(c.token()); return c; };
  const d = dashboardHandler(root, { port: 8788, loginKey: "k".repeat(32) });
  const r = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  const get = async (path: string) => { const x = await d.handle(new Request(`http://${H}${path}`, { headers: { host: H, cookie } })); return { status: x.status, text: await x.text() }; };
  const csrf = async () => (await get("/overview")).text.match(/name="csrf" value="([^"]+)"/)![1];
  const act = async (action: string, fields: Record<string, string>) => {
    const x = await d.handle(new Request(`http://${H}/action/${action}`, { method: "POST", body: new URLSearchParams({ csrf: await csrf(), ...fields }), headers: { host: H, cookie, "content-type": "application/x-www-form-urlencoded", origin: `http://${H}` } }));
    const loc = x.headers.get("location") ?? "";
    return { status: x.status, ...flashOf(loc) };
  };
  return { root, mcp, signIn, get, act };
}

test("the preview says exactly what a new agent would see: notes, areas, no money, no private", () => {
  const root = makeBrain();
  const p = previewNewAgent(root, { agent: "newbot", slices: ["area:work", "contacts-basic"] });
  expect(p.notes).toBeGreaterThan(0);
  expect(p.areas).toContain("work");
  expect(p.money).toBe(false);
  expect(p.private).toBe(false);
  expect(p.text).toContain("not shared: money");
  // Leaving money in doesn't reach past the trial ceiling: money notes are private.
  expect(previewNewAgent(root, { agent: "newbot", slices: ["area:personal"], exclude_types: [] }).money).toBe(false);
});

test("a waiting sign-in gets a New agent form; its preview page shows the slice and an Approve", async () => {
  const { signIn, get } = await setup();
  const c = await signIn();
  const agents = await get("/agents");
  expect(agents.text).toContain(`action="/agents/new"`);
  expect(agents.text).toContain(`value="${c.client_id}"`);
  const pv = await get(`/agents/new?client_id=${encodeURIComponent(c.client_id)}&agent=newbot&name=Newbot&slices=area:work&slices=contacts-basic`);
  expect(pv.status).toBe(200);
  expect(pv.text).toMatch(/would see \d+ notes/);
  expect(pv.text).toContain("No money");
  expect(pv.text).toContain("No private notes");
  expect(pv.text).toContain("Writes wait for you");
  expect(pv.text).toContain(`action="/action/oauth-new-agent"`);
});

test("Approve creates a trial agent and lets exactly that connection in, with that slice", async () => {
  const { root, mcp, signIn, act } = await setup();
  const c = await signIn();
  const r = await act("oauth-new-agent", { client_id: c.client_id, agent: "newbot", name: "Newbot", slices: "area:work,contacts-basic" });
  expect(r.err).toBe("");
  expect(r.ok).toContain("newbot");
  const pol = YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents.newbot;
  expect(pol).toMatchObject({ tier: "trial", slices: ["area:work", "contacts-basic"], exclude_types: ["money"] });
  expect(loadOAuth(root)!.clients![c.client_id]).toMatchObject({ agent: "newbot", name: "Newbot" });
  const ok = await mcp(c.token());
  expect(ok.status).toBe(200);
  const text = JSON.stringify(await ok.json());
  expect(text).toContain("Course A");
  expect(text).not.toContain("Maple Trust");
});

test("refused: an existing agent name, the all slice, a connection that isn't waiting; nothing written", async () => {
  const { root, signIn, act } = await setup();
  const c = await signIn();
  const before = readFileSync(join(root, "rules", "policy.yaml"), "utf8");
  expect((await act("oauth-new-agent", { client_id: c.client_id, agent: "helper", slices: "area:work" })).err).toContain("already");
  expect((await act("oauth-new-agent", { client_id: c.client_id, agent: "newbot", slices: "all" })).err).toContain("all slice");
  expect((await act("oauth-new-agent", { client_id: "client_nobody", agent: "newbot", slices: "area:work" })).err).toContain("isn't waiting");
  expect(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).toBe(before);
  expect(loadOAuth(root)!.clients?.[c.client_id]).toBeUndefined();
});

test("a waiting sign-in lapses after a day, and new ones are capped per hour", async () => {
  const { root, signIn, act } = await setup();
  const c = await signIn();
  const file = join(root, ".oauth", "pending.json");
  const old = new Date(Date.now() - 25 * 3600_000).toISOString();
  writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, "utf8")).map((p: any) => ({ ...p, first_seen: old, last_seen: old }))));
  expect(listPending(root)).toEqual([]);
  expect((await act("oauth-new-agent", { client_id: c.client_id, agent: "newbot", slices: "area:work" })).err).toContain("isn't waiting");
  for (let i = 0; i < PENDING_PER_HOUR + 3; i++) await signIn();
  expect(listPending(root).length).toBe(PENDING_PER_HOUR);
});
