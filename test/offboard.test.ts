// SPDX-License-Identifier: AGPL-3.0-only
// Offboarding follows the sign-in service (src/offboard.ts): a coworker blocked or deleted at the
// AS is refused at the brain on the next check, even with a token that hasn't expired; unblocked
// lets them back; the owner is alerted once; no answer for too long refuses them (fail closed).
import { test, expect, afterAll, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { setupOAuth, clearJwksCache, addCoworker, bindCoworkerClient, setManagement } from "../src/oauth";
import { startOffboarding, stopOffboarding, checkCoworkers } from "../src/offboard";
import { startFakeAS, startClientHost, connect } from "./fake-as";

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const as = startFakeAS("user_owner");
afterAll(() => { as.stop(); delete process.env.AUTH0_MGMT_CLIENT_SECRET; });
afterEach(() => stopOffboarding());

// The Management API, as a fetch stand-in: users by subject; null means deleted.
const users: Record<string, { blocked?: boolean } | null> = {};
let down = false;
const mgmt: typeof fetch = (async (input: string | URL | Request) => {
  const u = new URL(String(input));
  if (down) return new Response("down", { status: 503 });
  if (u.pathname.endsWith("/oauth/token")) return Response.json({ access_token: "mgmt" });
  const m = u.pathname.match(/\/api\/v2\/users\/(.+)$/);
  if (m) { const x = users[decodeURIComponent(m[1])]; return x ? Response.json({ user_id: m[1], ...x }) : new Response("", { status: 404 }); }
  return new Response("nope", { status: 404 });
}) as typeof fetch;

async function setup(maxAge = 600) {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const mcp = async (token: string) => {
    const res = await call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    return { status: res.status, json: await res.json().catch(() => undefined) as any };
  };
  const host = startClientHost("https://planner.example/api/mcp/oauth/callback");
  as.signedIn.sub = "user_alice";
  const alice = await connect(call, RESOURCE, { cimd: { client_id: host.clientId, redirect_uri: "https://planner.example/api/mcp/oauth/callback" } });
  as.signedIn.sub = "user_owner";
  addCoworker(root, "user_alice", "Alice", "helper");
  bindCoworkerClient(root, "user_alice", alice.client_id);
  setManagement(root, "m2m-1");
  if (maxAge !== 600) {
    const f = join(root, "rules", "oauth.yaml");
    await Bun.write(f, readFileSync(f, "utf8") + `coworker_max_age_s: ${maxAge}\n`);
  }
  process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
  return { root, mcp, alice, host };
}

const alerts = (root: string) => existsSync(join(root, "log", "alerts.jsonl")) ? readFileSync(join(root, "log", "alerts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a.check === "coworker_offboarded") : [];

test("blocked at the sign-in service: refused at the next check, alerted once, back when unblocked", async () => {
  const { root, mcp, alice, host } = await setup();
  try {
    users.user_alice = { blocked: false };
    expect(await startOffboarding(root, mgmt)).toBe(true);
    expect((await mcp(alice.token())).status).toBe(200);

    users.user_alice = { blocked: true };
    await checkCoworkers(root, mgmt);
    const cut = await mcp(alice.token());   // same unexpired token
    expect(cut.status).toBe(403);
    expect(cut.json.error_description).toContain("Alice's account is blocked");
    await checkCoworkers(root, mgmt);
    expect(alerts(root).length).toBe(1);
    expect(alerts(root)[0]).toMatchObject({ agent: "helper" });

    users.user_alice = { blocked: false };
    await checkCoworkers(root, mgmt);
    expect((await mcp(alice.token())).status).toBe(200);

    users.user_alice = null;
    await checkCoworkers(root, mgmt);
    expect((await mcp(alice.token())).json.error_description).toContain("deleted");
  } finally { host.stop(); }
});

test("no answer from the sign-in service for too long: coworkers are refused", async () => {
  const { root, mcp, alice, host } = await setup(0);
  try {
    users.user_alice = { blocked: false };
    down = true;
    await startOffboarding(root, mgmt);
    down = false;
    expect((await mcp(alice.token())).json.error_description).toContain("can't confirm Alice's account");
  } finally { host.stop(); down = false; }
});

test("without a management client nothing changes", async () => {
  const { root, mcp, alice, host } = await setup();
  try {
    delete process.env.AUTH0_MGMT_CLIENT_SECRET;
    expect(await startOffboarding(root, mgmt)).toBe(false);
    users.user_alice = { blocked: true };
    expect((await mcp(alice.token())).status).toBe(200);
  } finally { host.stop(); }
});
