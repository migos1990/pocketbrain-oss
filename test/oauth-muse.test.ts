// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth door the way Muse uses it, end to end against an Auth0-shaped fake (test/fake-as.ts):
// dynamic registration on every connect, PKCE, refresh tokens that rotate, and calls that come in
// parallel. Muse is the trial agent here ("helper" in the example brain: Course A, no money).
// Earlier, another server saw Muse's fresh token refused right after a refresh; these tests pin
// the moments around a refresh so pocketBrain never does that.
import { test, expect, afterAll } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { setupOAuth, bindClient, listPending, expectClient, clearJwksCache } from "../src/oauth";
import { startFakeAS, connect, signJwt } from "./fake-as";

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const OWNER = "auth0|owner";
const REDIRECT = "https://muse.example/oauth/callback";
const as = startFakeAS(OWNER, { auth0: true, reuseGraceMs: 2000 });
afterAll(() => as.stop());

function setup() {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: OWNER, jwks_uri: `${as.issuer}jwks` });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  let id = 0;
  const mcp = async (token: string, method: string, params: unknown = {}, path = "/mcp/oauth") => {
    const res = await call(path, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  };
  const muse = () => connect(call, RESOURCE, { dcr: { client_name: "Muse", redirect_uri: REDIRECT } });
  return { root, call, mcp, muse };
}

test("Muse with an approval window: registers, signs in, and its first calls in parallel all get the trial slice", async () => {
  const { root, mcp, muse } = setup();
  expectClient(root, "helper", { name: "Muse" });
  const m = await muse();
  // Muse opens with initialize, tools/list and a first tool call at once.
  const [init, list, ctx] = await Promise.all([
    mcp(m.token(), "initialize"),
    mcp(m.token(), "tools/list"),
    mcp(m.token(), "tools/call", { name: "context_pack", arguments: {} }),
  ]);
  expect([init.status, list.status, ctx.status]).toEqual([200, 200, 200]);
  expect(ctx.json.result.content[0].text).toContain("Course A");
  expect(ctx.json.result.content[0].text).not.toContain("Maple Trust");
  expect((await mcp(m.token(), "tools/call", { name: "read", arguments: { id: "money/main-bank" } })).json.result.isError).toBe(true);
  expect(listPending(root)).toEqual([]); // approved, so nothing waits for the owner
});

test("a token fresh from a refresh works at once, also when the AS rotated its signing key moments earlier", async () => {
  const { root, mcp, muse } = setup();
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  expect((await mcp(m.token(), "tools/list")).status).toBe(200); // the hub now holds the AS's keys
  expect((await mcp(await m.refresh(), "tools/list")).status).toBe(200);
  as.rotateKey();
  const fresh = await m.refresh();
  expect((await mcp(fresh, "tools/list")).status).toBe(200);
  // A made-up key id is refused, and the real one keeps working right after.
  const [h, body, sig] = fresh.split(".");
  const fake = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(h, "base64url").toString()), kid: "nope" })).toString("base64url")}.${body}.${sig}`;
  expect((await mcp(fake, "tools/list")).status).toBe(401);
  expect((await mcp(fresh, "tools/call", { name: "search", arguments: { query: "course" } })).status).toBe(200);
});

test("two refreshes racing with one refresh token: both tokens work; the old access token keeps working until it expires", async () => {
  const { root, mcp, muse } = setup();
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  const before = m.token(), rt = m.refreshToken();
  const [a, b] = await Promise.all([m.refresh(rt), m.refresh(rt)]);
  const results = await Promise.all([a, b, before].map((t) => mcp(t, "tools/list")));
  expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
});

test("reconnecting registers a new client: it waits, and a window opened after it was seen doesn't approve it; bind does", async () => {
  const { root, mcp, muse } = setup();
  const first = await muse();
  bindClient(root, first.client_id, "helper", "Muse");
  const again = await muse();
  expect(again.client_id).not.toBe(first.client_id);
  const waiting = await mcp(again.token(), "initialize");
  // It gets the waiting session (request_access only), not the brain.
  expect(waiting.status).toBe(200);
  expect(waiting.json.result.instructions).toContain("waiting for the owner");
  expect(listPending(root).map((p) => p.client_id)).toEqual([again.client_id]);
  // A window opened now is for the next new sign-in, not one already waiting.
  expectClient(root, "helper", { name: "Muse" });
  expect((await mcp(again.token(), "tools/list")).json.result.tools.map((t: any) => t.name)).toEqual(["request_access"]);
  bindClient(root, again.client_id, "helper", "Muse");
  expect((await mcp(again.token(), "tools/list")).status).toBe(200);
  // The new one replaces the old one (backlog 289): cut here, listed for deletion at the AS.
  expect((await mcp(first.token(), "tools/list")).status).toBe(401);
});

test("a trailing slash on the door URL still gets the OAuth challenge and the same door", async () => {
  const { root, call, mcp, muse } = setup();
  const r = await call("/mcp/oauth/", { method: "POST" });
  expect(r.status).toBe(401);
  expect(r.headers.get("www-authenticate")).toContain("resource_metadata=");
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  expect((await mcp(m.token(), "tools/list", {}, "/mcp/oauth/")).status).toBe(200);
});

// Slice audit of claude/muse-oauth-e2e: the keys fetch must not follow every request.
test("a burst of tokens on a cold cache fetches the AS keys once, not once per token", async () => {
  const { root, mcp, muse } = setup();
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  clearJwksCache();
  as.hits.jwks = 0;
  const [h, body, sig] = m.token().split(".");
  const junk = (i: number) => `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(h, "base64url").toString()), kid: `junk${i}` })).toString("base64url")}.${body}.${sig}`;
  const rs = await Promise.all([...Array.from({ length: 20 }, (_, i) => mcp(junk(i), "tools/list")), mcp(m.token(), "tools/list")]);
  expect(rs.slice(0, 20).every((r) => r.status === 401)).toBe(true);
  expect(rs[20].status).toBe(200);
  expect(as.hits.jwks).toBeLessThanOrEqual(2); // the first fetch, at most one refetch for an unknown key id
});

test("while the AS is down, the hub keeps using the keys it has and stops asking on every request", async () => {
  const { root, mcp, muse } = setup();
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  expect((await mcp(m.token(), "tools/list")).status).toBe(200);
  // A token that outlives the keys' time to live (Auth0's default is a day).
  const now = Math.floor(Date.now() / 1000);
  const long = signJwt(as.key, as.kid, { iss: as.issuer, sub: OWNER, aud: [RESOURCE], azp: m.client_id, iat: now, exp: now + 3600 });
  m.token = () => long;
  as.down = true;
  try {
    as.hits.jwks = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + 11 * 60_000; // past the keys' time to live
    try {
      const rs = await Promise.all(Array.from({ length: 10 }, () => mcp(m.token(), "tools/list")));
      expect(rs.map((r) => r.status)).toEqual(Array(10).fill(200));
      for (let i = 0; i < 5; i++) expect((await mcp(m.token(), "tools/list")).status).toBe(200);
      expect(as.hits.jwks).toBeLessThanOrEqual(1);
    } finally { Date.now = realNow; }
    // A day on, still down: keys that old are no longer trusted.
    Date.now = () => realNow() + 25 * 3600_000;
    try {
      const day = signJwt(as.key, as.kid, { iss: as.issuer, sub: OWNER, aud: [RESOURCE], azp: m.client_id, iat: now + 25 * 3600, exp: now + 26 * 3600 });
      expect((await mcp(day, "tools/list")).status).toBe(401);
    } finally { Date.now = realNow; }
  } finally { as.down = false; }
});

test("with no keys yet and the AS down, requests are refused without a fetch each", async () => {
  const { root, mcp, muse } = setup();
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  clearJwksCache();
  as.down = true;
  try {
    const r1 = await mcp(m.token(), "tools/list");
    expect(r1.status).toBe(401);
    const before = as.hits.jwks;
    for (let i = 0; i < 5; i++) expect((await mcp(m.token(), "tools/list")).status).toBe(401);
    expect(as.hits.jwks).toBe(before);
  } finally { as.down = false; }
});

test("the AS metadata is looked up once, not on every request, when rules/oauth.yaml names no jwks_uri", async () => {
  const { root, mcp, muse } = setup();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: OWNER });
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  as.hits.metadata = 0;
  for (let i = 0; i < 5; i++) expect((await mcp(m.token(), "tools/list")).status).toBe(200);
  expect(as.hits.metadata).toBeLessThanOrEqual(1);
});

test("a looked-up key address doesn't outlive a day, and metadata naming another issuer drops it (audit F3)", async () => {
  const { root, mcp, muse } = setup();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: OWNER });
  const m = await muse();
  bindClient(root, m.client_id, "helper", "Muse");
  expect((await mcp(m.token(), "tools/list")).status).toBe(200);
  const realNow = Date.now;
  const now = Math.floor(realNow() / 1000);
  const later = (h: number) => signJwt(as.key, as.kid, { iss: as.issuer, sub: OWNER, aud: [RESOURCE], azp: m.client_id, iat: now + h * 3600, exp: now + h * 3600 + 300 });
  as.wrongIssuer = true;
  Date.now = () => realNow() + 11 * 60_000; // the address is due for a fresh look-up
  try { expect((await mcp(later(11 / 60), "tools/list")).status).toBe(401); }
  finally { Date.now = realNow; as.wrongIssuer = false; }
  clearJwksCache();
  expect((await mcp(m.token(), "tools/list")).status).toBe(200);
  as.down = true;
  Date.now = () => realNow() + 25 * 3600_000;
  try { expect((await mcp(later(25), "tools/list")).status).toBe(401); }
  finally { Date.now = realNow; as.down = false; }
});
