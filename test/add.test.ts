// SPDX-License-Identifier: AGPL-3.0-only
// `pocketbrain add`: a new agent in one command (docs/add-an-agent.md). It carves a trial
// slice, then either issues a pasted token or opens a short window in which the owner's own
// next OAuth sign-in is approved as that agent: one client, owner only, expires, on record.
import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { main } from "../src/cli";
import { handle } from "../src/server";
import { revokeTokens } from "../src/auth";
import { setupOAuth, listPending, loadOAuth, clearJwksCache, expectClient } from "../src/oauth";
import { git } from "../src/git";
import { startFakeAS, connect, signJwt } from "./fake-as";

const BASE = "https://brain.test";
const RESOURCE = `${BASE}/mcp/oauth`;
const as = startFakeAS("user_owner");
afterAll(() => as.stop());

function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } finally { console.log = log; console.error = err; }
  return { code, out: out.join("\n") };
}
const policy = (root: string) => YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).agents;

function oauthBrain() {
  clearJwksCache();
  const root = makeBrain();
  setupOAuth(root, { issuer: as.issuer, resource: RESOURCE, owner_subject: "user_owner" });
  const call = (path: string, init: RequestInit = {}) => handle(root, new Request(BASE + path, init));
  const mcp = async (token: string, method: string, params: unknown = {}) => {
    const res = await call("/mcp/oauth", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const text = await res.text();
    let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json };
  };
  const signIn = () => connect(call, RESOURCE, { dcr: { client_name: "Newbot", redirect_uri: "https://agent.example/cb" } });
  return { root, mcp, signIn };
}

test("without --yes it only previews: nothing is granted, no token", () => {
  const root = makeBrain();
  const r = run(root, "add", "newbot", "--slices", "area:work,contacts-basic");
  expect(r.code).toBe(0);
  expect(r.out).toContain("--yes");
  expect(policy(root).newbot).toBeUndefined();
  expect(r.out).not.toContain("pb_newbot_");
});

test("--door mcp grants a trial slice without money, prints the token and the standing instruction", () => {
  const root = makeBrain();
  const r = run(root, "add", "newbot", "--slices", "area:work,contacts-basic", "--door", "mcp", "--url", BASE, "--yes");
  expect(r.code).toBe(0);
  expect(policy(root).newbot).toEqual({ tier: "trial", transport: "mcp", slices: ["area:work", "contacts-basic"], exclude_types: ["money"] });
  expect(r.out).toMatch(/Authorization: Bearer pb_newbot_/);
  expect(r.out).toContain(`${BASE}/mcp`);
  expect(r.out).toContain("context_pack");
  expect(readFileSync(join(root, "rules", "tokens.yaml"), "utf8")).toContain("newbot");
});

test("--door api records transport api and prints the JSON API instruction", () => {
  const root = makeBrain();
  const r = run(root, "add", "newbot", "--slices", "area:work", "--door", "api", "--url", BASE, "--yes");
  expect(r.code).toBe(0);
  expect(policy(root).newbot.transport).toBe("api");
  expect(r.out).toContain(`${BASE}/v1`);
  expect(r.out).toContain("/v1/orientation");
});

test("refuses an existing agent, the all slice, unknown slices and odd names; nothing written", () => {
  const root = makeBrain();
  const before = readFileSync(join(root, "rules", "policy.yaml"), "utf8");
  expect(run(root, "add", "helper", "--slices", "area:work", "--yes").code).not.toBe(0);
  expect(run(root, "add", "newbot", "--slices", "all", "--yes").code).not.toBe(0);
  expect(run(root, "add", "newbot", "--slices", "nope", "--yes").code).not.toBe(0);
  expect(run(root, "add", "New Bot!", "--slices", "area:work", "--yes").code).not.toBe(0);
  expect(run(root, "add", "newbot", "--yes").code).not.toBe(0); // slices are required
  expect(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).toBe(before);
});

test("--door oauth issues no token and approves exactly one new sign-in by the owner", async () => {
  const { root, mcp, signIn } = oauthBrain();
  const r = run(root, "add", "newbot", "--slices", "area:work,contacts-basic", "--door", "oauth", "--url", BASE, "--yes");
  expect(r.code).toBe(0);
  expect(r.out).not.toContain("pb_newbot_");
  expect(r.out).toContain(RESOURCE);
  expect(r.out).toContain("10 minutes");
  expect(loadOAuth(root)!.expect?.agent).toBe("newbot");

  const first = await signIn();
  const init = await mcp(first.token(), "initialize");
  expect(init.status).toBe(200);
  expect(loadOAuth(root)!.clients?.[first.client_id]?.agent).toBe("newbot");
  expect(loadOAuth(root)!.expect).toBeUndefined(); // one client only
  const ctx = await mcp(first.token(), "tools/call", { name: "context_pack", arguments: {} });
  expect(ctx.json.result.content[0].text).toContain("Course A");
  expect(ctx.json.result.content[0].text).not.toContain("Maple Trust");
  // On record: a commit in the brain says which client was approved, and how.
  expect(git(root, ["log", "-1", "--format=%s", "--", "rules/oauth.yaml"])).toContain(`${first.client_id} approved as newbot`);

  // A second sign-in in the same ten minutes waits for the owner, as before.
  const second = await signIn();
  expect((await mcp(second.token(), "initialize")).json.result.instructions).toContain("waiting for the owner"); // not let in: the waiting session only
  expect(listPending(root).map((p) => p.client_id)).toEqual([second.client_id]);
});

test("the window is for the owner's account only: anyone else is refused and the window stays open", async () => {
  const { root, mcp, signIn } = oauthBrain();
  run(root, "add", "newbot", "--slices", "area:work", "--door", "oauth", "--url", BASE, "--yes");
  const c = await signIn();
  const now = Math.floor(Date.now() / 1000);
  const stranger = signJwt(as.key, as.kid, { iss: as.issuer, sub: "user_stranger", aud: RESOURCE, client_id: c.client_id, iat: now, exp: now + 300 });
  expect((await mcp(stranger, "initialize")).status).toBe(403);
  expect(loadOAuth(root)!.clients?.[c.client_id]).toBeUndefined();
  expect(loadOAuth(root)!.expect?.agent).toBe("newbot");
});

test("an expired window approves nothing", async () => {
  const { root, mcp, signIn } = oauthBrain();
  run(root, "add", "newbot", "--slices", "area:work", "--door", "oauth", "--url", BASE, "--yes");
  expectClient(root, "newbot", { minutes: 10, now: new Date(Date.now() - 11 * 60_000) });
  const c = await signIn();
  expect((await mcp(c.token(), "initialize")).json.result.instructions).toContain("waiting for the owner"); // not let in: the waiting session only
  expect(loadOAuth(root)!.clients?.[c.client_id]).toBeUndefined();
});

test("a connection already waiting before the window opened is not swept in", async () => {
  const { root, mcp, signIn } = oauthBrain();
  const old = await signIn();
  expect((await mcp(old.token(), "initialize")).json.result.instructions).toContain("waiting for the owner"); // not let in: the waiting session only
  await Bun.sleep(5);
  run(root, "add", "newbot", "--slices", "area:work", "--door", "oauth", "--url", BASE, "--yes");
  expect((await mcp(old.token(), "initialize")).json.result.instructions).toContain("waiting for the owner"); // not let in: the waiting session only
  expect(loadOAuth(root)!.clients?.[old.client_id]).toBeUndefined();
  const fresh = await signIn();
  expect((await mcp(fresh.token(), "initialize")).json.result.instructions).not.toContain("waiting for the owner");
});

test("revoking the agent closes its open window", async () => {
  const { root, mcp, signIn } = oauthBrain();
  run(root, "add", "newbot", "--slices", "area:work", "--door", "oauth", "--url", BASE, "--yes");
  revokeTokens(root, "newbot");
  expect(loadOAuth(root)!.expect).toBeUndefined();
  const c = await signIn();
  expect((await mcp(c.token(), "initialize")).json.result.instructions).toContain("waiting for the owner"); // not let in: the waiting session only
});

test("oauth expect reopens the window for an existing agent (after a reconnect)", async () => {
  const { root, mcp, signIn } = oauthBrain();
  expect(run(root, "oauth", "expect", "nobody").code).not.toBe(0);
  const r = run(root, "oauth", "expect", "helper", "--name", "Helper");
  expect(r.code).toBe(0);
  const c = await signIn();
  expect((await mcp(c.token(), "initialize")).json.result.instructions).not.toContain("waiting for the owner");
  expect(loadOAuth(root)!.clients?.[c.client_id]).toMatchObject({ agent: "helper", name: "Helper" });
});
