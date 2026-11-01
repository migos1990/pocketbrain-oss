#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// A scripted stand-in for `claude -p` (EVAL_AGENT_CLI), so the paid multi-agent episodes can be
// checked without a model: same arguments, same MCP wiring (--mcp-config), same JSON on stdout.
// FAKE_AGENT_SCRIPT is a JSON file: { "<persona, lowercase>": { calls: [{ tool, args }], answer } }.
// The persona is the name after "You are" in --append-system-prompt. "{{handoff}}" in an argument
// is the last handoff id any tool result showed (whats_new, hand_off). Nothing here is clever: it
// replays the calls in order and prints the answer.
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const persona = (opt("--append-system-prompt") ?? "").match(/You are (\w+)/)?.[1]?.toLowerCase() ?? "";
const cfg = JSON.parse(readFileSync(opt("--mcp-config") ?? "", "utf8"));
const server = Object.values(cfg.mcpServers as Record<string, { url: string; headers?: Record<string, string> }>)[0];
const script = JSON.parse(readFileSync(process.env.FAKE_AGENT_SCRIPT ?? "", "utf8"))[persona] ?? { calls: [], answer: "" };

let handoff = "";
const fill = (v: unknown): unknown => typeof v === "string" ? v.replaceAll("{{handoff}}", handoff) : Array.isArray(v) ? v.map(fill) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)])) : v;
let n = 0;
for (const c of script.calls as { tool: string; args?: Record<string, unknown> }[]) {
  const res = await fetch(server.url, { method: "POST", headers: { "content-type": "application/json", ...(server.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name: c.tool, arguments: fill(c.args ?? {}) } }) });
  const text = await res.text();
  const id = text.match(/handoff id: (ho-[0-9]{14}-[a-z0-9]{4})/)?.[1];
  if (id) handoff = id;
}
console.log(JSON.stringify({ result: script.answer ?? "", total_cost_usd: 0, is_error: false }));
