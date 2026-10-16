// SPDX-License-Identifier: AGPL-3.0-only
// Contract for the pasted-token door (src/auth.ts, and how src/server.ts uses it): the
// must-never properties of per-agent bearer tokens, as tables. A bug fixed in this surface
// adds a row here.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "../fixture";
import { handle } from "../../src/server";
import { issueToken, revokeTokens, tokenOwner } from "../../src/auth";
import { loadBrain, type FactRecord } from "../../src/brain";

const req = (root: string, path: string, init: RequestInit & { auth?: string } = {}) =>
  handle(root, new Request(`http://pb${path}`, { ...init, headers: init.auth === undefined ? {} : { authorization: init.auth } }));
const setPolicy = (root: string, from: string, to: string) => {
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, readFileSync(p, "utf8").replace(from, to));
};
const tools = (id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });

test("contract auth: identity comes from the token, never the body (invariant 2)", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  // Each row: a body field that claims another identity -> the fact and the commit are still Planner's.
  const claims: Record<string, unknown>[] = [{ agent: "steward" }, { agent: "owner" }, { by: "steward" }, { agent: "louis", as: "owner_editor" }];
  for (const [i, claim] of claims.entries()) {
    const value = `Publish grades ${i}`, attribute = `step_${i}`;
    const r = await req(root, "/v1/remember", { method: "POST", auth: `Bearer ${planner}`, body: JSON.stringify({ ...claim, id: "projects/course-a", attribute, value, as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" }) });
    expect((await r.json() as { outcome: string }).outcome, JSON.stringify(claim)).toBe("committed");
    const f = loadBrain(root).find((n) => n.fm.id === "projects/course-a")!.fm.facts![attribute] as FactRecord;
    expect([f.value, f.by], JSON.stringify(claim)).toEqual([value, "planner"]);
    expect(Bun.spawnSync(["git", "log", "-1", "--format=%an"], { cwd: root }).stdout.toString().trim()).toBe("planner");
  }
});

test("contract auth: anything but a live issued token gets the same plain 401, with no OAuth challenge", async () => {
  const root = makeBrain();
  const helper = issueToken(root, "helper");
  const steward = issueToken(root, "steward");
  const revoked = issueToken(root, "planner");
  revokeTokens(root, "planner");
  // Each row: how the request presents a credential -> 401, identical body, no WWW-Authenticate
  // (known limit: /mcp stays plain so Town never starts OAuth there).
  const rows: [string, string, string | undefined][] = [
    ["no header", "/v1/context", undefined],
    ["a guessed token with a real agent's prefix", "/v1/context", "Bearer pb_steward_guess"],
    ["a revoked token", "/v1/context", `Bearer ${revoked}`],
    ["a real token with one character changed", "/v1/context", `Bearer ${helper.slice(0, -1)}${helper.endsWith("A") ? "B" : "A"}`],
    ["a real token sent as Basic", "/v1/context", `Basic ${helper}`],
    ["a real token without a scheme", "/v1/context", helper],
    ["a real token in the query string", `/v1/context?token=${helper}`, undefined],
    ["a real token in a /v1 path (only /mcp takes one)", `/v1/${helper}`, undefined],
    ["a bad header never falls back to a good path token", `/mcp/${steward}`, "Bearer pb_steward_guess"],
    ["/mcp with no token", "/mcp", undefined],
  ];
  const bodies = new Set<string>();
  for (const [label, path, auth] of rows) {
    const r = await req(root, path, { method: path.startsWith("/mcp") ? "POST" : "GET", auth, body: path.startsWith("/mcp") ? tools() : undefined });
    expect(r.status, label).toBe(401);
    expect(r.headers.get("www-authenticate"), label).toBeNull();
    bodies.add(await r.text());
  }
  expect(bodies.size).toBe(1); // missing, unknown and revoked can't be told apart
});

test("contract auth: the brain stores only token hashes, and the token's prefix names nobody", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  const file = join(root, "rules/tokens.yaml");
  expect(readFileSync(file, "utf8")).not.toContain(planner);
  expect(readFileSync(file, "utf8")).not.toContain("pb_");
  // The hash's place in tokens.yaml decides the agent; "pb_planner_" in the text is cosmetic.
  writeFileSync(file, readFileSync(file, "utf8").replace(/^  planner:/m, "  helper:"));
  expect(tokenOwner(root, planner)?.agent).toBe("helper");
});

test("contract auth: only outside agents in policy.yaml hold tokens, checked on every request", async () => {
  const root = makeBrain();
  const helper = issueToken(root, "helper");
  // Rows: issuing for someone policy.yaml doesn't list as an outside agent -> refused.
  for (const agent of ["nobody", "owner", "louis"]) expect(() => issueToken(root, agent), agent).toThrow(/outside agent/);
  expect((await req(root, "/v1/context", { auth: `Bearer ${helper}` })).status).toBe(200);
  // Rows: the policy change after issue -> the token stops on its next request.
  setPolicy(root, "helper: { tier: trial,", "helper: { inside_wall: true, tier: trial,");
  expect((await req(root, "/v1/context", { auth: `Bearer ${helper}` })).status).toBe(401);
  setPolicy(root, "helper: { inside_wall: true, tier: trial,", "helper: { tier: trial,");
  expect((await req(root, "/v1/context", { auth: `Bearer ${helper}` })).status).toBe(200);
  setPolicy(root, "  helper: { tier: trial,", "  helper_gone: { tier: trial,");
  expect((await req(root, "/v1/context", { auth: `Bearer ${helper}` })).status).toBe(401);
});

test("contract auth: the owner's kill switches hold on every pasted-token path (invariant 8)", async () => {
  const root = makeBrain();
  const planner = issueToken(root, "planner");
  const remember = JSON.stringify({ id: "projects/course-a", attribute: "next_step", value: "Publish grades", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" });
  const call = (path: string, method = "GET", body?: string) => req(root, path, { method, body, auth: path.startsWith(`/mcp/${planner}`) ? undefined : `Bearer ${planner}` });
  // Rows: status -> (path, method) -> expected status.
  const rows: [string, string, string, string | undefined, number][] = [
    ["read-only", "/v1/search?q=course", "GET", undefined, 200],
    ["read-only", "/v1/remember", "POST", remember, 422],
    ["paused", "/v1/search?q=course", "GET", undefined, 403],
    ["paused", "/v1/remember", "POST", remember, 403],
    ["paused", "/mcp", "POST", tools(), 403],
    ["paused", `/mcp/${planner}`, "POST", tools(), 403],
  ];
  for (const [status, path, method, body, want] of rows) {
    setPolicy(root, /planner: \{ (status: [a-z-]+, )?tier: core,/.exec(readFileSync(join(root, "rules/policy.yaml"), "utf8"))![0], `planner: { status: ${status}, tier: core,`);
    expect((await call(path, method, body)).status, `${status} ${method} ${path.replace(planner, "<token>")}`).toBe(want);
  }
});

test("contract auth: a token's role narrows its routes, never widens them; an unknown role is no token (G18)", async () => {
  const root = makeBrain();
  const reader = issueToken(root, "steward", "reader");
  const resolver = issueToken(root, "steward", "resolver");
  const plain = issueToken(root, "steward");
  expect(() => issueToken(root, "helper", "resolver")).toThrow(/resolver/);
  // Rows: (token, path) -> status.
  const rows: [string, string, string, number][] = [
    ["reader", reader, "/v1/context", 200],
    ["reader", reader, "/v1/disputes", 403],
    ["reader", reader, "/v1/owner/messages", 403],
    ["resolver", resolver, "/v1/disputes", 200],
    ["resolver", resolver, "/v1/context", 403],
    ["resolver", resolver, "/mcp", 403],
    ["no role", plain, "/v1/disputes", 200],
    ["no role", plain, "/v1/context", 200],
  ];
  for (const [label, tok, path, want] of rows)
    expect((await req(root, path, { method: path === "/mcp" ? "POST" : "GET", body: path === "/mcp" ? tools() : undefined, auth: `Bearer ${tok}` })).status, `${label} ${path}`).toBe(want);
  const f = join(root, "rules/tokens.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace("role: reader", "role: admin"));
  expect((await req(root, "/v1/context", { auth: `Bearer ${reader}` })).status).toBe(401);
});

test("contract auth: revoke bites on the next request and leaves other agents alone", async () => {
  const root = makeBrain();
  const helper = [issueToken(root, "helper"), issueToken(root, "helper")];
  const planner = issueToken(root, "planner");
  expect(revokeTokens(root, "helper")).toBe(2);
  for (const t of helper) expect((await req(root, "/v1/context", { auth: `Bearer ${t}` })).status).toBe(401);
  expect((await req(root, "/v1/context", { auth: `Bearer ${planner}` })).status).toBe(200);
});
