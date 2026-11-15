// SPDX-License-Identifier: AGPL-3.0-only
// MCP conformance (backlog 293): every tool's schema is one a client can load, and /mcp answers
// the protocol's edge cases (versions, bad JSON, batches, unknown tools, bad arguments) the way
// the spec says, on /mcp and /mcp/<token> alike. Hosted clients each broke on a different slip.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { handle, allTools, SUPPORTED_PROTOCOLS } from "../src/server";
import { issueToken } from "../src/auth";
import { resetBudgets } from "../src/budget";

const TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);
function schemaProblems(t: { name: string; description?: string; inputSchema: any }): string[] {
  const out: string[] = [];
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) out.push(`${t.name}: bad name`);
  if (!t.description?.trim()) out.push(`${t.name}: no description`);
  const s = t.inputSchema;
  if (s?.type !== "object" || typeof s.properties !== "object" || Array.isArray(s.properties)) { out.push(`${t.name}: inputSchema must be an object schema`); return out; }
  const walk = (p: any, at: string) => {
    if (!p || typeof p !== "object") return out.push(`${at}: not a schema`);
    // An untyped property (any JSON value) is valid, but a model then needs the description to fill it.
    if (p.type === undefined && !p.enum && !p.anyOf) { if (!p.description?.trim()) out.push(`${at}: untyped and undescribed`); }
    else if (!p.enum && !p.anyOf && !(Array.isArray(p.type) ? p.type : [p.type]).every((x: unknown) => TYPES.has(String(x)))) out.push(`${at}: type ${JSON.stringify(p.type)}`);
    if (p.type === "array" && p.items) walk(p.items, `${at}[]`);
    if (p.type === "object" && p.properties) for (const [k, v] of Object.entries(p.properties)) walk(v, `${at}.${k}`);
    if (p.required && !(Array.isArray(p.required) && p.required.every((r: string) => p.properties && r in p.properties))) out.push(`${at}: required names a missing property`);
  };
  for (const [k, v] of Object.entries(s.properties)) walk(v, `${t.name}.${k}`);
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((r: string) => r in s.properties))) out.push(`${t.name}: required names a missing property`);
  return out;
}

test("every tool any agent can be offered has a loadable name, description and object input schema, and names are unique", () => {
  const tools = allTools();
  expect(tools.length).toBeGreaterThan(20);
  expect(tools.flatMap(schemaProblems)).toEqual([]);
  const names = tools.map((t) => t.name);
  expect(new Set(names).size).toBe(names.length);
});

const setup = () => {
  resetBudgets();
  const root = makeBrain();
  const tok = issueToken(root, "planner");
  const raw = (body: string, path = "/mcp") => handle(root, new Request(`http://pb${path}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body }));
  const rpc = async (method: string, params?: unknown, path?: string) => (await raw(JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }), path)).json();
  return { root, tok, raw, rpc };
};

test("initialize answers a version it supports: the client's when known, else the newest", async () => {
  const { rpc } = setup();
  expect((await rpc("initialize", { protocolVersion: "2025-03-26" })).result.protocolVersion).toBe("2025-03-26");
  expect((await rpc("initialize", { protocolVersion: "1999-01-01" })).result.protocolVersion).toBe(SUPPORTED_PROTOCOLS[0]);
  expect((await rpc("initialize", {})).result.protocolVersion).toBe(SUPPORTED_PROTOCOLS[0]);
});

test("bad JSON, a batch, or a message that isn't JSON-RPC 2.0 gets a JSON-RPC error, not a bare HTTP error", async () => {
  const { raw } = setup();
  const parse = await (await raw("{not json")).json();
  expect(parse).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32700 } });
  const batch = await (await raw(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]))).json();
  expect(batch).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
  const old = await (await raw(JSON.stringify({ jsonrpc: "1.0", id: 3, method: "ping" }))).json();
  expect(old).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32600 } });
});

test("a call without a tool name is a protocol error (-32602); an unknown tool is a tool error the model can read, on /mcp and /mcp/", async () => {
  const { rpc } = setup();
  for (const path of ["/mcp", "/mcp/"]) {
    expect((await rpc("tools/call", { arguments: {} }, path)).error?.code).toBe(-32602);
    // The spec allows either; a tool result reaches the model, a protocol error often doesn't.
    const r = await rpc("tools/call", { name: "no_such_tool", arguments: {} }, path);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toMatch(/unknown tool no_such_tool/);
  }
});

test("a missing required argument or a wrong type is a tool error naming the argument, and nothing runs", async () => {
  const { rpc } = setup();
  const missing = await rpc("tools/call", { name: "search", arguments: {} });
  expect(missing.result.isError).toBe(true);
  expect(missing.result.content[0].text).toMatch(/query is required/);
  const wrong = await rpc("tools/call", { name: "search", arguments: { query: "plans", limit: "lots" } });
  expect(wrong.result.isError).toBe(true);
  expect(wrong.result.content[0].text).toMatch(/limit must be a number/);
  const fine = await rpc("tools/call", { name: "search", arguments: { query: "plans", limit: 3 } });
  expect(fine.result.isError).toBe(false);
});

// MCP 2026-07-28 drops the initialize handshake: a client stamps every request with its version
// (header and params._meta), mirrors the method and the tool's name in headers, and may ask
// server/discover first. The door speaks both eras on one endpoint (G817): a stamped request is
// served statelessly, anything else exactly as before. A stamped request that is wrong gets one of
// the newer protocol's own errors with its HTTP status, so a client that speaks both stays modern
// and corrects itself; only a version the door doesn't speak is logged for the owner (G816).
const MODERN = "2026-07-28";
const META = "io.modelcontextprotocol/";
const calls = (root: string) => readFileSync(join(root, "log", "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { agent: string; tool: string; refused?: string });
// A well-formed modern request; `drop` and `headers` break it one part at a time.
const modernSetup = () => {
  const s = setup();
  const send = (method: string, params: Record<string, unknown> = {}, o: { headers?: Record<string, string | undefined>; meta?: Record<string, unknown> | null; version?: string; path?: string } = {}) => {
    const v = o.version ?? MODERN;
    const meta = o.meta === null ? undefined : { [`${META}protocolVersion`]: v, [`${META}clientInfo`]: { name: "test-client", version: "1" }, [`${META}clientCapabilities`]: {}, ...o.meta };
    const headers: Record<string, string | undefined> = { authorization: `Bearer ${s.tok}`, "content-type": "application/json", "MCP-Protocol-Version": v, "Mcp-Method": method, ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}), ...o.headers };
    const clean = Object.fromEntries(Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined));
    return handle(s.root, new Request(`http://pb${o.path ?? "/mcp"}`, { method: "POST", headers: clean, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method, params: { ...params, ...(meta ? { _meta: meta } : {}) } }) }));
  };
  return { ...s, send };
};

test("2026-07-28: server/discover names the versions, the capabilities and this agent's instructions, with no handshake", async () => {
  const { send, rpc } = modernSetup();
  const res = await send("server/discover");
  expect(res.status).toBe(200);
  const r = (await res.json()).result;
  expect(r.resultType).toBe("complete");
  expect(r.supportedVersions).toEqual([MODERN, ...SUPPORTED_PROTOCOLS]);
  expect(r.capabilities).toEqual({ tools: {}, prompts: {} });
  expect(r._meta[`${META}serverInfo`]).toMatchObject({ name: "pocketbrain" });
  expect(r.serverInfo).toBeUndefined();
  expect(r.ttlMs).toBe(0);
  expect(r.cacheScope).toBe("private");
  // The same five-line contract the handshake gives this agent.
  expect(r.instructions).toBe((await rpc("initialize", { protocolVersion: "2025-06-18" })).result.instructions);
});

test("2026-07-28: tools and prompts answer a stamped request with what the handshake protocols give the same token", async () => {
  const { send, rpc } = modernSetup();
  const list = (await (await send("tools/list")).json()).result;
  expect(list.resultType).toBe("complete");
  expect(list.ttlMs).toBe(0);
  expect(list.cacheScope).toBe("private");
  expect(list.tools).toEqual((await rpc("tools/list")).result.tools);
  const prompts = (await (await send("prompts/list")).json()).result;
  expect(prompts).toMatchObject({ resultType: "complete", ttlMs: 0, cacheScope: "private" });
  expect(prompts.prompts).toEqual((await rpc("prompts/list")).result.prompts);
  expect((await (await send("prompts/get", { name: "standing_instruction" })).json()).result.messages).toEqual((await rpc("prompts/get", { name: "standing_instruction" })).result.messages);
  const call = await send("tools/call", { name: "search", arguments: { query: "plans", limit: 3 } });
  expect(call.status).toBe(200);
  const got = (await call.json()).result;
  expect(got.resultType).toBe("complete");
  expect(got.isError).toBe(false);
  expect(got.ttlMs).toBeUndefined();
  expect(got.content).toEqual((await rpc("tools/call", { name: "search", arguments: { query: "plans", limit: 3 } })).result.content);
  // A tool name that isn't header-safe travels base64-encoded; the door decodes it before comparing.
  const odd = await send("tools/call", { name: "no such tool é", arguments: {} }, { headers: { "Mcp-Name": `=?base64?${Buffer.from("no such tool é").toString("base64")}?=` } });
  expect(odd.status).toBe(200);
  expect((await odd.json()).result.isError).toBe(true);
  // The handshake answers carry none of the newer protocol's fields.
  const old = (await rpc("tools/list")).result;
  expect([old.resultType, old.ttlMs, old.cacheScope, old._meta]).toEqual([undefined, undefined, undefined, undefined]);
});

test("2026-07-28: a stamped request that is wrong gets the newer protocol's own error and status, and nothing runs", async () => {
  const { root, send } = modernSetup();
  const write = { name: "remember", arguments: { title: "Stamped", attribute: "note", value: "must not be written", source: "agent:planner" } };
  const tries: [string, Response, number, number][] = [
    ["no version header", await send("tools/call", write, { headers: { "MCP-Protocol-Version": undefined } }), 400, -32020],
    ["header and _meta differ", await send("tools/call", write, { headers: { "MCP-Protocol-Version": "2025-06-18" } }), 400, -32020],
    ["no Mcp-Method", await send("tools/call", write, { headers: { "Mcp-Method": undefined } }), 400, -32020],
    ["another Mcp-Method", await send("tools/call", write, { headers: { "Mcp-Method": "tools/list" } }), 400, -32020],
    ["no Mcp-Name", await send("tools/call", write, { headers: { "Mcp-Name": undefined } }), 400, -32020],
    ["another Mcp-Name", await send("tools/call", write, { headers: { "Mcp-Name": "search" } }), 400, -32020],
    ["no version in _meta", await send("tools/call", write, { meta: { [`${META}protocolVersion`]: undefined } }), 400, -32602],
    ["no _meta", await send("tools/call", write, { meta: null }), 400, -32602],
    ["no client capabilities", await send("tools/call", write, { meta: { [`${META}clientCapabilities`]: undefined } }), 400, -32602],
    ["capabilities not an object", await send("tools/call", write, { meta: { [`${META}clientCapabilities`]: "all" } }), 400, -32602],
    ["bare discover", await send("server/discover", {}, { meta: null, headers: { "MCP-Protocol-Version": undefined, "Mcp-Method": undefined } }), 400, -32020],
    ["a later version", await send("tools/call", write, { version: "2027-01-15" }), 400, -32022],
    ["a later version in the header alone", await send("tools/call", write, { version: "2027-01-15", meta: null }), 400, -32022],
    ["a later version in _meta alone", await send("tools/call", write, { version: "2027-01-15", headers: { "MCP-Protocol-Version": undefined } }), 400, -32022],
    ["ping is gone", await send("ping"), 404, -32601],
    ["an unknown method", await send("resources/list"), 404, -32601],
  ];
  for (const [how, res, status, code] of tries) {
    const body = await res.json();
    expect([how, res.status, body.error?.code]).toEqual([how, status, code]);
    expect(body.result).toBeUndefined();
  }
  const later = await (await send("tools/list", {}, { version: "2027-01-15" })).json();
  expect(later.error.data).toEqual({ supported: [MODERN, ...SUPPORTED_PROTOCOLS], requested: "2027-01-15" });
  expect(Bun.spawnSync(["git", "-C", root, "log", "--oneline", "--grep", "Stamped"], { stdout: "pipe" }).stdout.toString()).toBe("");
  // Only the version the door doesn't speak is a line for the owner's self-check.
  expect(calls(root).filter((c) => /^mcp /.test(c.tool)).map((c) => [c.agent, c.tool])).toEqual([["planner", "mcp 2027-01-15 tools/call"], ["planner", "mcp 2027-01-15 tools/call"], ["planner", "mcp 2027-01-15 tools/call"], ["planner", "mcp 2027-01-15 tools/list"]]);
});

test("2026-07-28: the handshake still answers whatever the request is stamped with, and unstamped requests are unchanged", async () => {
  const { send, raw } = modernSetup();
  const init = await send("initialize", { protocolVersion: MODERN });
  expect(init.status).toBe(200);
  expect((await init.json()).result.protocolVersion).toBe(SUPPORTED_PROTOCOLS[0]);
  const ping = await raw(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  expect([ping.status, (await ping.json()).result]).toEqual([200, {}]);
  const unknown = await raw(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "resources/list" }));
  expect([unknown.status, (await unknown.json()).error.code]).toEqual([200, -32601]);
});

test("2026-07-28: what the client says about itself never changes who it is, and a paused agent is refused like before", async () => {
  const { root, send, raw } = modernSetup();
  const asOther = await send("tools/call", { name: "orientation", arguments: {} }, { meta: { [`${META}clientInfo`]: { name: "coach", version: "1" } } });
  const mine = await send("tools/call", { name: "orientation", arguments: {} });
  expect((await asOther.json()).result.content).toEqual((await mine.json()).result.content);
  const policy = join(root, "rules", "policy.yaml");
  writeFileSync(policy, readFileSync(policy, "utf8").replace("planner: { tier: core,", "planner: { status: paused, tier: core,"));
  const legacy = await raw(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const paused = await send("tools/list");
  expect(legacy.status).toBe(403);
  expect([paused.status, await paused.text()]).toEqual([legacy.status, await legacy.text()]);
});

test("what a client sends as its version or method never lands in the log as written: only a date and a known shape do", async () => {
  const { root, tok } = setup();
  const post = (body: unknown, headers: Record<string, string> = {}) => handle(root, new Request("http://pb/mcp", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
  // A version that is no date, or older than the stamped protocol, changes nothing: the door answers as before.
  expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "MCP-Protocol-Version": "2025-11-25" })).status).toBe(200);
  expect((await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { "MCP-Protocol-Version": "9999 people/jane-roy secret" })).status).toBe(200);
  expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": 20260728 } } })).status).toBe(200);
  expect((await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "MCP-Protocol-Version": "2999-99-99" })).status).toBe(200);
  // A later date is refused with the versions the door speaks; a method that isn't a plain name is logged as "other".
  const later = await post({ jsonrpc: "2.0", id: 4, method: "people/jane-roy says <hello>", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2027-01-15" } } }, { "MCP-Protocol-Version": "2027-01-15" });
  expect(later.status).toBe(400);
  expect(JSON.stringify(await later.json())).not.toContain("jane-roy");
  // An unknown method with no stamp stays a JSON-RPC "method not found", and is logged too.
  const unknown = await post({ jsonrpc: "2.0", id: 5, method: "resources/list" });
  expect(unknown.status).toBe(200);
  expect((await unknown.json()).error.code).toBe(-32601);
  expect(calls(root).map((c) => c.tool)).toEqual(["mcp 2027-01-15 other", "unknown method resources/list"]);
});

test("the daily self-check says once that an assistant asked for a protocol the hub doesn't speak, with who and which, for a day", async () => {
  const { root } = setup();
  const { selfChecks } = await import("../src/probe");
  const now = new Date("2026-11-14T12:00:00Z");
  const check = () => selfChecks(root, now).find((c) => c.name === "mcp_version");
  expect(check()).toBeUndefined();
  mkdirSync(join(root, "log"), { recursive: true });
  const line = (at: string, agent: string, tool: string) => appendFileSync(join(root, "log", "calls.jsonl"), `${JSON.stringify({ at, agent, tool, refused: "protocol version not spoken" })}\n`);
  const LATER = "2027-01-15";
  // Lines from before the hub spoke 2026-07-28 are no longer news, old or new.
  line("2026-11-14T07:00:00.000Z", "planner", `mcp ${MODERN} tools/list`);
  line("2026-11-14T07:00:01.000Z", "coach", "mcp unstamped server/discover");
  expect(check()).toBeUndefined();
  line("2026-11-12T08:00:00.000Z", "planner", `mcp ${LATER} tools/list`);
  line("2026-11-14T08:00:00.000Z", "planner", "search");
  expect(check()).toMatchObject({ ok: true });
  line("2026-11-14T09:00:00.000Z", "planner", `mcp ${LATER} tools/list`);
  line("2026-11-14T09:00:01.000Z", "planner", `mcp ${LATER} server/discover`);
  line("2026-11-14T09:30:00.000Z", "coach", `mcp ${LATER} tools/call`);
  const c = check()!;
  expect(c).toMatchObject({ ok: false, warn: true });
  expect(c.detail).toContain("3 requests");
  expect(c.detail).toContain(`planner (MCP ${LATER}: tools/list, server/discover)`);
  expect(c.detail).toContain(`coach (MCP ${LATER}: tools/call)`);
});
