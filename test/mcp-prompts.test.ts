// SPDX-License-Identifier: AGPL-3.0-only
// MCP prompts (backlog row 344): clients that offer prompts (a "/" menu, an attach button) can load
// the standing instruction and the start-of-conversation routine in one click instead of the owner
// pasting them. The text is the same block `pocketbrain connect` prints (src/orientation.ts), so
// there is one wording to keep right.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { loadRules, ownerName } from "../src/rules";
import { standingInstruction } from "../src/orientation";

function setup() {
  const root = makeBrain();
  const tok = issueToken(root, "planner");
  const mcp = async (method: string, params?: unknown, token: string | undefined = tok) => {
    const res = await handle(root, new Request("http://pb/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }), headers: token ? { authorization: `Bearer ${token}` } : {} }));
    return { status: res.status, json: await res.json().catch(() => undefined) as any };
  };
  return { root, mcp };
}

test("initialize says the server has prompts, and prompts/list names both with the owner's name", async () => {
  const { root, mcp } = setup();
  expect((await mcp("initialize", { protocolVersion: "2025-06-18" })).json.result.capabilities.prompts).toEqual({});
  const list = (await mcp("prompts/list")).json.result.prompts;
  expect(list.map((p: any) => p.name)).toEqual(["standing_instruction", "start_conversation"]);
  const owner = ownerName(loadRules(root));
  for (const p of list) { expect(p.description).toContain(owner); expect(p.arguments ?? []).toEqual([]); }
});

test("prompts/get gives the standing instruction exactly as connect prints it, and the start routine", async () => {
  const { root, mcp } = setup();
  const si = (await mcp("prompts/get", { name: "standing_instruction" })).json.result;
  expect(si.messages).toEqual([{ role: "user", content: { type: "text", text: expect.any(String) } }]);
  expect(si.messages[0].content.text).toContain(standingInstruction(loadRules(root), "mcp"));
  const start = (await mcp("prompts/get", { name: "start_conversation" })).json.result.messages[0].content.text;
  for (const w of ["orientation", "whats_new", "memory_check"]) expect(start).toContain(w);
});

test("an unknown prompt is a JSON-RPC error, and no token gets nothing", async () => {
  const { mcp } = setup();
  expect((await mcp("prompts/get", { name: "nope" })).json.error.code).toBe(-32602);
  expect((await mcp("prompts/get", {})).json.error.code).toBe(-32602);
  expect((await mcp("prompts/list", undefined, "")).status).toBe(401);
});
