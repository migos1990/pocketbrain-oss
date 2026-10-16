// SPDX-License-Identifier: AGPL-3.0-only
// Contract for the OAuth door (src/oauth.ts, served at /mcp/oauth by src/server.ts): who a
// signed token speaks for, and every way a token is refused, as tables. A bug fixed in this
// surface adds a row here.
import { test, expect, afterAll } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "../fixture";
import { handle } from "../../src/server";
import { issueToken, revokeTokens } from "../../src/auth";
import { setupOAuth, bindClient, revokeClient, listPending, loadOAuth, clearJwksCache, addCoworker, bindCoworkerClient, bindMachine, expectClient } from "../../src/oauth";
import { loadBrain, type FactRecord } from "../../src/brain";
import { startFakeAS, signJwt } from "../fake-as";

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const OWNER_SUB = "user_owner";
const as = startFakeAS(OWNER_SUB);
afterAll(() => as.stop());

function setup() {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: OWNER_SUB, jwks_uri: `${as.issuer}/jwks` });
  const now = Math.floor(Date.now() / 1000);
  const claims = (client: string, extra: Record<string, unknown> = {}) => ({ iss: as.issuer, sub: OWNER_SUB, aud: RESOURCE, client_id: client, iat: now, exp: now + 300, ...extra });
  const jwt = (client: string, extra: Record<string, unknown> = {}) => signJwt(as.key, as.kid, claims(client, extra));
  const mcp = async (token: string | undefined, method: string, params: unknown = {}, path = "/mcp/oauth") => {
    const res = await handle(root, new Request(BASE + path, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }));
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    // `door`: 403 for a connection that still waits, including the owner's own unbound sign-in,
    // which gets the waiting session (request_access only, nothing from the brain).
    const waiting = res.status === 200 && JSON.stringify(json?.result?.tools?.map((t: any) => t.name) ?? null) === '["request_access"]';
    return { status: res.status, door: waiting ? 403 : res.status, json, www: res.headers.get("www-authenticate") };
  };
  return { root, now, claims, jwt, mcp };
}
const setPolicy = (root: string, from: string, to: string) => {
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(from, to));
};
const remember = (attribute: string, extra: Record<string, unknown> = {}) =>
  ({ name: "remember", arguments: { ...extra, id: "projects/course-a", attribute, value: `v ${attribute}`, as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" } });

test("contract oauth: identity is the owner's binding of the client in rules/oauth.yaml, never the client's name or claims (invariant 2)", async () => {
  const { root, jwt, mcp } = setup();
  bindClient(root, "c-planner", "planner", "Steward"); // the owner's label for it says nothing about identity
  // Each row: something in the token or the call that names another agent -> the write is Planner's.
  const rows: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ["client_name claim", { client_name: "steward" }, {}],
    ["name and agent claims", { name: "Steward", agent: "steward", preferred_username: "steward" }, {}],
    ["agent in the tool call", {}, { agent: "steward" }],
  ];
  for (const [i, [label, claims, args]] of rows.entries()) {
    const r = await mcp(jwt("c-planner", claims), "tools/call", remember(`step_${i}`, args));
    expect(JSON.parse(r.json.result.content[0].text).outcome, label).toBe("committed");
    expect((loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts![`step_${i}`] as FactRecord).by, label).toBe("planner");
  }
  // An unbound client that names itself after a bound agent gets nothing and is only listed.
  const named = await mcp(jwt("steward", { client_name: "steward" }), "tools/list");
  expect(named.door).toBe(403);
  expect(listPending(root).map((p) => p.client_id)).toEqual(["steward"]);
  expect(loadOAuth(root)!.clients!.steward).toBeUndefined();
});

test("contract oauth: a token that doesn't hold up is refused before any binding is read", async () => {
  const { root, now, claims, jwt, mcp } = setup();
  bindClient(root, "c1", "helper");
  const good = claims("c1");
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const [h, , s] = jwt("c1").split(".");
  const { exp: _exp, ...noExp } = good;
  // Rows: token -> status (401 carries the invalid_token challenge; 403 is someone else's account).
  const rows: [string, string, number][] = [
    ["control: good token", jwt("c1"), 200],
    ["wrong audience", signJwt(as.key, as.kid, { ...good, aud: `${BASE}/mcp` }), 401],
    ["wrong issuer", signJwt(as.key, as.kid, { ...good, iss: "https://evil.test" }), 401],
    ["expired past leeway", signJwt(as.key, as.kid, { ...good, exp: now - 120 }), 401],
    ["no exp at all", signJwt(as.key, as.kid, noExp), 401],
    ["not valid yet", signJwt(as.key, as.kid, { ...good, nbf: now + 600 }), 401],
    ["signed by another key", signJwt(other, as.kid, good), 401],
    ["payload swapped under a good signature", `${h}.${b64({ ...good, client_id: "c2" })}.${s}`, 401],
    ["alg none", `${b64({ alg: "none" })}.${b64(good)}.`, 401],
    ["alg HS256 (not accepted)", `${b64({ alg: "HS256", kid: as.kid })}.${b64(good)}.${s}`, 401],
    ["not a JWT: a pasted pb_ token", issueToken(root, "helper"), 401],
    ["no client id", signJwt(as.key, as.kid, { ...good, client_id: undefined }), 401],
    ["someone else's account", signJwt(as.key, as.kid, { ...good, sub: "user_stranger" }), 403],
  ];
  for (const [label, token, want] of rows) {
    const r = await mcp(token, "tools/list");
    expect(r.status, label).toBe(want);
    if (want === 401) expect(r.www, label).toContain('error="invalid_token"');
  }
  expect(listPending(root)).toEqual([]); // a refused token is never "waiting"
});

test("contract oauth: the doors don't cross, and only /mcp/oauth advertises OAuth", async () => {
  const { root, jwt, mcp } = setup();
  bindClient(root, "c1", "helper");
  const pasted = issueToken(root, "helper");
  // Rows: (credential, path) -> status, challenge header.
  const rows: [string, string | undefined, string, number, boolean][] = [
    ["no token on /mcp/oauth", undefined, "/mcp/oauth", 401, true],
    ["OAuth token on /mcp", jwt("c1"), "/mcp", 401, false],
    ["pasted token on /mcp/oauth", pasted, "/mcp/oauth", 401, true],
    ["no token on /mcp (known limit: plain 401)", undefined, "/mcp", 401, false],
  ];
  for (const [label, token, path, want, challenged] of rows) {
    const r = await mcp(token, "tools/list", {}, path);
    expect(r.status, label).toBe(want);
    expect(r.www?.startsWith('Bearer resource_metadata="') ?? false, label).toBe(challenged);
  }
  const bare = makeBrain(); // no rules/oauth.yaml: no door at all
  expect((await handle(bare, new Request(RESOURCE, { method: "POST", headers: { authorization: `Bearer ${jwt("c1")}` } }))).status).toBe(404);
});

test("contract oauth: the owner's binding never carries to another account's token, even on a shared client id", async () => {
  const { root, jwt, mcp } = setup();
  bindClient(root, "c-shared", "planner");
  addCoworker(root, "user_alice", "Alice", "helper");
  bindMachine(root, "m2m-g", "gardener");
  // Rows: (sub, client) -> status. Bindings are per account, and a machine is only itself.
  const rows: [string, string, string, number][] = [
    ["the owner on her own binding", OWNER_SUB, "c-shared", 200],
    ["a coworker on the owner's client id", "user_alice", "c-shared", 403],
    ["a stranger on the owner's client id", "user_stranger", "c-shared", 403],
    ["a bound machine id with a person's subject", "user_stranger", "m2m-g", 403],
    ["a bound machine id with another app's subject", "m2m-other@clients", "m2m-g", 403],
  ];
  for (const [label, sub, client, want] of rows) expect((await mcp(jwt(client, { sub }), "tools/list")).door, label).toBe(want);
  expect(loadOAuth(root)!.coworkers!.user_alice.clients).toEqual({}); // Alice still waits for her own approval
});

test("contract oauth: revoked beats bound, and revoke on the agent cuts every kind of connection", async () => {
  const { root, jwt, mcp } = setup();
  bindClient(root, "c1", "helper");
  revokeClient(root, "c1");
  // A hand edit that binds it again doesn't bring it back: the revoked list is read first.
  const f = join(root, "rules/oauth.yaml");
  const c = YAML.parse(readFileSync(f, "utf8"));
  c.clients = { c1: { agent: "helper", bound: "2026-10-08" } };
  writeFileSync(f, YAML.stringify(c));
  const r = await mcp(jwt("c1"), "tools/list");
  expect([r.status, r.www]).toEqual([401, expect.stringContaining('error="invalid_token"')]);
  expect(listPending(root)).toEqual([]);
  expect(() => bindClient(root, "c1", "helper")).toThrow(/revoked/);
  // Rows: each connection bound to planner -> refused after revokeTokens(planner).
  bindClient(root, "c-own", "planner");
  addCoworker(root, "user_bob", "Bob", "steward");
  bindCoworkerClient(root, "user_bob", "c-bob");
  bindMachine(root, "m2m-g", "gardener");
  revokeTokens(root, "planner");
  revokeTokens(root, "steward");
  revokeTokens(root, "gardener");
  const rows: [string, string, Record<string, unknown>, number][] = [
    ["owner's client (revoked)", "c-own", {}, 401],
    ["coworker's client (coworker removed)", "c-bob", { sub: "user_bob" }, 403],
    ["machine (binding gone)", "m2m-g", { sub: "m2m-g@clients" }, 403],
  ];
  for (const [label, client, extra, want] of rows) expect((await mcp(jwt(client, extra), "tools/list")).status, label).toBe(want);
  expect(loadOAuth(root)!.revoked).toEqual(expect.arrayContaining(["c1", "c-own", "m2m-g"]));
});

test("contract oauth: the owner's kill switches and policy hold on /mcp/oauth (invariant 8)", async () => {
  const { root, jwt, mcp } = setup();
  bindClient(root, "c1", "planner");
  const p = join(root, "rules/policy.yaml");
  const orig = readFileSync(p, "utf8");
  // Rows: policy change -> tools/list status, and whether a write commits.
  const rows: [string, string, number, boolean][] = [
    ["control", orig, 200, true],
    ["read-only", orig.replace("planner: { tier: core,", "planner: { status: read-only, tier: core,"), 200, false],
    ["paused", orig.replace("planner: { tier: core,", "planner: { status: paused, tier: core,"), 403, false],
    ["moved inside the wall", orig.replace("planner: { tier: core,", "planner: { inside_wall: true, tier: core,"), 403, false],
    ["removed from policy", orig.replace(/^  planner:.*\n/m, ""), 403, false],
  ];
  for (const [i, [label, policy, want, writes]] of rows.entries()) {
    writeFileSync(p, policy);
    expect((await mcp(jwt("c1"), "tools/list")).status, label).toBe(want);
    const w = await mcp(jwt("c1"), "tools/call", remember(`k_${i}`));
    const committed = w.status === 200 && !w.json.result.isError && JSON.parse(w.json.result.content[0].text).outcome === "committed";
    expect(committed, label).toBe(writes);
  }
});

test("contract oauth: an approval window binds only the owner's own next new client, once", async () => {
  const { root, jwt, mcp } = setup();
  expect((await mcp(jwt("c-early"), "tools/list")).door).toBe(403); // waiting before the window
  await Bun.sleep(5);
  expectClient(root, "helper");
  // Rows, in order: (sub, client) -> status. Strangers and earlier clients never take the window.
  const rows: [string, string, string, number][] = [
    ["a stranger's new client", "user_stranger", "c-stranger", 403],
    ["a client already waiting before the window", OWNER_SUB, "c-early", 403],
    ["the owner's first new client", OWNER_SUB, "c-new", 200],
    ["the owner's second new client", OWNER_SUB, "c-next", 403],
  ];
  for (const [label, sub, client, want] of rows) expect((await mcp(jwt(client, { sub }), "tools/list")).door, label).toBe(want);
  const c = loadOAuth(root)!;
  expect(Object.fromEntries(Object.entries(c.clients!).map(([k, v]) => [k, v.agent]))).toEqual({ "c-new": "helper" });
  expect(c.expect).toBeUndefined();
});
