// SPDX-License-Identifier: AGPL-3.0-only
// Onboarding protocol (docs/spec/agent-onboarding.md) steps a new agent takes on its own:
// discover the doors from the bare address, redeem a one-time invite code for its own token,
// and find its standing instruction inside its orientation so it can save it itself.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken, revokeTokens } from "../src/auth";
import { setupOAuth } from "../src/oauth";
import { createInvite, ENROLL_FAILS_PER_WINDOW, resetEnrollLimits } from "../src/invite";
import { main } from "../src/cli";
import { git } from "../src/git";

const BASE = "https://brain.test";
const call = async (root: string, path: string, init: RequestInit = {}) => {
  const r = await handle(root, new Request(BASE + path, init));
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: r.status, text, json };
};
const enroll = (root: string, code: unknown) => call(root, "/v1/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = console.log, err = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { out.push(a.join(" ")); };
  let code: number;
  try { code = main([...args, "--brain", root]); } finally { console.log = log; console.error = err; }
  return { code, out: out.join("\n") };
}

// ---------- step 4: the standing instruction is in the orientation ----------

test("orientation carries the standing instruction, for the agent to save itself; no key in it", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "helper");
  const api = await call(root, "/v1/orientation", { headers: { authorization: `Bearer ${tok}` } });
  expect(api.text).toContain("## Save this in your own instructions");
  expect(api.text).toContain("GET /v1/context?topic=<topic>");
  expect(api.text).not.toContain(tok);
  expect(api.text).not.toMatch(/pb_helper_/);
  const json = await call(root, "/v1/orientation?format=json", { headers: { authorization: `Bearer ${tok}` } });
  expect(json.json.standing_instruction).toContain("from your brain");
  // Over MCP it is the MCP variant, and it stays out of the short initialize text.
  const mcp = async (method: string, params: unknown = {}) => (await call(root, "/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json;
  const tool = (await mcp("tools/call", { name: "orientation", arguments: {} })).result.content[0].text;
  expect(tool).toContain("## Save this in your own instructions");
  expect(tool).toContain("call context_pack with the topic");
  expect((await mcp("initialize")).result.instructions).not.toContain("## Save this in your own instructions");
});

test("the API variant names the hub's public address when it has one", async () => {
  const root = makeBrain();
  const tok = issueToken(root, "helper");
  writeFileSync(join(root, "rules", "hub.yaml"), YAML.stringify({ hub: "mini", epoch: 1, replicas: { mini: {} }, public_url: "https://brain.example.org" }));
  const o = await call(root, "/v1/orientation?format=json", { headers: { authorization: `Bearer ${tok}` } });
  expect(o.json.standing_instruction).toContain("https://brain.example.org/v1");
});

test("the gardener's orientation has no standing instruction (it runs from its own setup)", async () => {
  const { orientation } = await import("../src/core");
  const root = makeBrain();
  expect(orientation(root, "gardener", "api").text).not.toContain("## Save this in your own instructions");
});

// ---------- step 1: discovery ----------

test("/.well-known/pocketbrain lists the doors, unauthenticated, and says nothing about the owner", async () => {
  const root = makeBrain();
  const d = await call(root, "/.well-known/pocketbrain");
  expect(d.status).toBe(200);
  expect(d.json.spec).toBe("agent-onboarding/0.1");
  expect(d.json.doors.mcp).toEqual({ url: `${BASE}/mcp`, auth: "bearer" });
  expect(d.json.doors.api).toMatchObject({ url: `${BASE}/v1`, auth: "bearer", openapi: `${BASE}/openapi.json` });
  expect(d.json.doors.mcp_oauth).toBeUndefined();
  expect(d.json.enroll).toEqual({ url: `${BASE}/v1/enroll`, method: "POST", body: { code: "<invite code from the owner>" } });
  expect(d.json.orientation).toEqual({ mcp: "orientation tool", api: `${BASE}/v1/orientation` });
  const owner = YAML.parse(readFileSync(join(root, "rules", "policy.yaml"), "utf8")).owner?.name;
  if (owner) expect(d.text).not.toContain(owner);
  for (const word of ["helper", "planner", "steward", "Course A", "Maple"]) expect(d.text).not.toContain(word);
  setupOAuth(root, { issuer: "https://as.example/", resource: `${BASE}/mcp/oauth`, owner_subject: "u" });
  const o = await call(root, "/.well-known/pocketbrain");
  expect(o.json.doors.mcp_oauth).toEqual({ url: `${BASE}/mcp/oauth`, auth: "oauth", resource_metadata: `${BASE}/.well-known/oauth-protected-resource/mcp/oauth` });
});

test("the discovery document uses the hub's public address when set", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "hub.yaml"), YAML.stringify({ hub: "mini", epoch: 1, replicas: { mini: {} }, public_url: "https://brain.example.org" }));
  const d = await call(root, "/.well-known/pocketbrain");
  expect(d.json.doors.mcp.url).toBe("https://brain.example.org/mcp");
});

// ---------- step 2: one-time invite codes ----------

test("an invite code is redeemed once for the agent's own token, which then works", async () => {
  resetEnrollLimits();
  const root = makeBrain();
  const inv = createInvite(root, "helper");
  expect(inv.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
  // Only a hash is kept, and the brain records the invite as an owner commit.
  expect(readFileSync(join(root, "rules", "invites.yaml"), "utf8")).not.toContain(inv.code);
  expect(git(root, ["log", "-1", "--format=%s", "--", "rules/invites.yaml"])).toContain("invite for helper");
  const r = await enroll(root, inv.code.toLowerCase().replace("-", " "));
  expect(r.status).toBe(200);
  expect(r.json.agent).toBe("helper");
  expect(r.json.token).toMatch(/^pb_helper_/);
  expect(r.json.read_first).toBe(`${BASE}/v1/orientation`);
  const o = await call(root, "/v1/orientation", { headers: { authorization: `Bearer ${r.json.token}` } });
  expect(o.status).toBe(200);
  // Used: a second redemption gets nothing.
  const again = await enroll(root, inv.code);
  expect(again.status).toBe(401);
  expect(again.text).not.toContain("pb_");
  expect(git(root, ["log", "-1", "--format=%s", "--", "rules/invites.yaml"])).toContain("used");
});

test("a wrong, expired or revoked invite gets nothing, and all three answer alike", async () => {
  resetEnrollLimits();
  const root = makeBrain();
  const wrong = await enroll(root, "ZZZZZ-ZZZZZ");
  const old = createInvite(root, "helper", { minutes: 15, now: new Date(Date.now() - 16 * 60_000) });
  const expired = await enroll(root, old.code);
  const cut = createInvite(root, "planner");
  revokeTokens(root, "planner");
  const revoked = await enroll(root, cut.code);
  for (const r of [wrong, expired, revoked]) { expect(r.status).toBe(401); expect(r.json).toEqual({ error: "that code isn't valid; ask the owner for a new one" }); }
  expect((await enroll(root, 12345)).status).toBe(400);
});

test("invites only for an outside, non-gardener agent that exists; the window is capped at an hour", () => {
  const root = makeBrain();
  expect(() => createInvite(root, "nobody")).toThrow(/policy.yaml/);
  expect(() => createInvite(root, "gardener")).toThrow(/gardener/);
  const inv = createInvite(root, "helper", { minutes: 600 });
  expect(Date.parse(inv.until) - Date.now()).toBeLessThanOrEqual(60 * 60_000 + 1000);
});

test("guessing is rate-limited: after too many wrong codes even the right one waits", async () => {
  resetEnrollLimits();
  const root = makeBrain();
  const inv = createInvite(root, "helper");
  for (let i = 0; i < ENROLL_FAILS_PER_WINDOW; i++) expect((await enroll(root, `AAAA${i % 10}-BBBBB`)).status).toBe(401);
  expect((await enroll(root, inv.code)).status).toBe(429);
  resetEnrollLimits();
  expect((await enroll(root, inv.code)).status).toBe(200);
});

test("pocketbrain invite and add --door invite print a code, never a token", () => {
  resetEnrollLimits();
  const root = makeBrain();
  const r = run(root, "invite", "helper", "--url", BASE);
  expect(r.code).toBe(0);
  expect(r.out).toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}/);
  expect(r.out).toContain(`${BASE}/v1/enroll`);
  expect(r.out).not.toMatch(/pb_helper_/);
  const a = run(root, "add", "newbot", "--slices", "area:work", "--door", "invite", "--url", BASE, "--yes");
  expect(a.code).toBe(0);
  expect(a.out).toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}/);
  expect(a.out).not.toMatch(/pb_newbot_/);
  expect(run(root, "invite", "nobody").code).not.toBe(0);
});
