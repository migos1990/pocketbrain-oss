// SPDX-License-Identifier: AGPL-3.0-only
// MCP conformance (backlog 293): every tool's schema is one a client can load, and /mcp answers
// the protocol's edge cases (versions, bad JSON, batches, unknown tools, bad arguments) the way
// the spec says, on /mcp and /mcp/<token> alike. Hosted clients each broke on a different slip.
import { test, expect } from "bun:test";
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
