// SPDX-License-Identifier: AGPL-3.0-only
// Reconnect without a new app piling up (backlog 289). claude.ai and Muse register a new OAuth
// client on every Reconnect, and Auth0's free tenant holds 10 apps. When the owner lets a new
// connection in as an agent that already has one, the old one is replaced: cut here at once, and
// listed for deletion at the sign-in service, which one owner click (or `oauth cleanup`) does.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { setupOAuth, bindClient, revokeClient, bindMachine, addCoworker, bindCoworkerClient, expectClient, loadOAuth, setManagement, cleanupReplaced, clearJwksCache } from "../src/oauth";
import { dashboardHandler, flashOf } from "../src/dashboard/server";
import { main } from "../src/cli";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { startFakeAS, connect } from "./fake-as";

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const OWNER = "auth0|owner";
const as = startFakeAS(OWNER, { auth0: true });

// A stand-in for Auth0's Management API, for the deletion half.
let mgmt: ReturnType<typeof Bun.serve>;
let mgmtBase = "";
const deleted: string[] = [];
beforeAll(() => {
  mgmt = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/oauth/token") return Response.json({ access_token: "mgmt-token" });
    const m = u.pathname.match(/^\/api\/v2\/clients\/(.+)$/);
    if (m && req.method === "DELETE" && req.headers.get("authorization") === "Bearer mgmt-token") { deleted.push(decodeURIComponent(m[1])); return new Response(null, { status: 204 }); }
    return new Response("not found", { status: 404 });
  } });
  mgmtBase = `http://127.0.0.1:${mgmt.port}/`;
});
afterAll(() => { as.stop(); mgmt.stop(true); delete process.env.AUTH0_MGMT_CLIENT_SECRET; });

function museDoor() {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: OWNER, jwks_uri: `${as.issuer}jwks` });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  // 200 when the connection reads the brain as helper; a waiting one (request_access only) is 403 here.
  const status = async (token: string) => {
    const r = await call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "context_pack", arguments: {} } }) });
    if (r.status !== 200) return r.status;
    return (await r.text()).includes("Course A") ? 200 : 403;
  };
  const muse = () => connect(call, RESOURCE, { dcr: { client_name: "Muse", redirect_uri: "https://muse.example/cb" } });
  return { root, status, muse };
}

test("two registrations for one agent: binding the second replaces the first, which stops working and waits for deletion", async () => {
  const { root, status, muse } = museDoor();
  const first = await muse();
  bindClient(root, first.client_id, "helper", "Muse");
  expect(await status(first.token())).toBe(200);
  // Reconnect: a brand-new client, waiting.
  const second = await muse();
  expect(second.client_id).not.toBe(first.client_id);
  expect(await status(second.token())).toBe(403);
  const replaced = bindClient(root, second.client_id, "helper");
  expect(replaced).toEqual([first.client_id]);
  expect(await status(second.token())).toBe(200);
  expect(await status(first.token())).toBe(401);
  const c = loadOAuth(root)!;
  expect(Object.keys(c.clients ?? {})).toEqual([second.client_id]);
  expect(c.clients![second.client_id].name).toBe("Muse"); // the label carries over
  expect(Object.keys(c.replaced ?? {})).toEqual([first.client_id]);
  expect(c.replaced![first.client_id].agent).toBe("helper");
  // A replace is not a revoke: the agent isn't flagged as coming back.
  expect(c.revoked_agents?.helper).toBeUndefined();
});

test("an approval window opened for the agent replaces its old connection the same way", async () => {
  const { root, status, muse } = museDoor();
  const first = await muse();
  bindClient(root, first.client_id, "helper");
  expectClient(root, "helper");
  const second = await muse();
  expect(await status(second.token())).toBe(200);
  expect(await status(first.token())).toBe(401);
  expect(Object.keys(loadOAuth(root)!.replaced ?? {})).toEqual([first.client_id]);
});

test("--keep-old keeps both connections, for an assistant that really has two", async () => {
  const { root, status, muse } = museDoor();
  const a = await muse(), b = await muse();
  bindClient(root, a.client_id, "helper");
  expect(bindClient(root, b.client_id, "helper", undefined, { keepOld: true })).toEqual([]);
  expect([await status(a.token()), await status(b.token())]).toEqual([200, 200]);
  expect(loadOAuth(root)!.replaced).toBeUndefined();
});

function stubDoor() {
  const root = makeBrain();
  setupOAuth(root, { issuer: mgmtBase, resource: "http://127.0.0.1:1/mcp/oauth", owner_subject: OWNER });
  bindClient(root, "c-old", "helper");
  bindClient(root, "c-new", "helper");
  return root;
}

test("cleanup deletes the replaced apps at the sign-in service and forgets them; without a management client it says how", async () => {
  const root = stubDoor();
  const none = await cleanupReplaced(root);
  expect(none.skipped).toContain("management client");
  expect(Object.keys(loadOAuth(root)!.replaced ?? {})).toEqual(["c-old"]);
  setManagement(root, "mgmt-app");
  process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
  const r = await cleanupReplaced(root);
  expect(r.deleted).toEqual(["c-old"]);
  expect(deleted).toContain("c-old");
  expect(deleted).not.toContain("c-new");
  expect(loadOAuth(root)!.replaced).toBeUndefined();
  expect(loadOAuth(root)!.revoked).toContain("c-old"); // still refused here
});

test("the dashboard lists replaced apps and deletes them in one click; oauth status lists them too", async () => {
  const root = stubDoor();
  setManagement(root, "mgmt-app");
  process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  try { main(["oauth", "status", "--brain", root]); } finally { console.log = log; }
  expect(out.join("\n")).toMatch(/replaced c-old \(helper/);
  const H = "127.0.0.1:8794";
  const d = dashboardHandler(root, { port: 8794, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0];
  const page = await (await d.handle(new Request(`http://${H}/agents`, { headers: { host: H, cookie } }))).text();
  expect(page).toContain("/action/oauth-cleanup");
  expect(page).toContain("c-old");
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1];
  const r = await d.handle(new Request(`http://${H}/action/oauth-cleanup`, { method: "POST", body: new URLSearchParams({ csrf }), headers: { host: H, cookie, origin: `http://${H}`, referer: `http://${H}/agents`, "content-type": "application/x-www-form-urlencoded" } }));
  expect(flashOf(r.headers.get("location") ?? "").ok).toContain("Deleted 1 old app");
  expect(loadOAuth(root)!.replaced).toBeUndefined();
  const after = await (await d.handle(new Request(`http://${H}/agents`, { headers: { host: H, cookie } }))).text();
  expect(after).not.toContain("/action/oauth-cleanup");
});

// The Gardener connects as a machine (client credentials, no person).
function addGardener(root: string) {
  const f = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.agents.gardener = { tier: "trial", role: "gardener", slices: ["area:work"] };
  writeFileSync(f, YAML.stringify(p));
}

function cli(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } catch (e) { out.push((e as Error).message); code = 1; } finally { console.log = log; console.error = error; }
  return { code, out: out.join("\n") };
}

test("the management app, a machine app and a coworker's app can't be bound to an agent, so a reconnect never retires them (audit F1)", () => {
  const root = stubDoor();
  setManagement(root, "mgmt-app");
  addGardener(root);
  bindMachine(root, "m-gardener", "gardener");
  addCoworker(root, "auth0|sam", "Sam", "planner");
  bindCoworkerClient(root, "auth0|sam", "c-sam");
  for (const id of ["mgmt-app", "m-gardener", "c-sam"]) expect(() => bindClient(root, id, "helper")).toThrow();
  const c = loadOAuth(root)!;
  expect(c.machines?.["m-gardener"]).toBeDefined();
  expect(c.revoked).not.toContain("m-gardener");
  expect(c.revoked).not.toContain("mgmt-app");
});

test("cleanup never deletes the management app, a machine app, a coworker's app or a bound one, even if replaced lists it (audit F1)", async () => {
  const root = stubDoor();
  setManagement(root, "mgmt-app");
  addGardener(root);
  bindMachine(root, "m-gardener", "gardener");
  addCoworker(root, "auth0|sam", "Sam", "planner");
  bindCoworkerClient(root, "auth0|sam", "c-sam");
  // A hand-edited or older oauth.yaml that lists them as replaced.
  const f = join(root, "rules", "oauth.yaml");
  const y = YAML.parse(readFileSync(f, "utf8"));
  for (const id of ["mgmt-app", "m-gardener", "c-sam", "c-new"]) y.replaced[id] = { agent: "helper", on: "2026-10-16" };
  writeFileSync(f, YAML.stringify(y));
  process.env.AUTH0_MGMT_CLIENT_SECRET = "s3cret";
  deleted.length = 0;
  const r = await cleanupReplaced(root);
  expect(r.deleted).toEqual(["c-old"]);
  expect(deleted).toEqual(["c-old"]);
});

test("a replace can be undone before cleanup: bind the old client again with --keep-old (audit F3, F4)", async () => {
  const { root, status, muse } = museDoor();
  const first = await muse();
  bindClient(root, first.client_id, "helper", "Muse");
  const second = await muse();
  const r = cli(root, "oauth", "bind", second.client_id, "--agent", "helper");
  expect(r.out).toContain(`oauth bind ${first.client_id} --agent helper --keep-old`);
  expect(await status(first.token())).toBe(401);
  expect(cli(root, "oauth", "bind", first.client_id, "--agent", "helper", "--keep-old").code).toBe(0);
  expect([await status(first.token()), await status(second.token())]).toEqual([200, 200]);
  const c = loadOAuth(root)!;
  expect(c.replaced).toBeUndefined();
  expect(c.revoked ?? []).not.toContain(first.client_id);
  // A plain revoke still can't be undone this way.
  revokeClient(root, first.client_id);
  expect(() => bindClient(root, first.client_id, "helper", undefined, { keepOld: true })).toThrow();
});

test("the dashboard's Approve says it replaces the agent's connection (audit F3)", async () => {
  const { root, status, muse } = museDoor();
  const m = await muse();
  await status(m.token()); // its first call puts it on the waiting list
  const H = "127.0.0.1:8795";
  const d = dashboardHandler(root, { port: 8795, loginKey: "k".repeat(32) });
  const r0 = await d.handle(new Request(`http://${H}/login?key=${"k".repeat(32)}`, { headers: { host: H } }));
  const cookie = r0.headers.get("set-cookie")!.split(";")[0];
  const page = await (await d.handle(new Request(`http://${H}/agents`, { headers: { host: H, cookie } }))).text();
  expect(page).toContain("/action/oauth-bind");
  expect(page).toMatch(/data-confirm="[^"]*replaces/);
});

test("client ids from a registration are printed without control characters (audit F6)", () => {
  const root = stubDoor();
  bindClient(root, "c-\u001b[2Jx‮", "helper");
  const r = cli(root, "oauth", "status");
  expect(r.out).not.toMatch(/[\u001b‮]/);
  expect(r.out).toContain("c-old");
});
