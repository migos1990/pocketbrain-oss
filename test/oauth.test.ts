// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth door end to end: an assistant that only knows the URL signs in through a (fake)
// hosted authorization server, with dynamic registration (Helper) or a client metadata document
// (Planner), and gets exactly its agent's slice once the owner binds the connection.
import { test, expect, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken, revokeTokens } from "../src/auth";
import { setupOAuth, bindClient, revokeClient, listPending, loadOAuth, clearJwksCache, addCoworker, bindCoworkerClient, listCoworkerPending, bindMachine } from "../src/oauth";
import { openWindow } from "../src/gardener";
import { tunnelConfig } from "../src/hub";
import { startFakeAS, startClientHost, connect, signJwt } from "./fake-as";

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const as = startFakeAS("user_owner");
afterAll(() => as.stop());

function setup() {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const mcp = async (token: string, method: string, params: unknown = {}, path = "/mcp/oauth") => {
    const res = await call(path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { root, call, mcp };
}

test("Helper-style: dynamic registration, waits for the owner, then gets Helper's slice and nothing more", async () => {
  const { root, call, mcp } = setup();
  const helper = await connect(call, RESOURCE, { dcr: { client_name: "Helper", redirect_uri: "https://agent.example/api/oauth/callback" } });
  expect(helper.prm.resource).toBe(RESOURCE);

  // Signed in, but nobody said who this is yet: a waiting session (request_access only, see
  // test/access-request.test.ts), and listed for the owner.
  const waiting = await mcp(helper.token(), "initialize");
  expect(waiting.json.result.instructions).toContain("waiting for the owner");
  expect((await mcp(helper.token(), "tools/call", { name: "context_pack", arguments: {} })).json.result.isError).toBe(true);
  expect(listPending(root).map((p) => p.client_id)).toEqual([helper.client_id]);

  bindClient(root, helper.client_id, "helper", "Helper");
  expect(listPending(root)).toEqual([]);
  const init = await mcp(helper.token(), "initialize");
  expect(init.status).toBe(200);
  expect(init.json.result.serverInfo.name).toBe("pocketbrain");
  const ctx = await mcp(helper.token(), "tools/call", { name: "context_pack", arguments: {} });
  expect(ctx.json.result.content[0].text).toContain("Course A");
  expect(ctx.json.result.content[0].text).not.toContain("Maple Trust");

  // A refreshed token keeps working; the binding is per client, not per token.
  expect((await mcp(await helper.refresh(), "tools/list")).status).toBe(200);

  // The dashboard's Revoke button (revokeTokens) cuts the OAuth connection too, at once.
  expect(revokeTokens(root, "helper")).toBe(1);
  const cut = await mcp(helper.token(), "tools/list");
  expect(cut.status).toBe(401);
  expect(cut.headers.get("www-authenticate")).toContain('error="invalid_token"');
  expect(listPending(root)).toEqual([]); // a revoked client never comes back as "waiting"
  expect(() => bindClient(root, helper.client_id, "helper")).toThrow(/revoked/);

  // Reconnecting registers a new client, which waits for the owner again.
  const again = await connect(call, RESOURCE, { dcr: { client_name: "Helper", redirect_uri: "https://agent.example/api/oauth/callback" } });
  expect(again.client_id).not.toBe(helper.client_id);
  expect((await mcp(again.token(), "tools/list")).json.result.tools.map((t: any) => t.name)).toEqual(["request_access"]);
});

test("Planner-style: a client metadata document works the same way", async () => {
  const { root, call, mcp } = setup();
  const host = startClientHost("https://planner.example/api/mcp/oauth/callback");
  try {
    const planner = await connect(call, RESOURCE, { cimd: { client_id: host.clientId, redirect_uri: "https://planner.example/api/mcp/oauth/callback" } });
    expect(planner.client_id).toBe(host.clientId);
    expect((await mcp(planner.token(), "tools/list")).json.result.tools.map((t: any) => t.name)).toEqual(["request_access"]);
    bindClient(root, planner.client_id, "planner");
    const read = await mcp(planner.token(), "tools/call", { name: "read", arguments: { id: "money/main-bank" } });
    expect(read.json.result.isError).toBe(true); // Planner's slice has no money
    expect((await mcp(planner.token(), "tools/call", { name: "search", arguments: { query: "course" } })).status).toBe(200);
    // Revoking one client leaves the agent's pasted token alone.
    const pasted = issueToken(root, "planner");
    revokeClient(root, planner.client_id);
    expect((await mcp(planner.token(), "tools/list")).status).toBe(401);
    expect((await mcp(pasted, "tools/list", {}, "/mcp")).status).toBe(200);
  } finally { host.stop(); }
});

test("/mcp keeps its plain 401 so Planner never starts OAuth there; only /mcp/oauth advertises it", async () => {
  const { call } = setup();
  for (const p of ["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
    const r = await call(p, { method: p === "/mcp" ? "POST" : "GET" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBeNull();
  }
  const prm = await call("/.well-known/oauth-protected-resource/mcp/oauth");
  expect(prm.status).toBe(200);
  expect(await prm.json()).toEqual({ resource: RESOURCE, authorization_servers: [as.issuer], bearer_methods_supported: ["header"], resource_name: "pocketBrain" });
  const r = await call("/mcp/oauth", { method: "POST" });
  expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp/oauth"`);
  // The tunnel lets the metadata through.
  expect(new RegExp(tunnelConfig(makeBrain()).match(/path: (.*)/)![1]).test("/.well-known/oauth-protected-resource/mcp/oauth")).toBe(true);
});

test("tokens that don't hold up are refused", async () => {
  const { root, call, mcp } = setup();
  const helper = await connect(call, RESOURCE, { dcr: { client_name: "Helper", redirect_uri: "https://agent.example/cb" } });
  bindClient(root, helper.client_id, "helper");
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: as.issuer, sub: "user_owner", aud: RESOURCE, client_id: helper.client_id, iat: now, exp: now + 300 };
  const status = async (t: string) => (await mcp(t, "tools/list")).status;
  expect(await status(signJwt(as.key, as.kid, good))).toBe(200);
  expect(await status(signJwt(as.key, as.kid, { ...good, aud: "https://elsewhere.test/mcp" }))).toBe(401);
  expect(await status(signJwt(as.key, as.kid, { ...good, iss: "https://evil.test" }))).toBe(401);
  expect(await status(signJwt(as.key, as.kid, { ...good, exp: now - 120 }))).toBe(401);
  expect(await status(signJwt(as.key, as.kid, { ...good, sub: "user_stranger" }))).toBe(403);
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  expect(await status(signJwt(other, as.kid, good))).toBe(401);
  const [h, , s] = signJwt(as.key, as.kid, good).split(".");
  const forged = Buffer.from(JSON.stringify({ ...good, client_id: "someone-else" })).toString("base64url");
  expect(await status(`${h}.${forged}.${s}`)).toBe(401);
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(good)).toString("base64url")}.`;
  expect(await status(none)).toBe(401);
  // A pasted pb_ token isn't an OAuth token, and an OAuth token isn't a pasted one.
  expect(await status(issueToken(root, "helper"))).toBe(401);
  expect((await mcp(helper.token(), "tools/list", {}, "/mcp")).status).toBe(401);
  // A stranger who signs in at the AS gets nothing either.
  as.signedIn.sub = "user_stranger";
  try {
    const s2 = await connect(call, RESOURCE, { dcr: { client_name: "x", redirect_uri: "https://x.example/cb" } });
    expect((await mcp(s2.token(), "tools/list")).status).toBe(403);
    expect(listPending(root).map((p) => p.client_id)).not.toContain(s2.client_id);
  } finally { as.signedIn.sub = "user_owner"; }
});

test("the owner's kill switch and policy still apply to OAuth connections", async () => {
  const { root, call, mcp } = setup();
  const helper = await connect(call, RESOURCE, { dcr: { client_name: "Helper", redirect_uri: "https://agent.example/cb" } });
  bindClient(root, helper.client_id, "helper");
  const p = join(root, "rules/policy.yaml");
  const orig = readFileSync(p, "utf8");
  writeFileSync(p, orig.replace("helper: { tier: trial,", "helper: { status: paused, tier: trial,"));
  expect((await mcp(helper.token(), "tools/list")).status).toBe(403);
  writeFileSync(p, orig.replace(/^  helper:.*\n/m, ""));
  expect((await mcp(helper.token(), "tools/list")).status).toBe(403);
  expect(() => bindClient(root, "c2", "steward-nope")).toThrow();
});

test("no rules/oauth.yaml: no OAuth door at all", async () => {
  const root = makeBrain();
  expect(loadOAuth(root)).toBeUndefined();
  expect((await handle(root, new Request(`${BASE}/mcp/oauth`, { method: "POST" }))).status).toBe(404);
  expect((await handle(root, new Request(`${BASE}/.well-known/oauth-protected-resource/mcp/oauth`))).status).toBe(404);
  expect(() => setupOAuth(root, { issuer: "http://as.example", resource: RESOURCE, owner_subject: "u" })).toThrow(/https only/);
  expect(() => setupOAuth(root, { issuer: "https://as.example", resource: `${BASE}/mcp`, owner_subject: "u" })).toThrow(/mcp\/oauth/);
});

test("Auth0-shaped tokens: issuer with a trailing slash, aud as a list, client only in azp", async () => {
  const { root, call, mcp } = setup();
  const helper = await connect(call, RESOURCE, { dcr: { client_name: "Helper", redirect_uri: "https://agent.example/cb" } });
  clearJwksCache();
  setupOAuth(root, { issuer: `${as.issuer}/`, resource: RESOURCE, owner_subject: "auth0|owner", jwks_uri: `${as.issuer}/jwks` });
  bindClient(root, helper.client_id, "helper");
  const now = Math.floor(Date.now() / 1000);
  const tok = { iss: `${as.issuer}/`, sub: "auth0|owner", aud: [RESOURCE, `${as.issuer}/userinfo`], azp: helper.client_id, scope: "openid offline_access", iat: now, exp: now + 300 };
  expect((await mcp(signJwt(as.key, as.kid, tok), "tools/list")).status).toBe(200);
  expect((await mcp(signJwt(as.key, as.kid, { ...tok, iss: as.issuer }), "tools/list")).status).toBe(401);
  expect((await mcp(signJwt(as.key, as.kid, { ...tok, sub: "auth0|stranger" }), "tools/list")).status).toBe(403);
});

test("a coworker signs in as themselves, waits for the owner, and gets only their agent's slice", async () => {
  const { root, call, mcp } = setup();
  const host = startClientHost("https://planner.example/api/mcp/oauth/callback");
  const sign = async (sub: string) => {
    as.signedIn.sub = sub;
    try { return await connect(call, RESOURCE, { cimd: { client_id: host.clientId, redirect_uri: "https://planner.example/api/mcp/oauth/callback" } }); }
    finally { as.signedIn.sub = "user_owner"; }
  };
  try {
    // The owner's own connection through a shared client id (a client metadata document).
    const mine = await sign("user_owner");
    bindClient(root, mine.client_id, "planner");
    expect((await mcp(mine.token(), "tools/list")).status).toBe(200);

    // Alice uses the same client id: the owner's binding never carries over to her account.
    const alice = await sign("user_alice");
    expect(alice.client_id).toBe(mine.client_id);
    expect((await mcp(alice.token(), "tools/list")).json.error_description).toContain("only answers its owner's account");

    // The owner lets Alice in as helper; her connection still waits for approval.
    expect(() => addCoworker(root, "user_alice", "Alice", "planner")).toThrow(/already used by one of your own/);
    addCoworker(root, "user_alice", "Alice", "helper");
    const waiting = await mcp(alice.token(), "tools/list");
    expect(waiting.status).toBe(403);
    expect(waiting.json.error_description).toContain("Alice's waits for the owner's approval");
    expect(listCoworkerPending(root).map((p) => [p.subject, p.client_id])).toEqual([["user_alice", alice.client_id]]);
    expect(listPending(root)).toEqual([]); // the owner's own waiting list stays clean

    bindCoworkerClient(root, "user_alice", alice.client_id);
    expect(listCoworkerPending(root)).toEqual([]);
    const ctx = await mcp(alice.token(), "tools/call", { name: "context_pack", arguments: {} });
    expect(ctx.json.result.content[0].text).toContain("Course A");
    expect(ctx.json.result.content[0].text).not.toContain("Maple Trust");
    expect((await mcp(alice.token(), "tools/call", { name: "read", arguments: { id: "money/main-bank" } })).json.result.isError).toBe(true);
    expect(() => bindClient(root, "some-client", "helper")).toThrow(/Alice's agent/);

    // Revoking helper cuts Alice off; the owner's own connection keeps working.
    revokeTokens(root, "helper");
    expect(loadOAuth(root)!.coworkers).toEqual({});
    expect((await mcp(alice.token(), "tools/list")).status).toBe(403);
    expect((await mcp(mine.token(), "tools/list")).status).toBe(200);
    expect(loadOAuth(root)!.revoked ?? []).not.toContain(mine.client_id);
  } finally { host.stop(); }
});

test("the gardener connects with its own machine identity, under the gardener's rules", async () => {
  const { root, mcp } = setup();
  const now = Math.floor(Date.now() / 1000);
  const machineToken = (client: string, sub = `${client}@clients`) =>
    signJwt(as.key, as.kid, { iss: as.issuer, aud: RESOURCE, sub, azp: client, gty: "client-credentials", iat: now, exp: now + 300 });

  // Not bound: a machine token is no person, so it gets nothing.
  expect((await mcp(machineToken("m2m-g"), "tools/list")).status).toBe(403);
  expect(() => bindMachine(root, "m2m-g", "helper")).toThrow(/isn't a gardener/);
  bindMachine(root, "m2m-g", "gardener");
  openWindow(root, "gardener", 60);
  const list = await mcp(machineToken("m2m-g"), "tools/list");
  expect(list.status).toBe(200);
  expect(list.json.result.tools.map((t: { name: string }) => t.name)).toContain("last_run");

  // A bound machine id with someone else's subject is not the machine.
  expect((await mcp(machineToken("m2m-g", "user_stranger"), "tools/list")).status).toBe(403);

  // Revoke on the gardener cuts the machine too.
  revokeTokens(root, "gardener");
  expect((await mcp(machineToken("m2m-g"), "tools/list")).status).toBe(403);
  expect(loadOAuth(root)!.revoked).toContain("m2m-g");
  expect(() => bindMachine(root, "m2m-g", "gardener")).toThrow(/revoked/);
});
