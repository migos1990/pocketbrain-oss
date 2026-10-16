#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
// Checks a running hub from the outside, the way an agent sees it:
//   bun scripts/smoke.ts https://<tunnel-url> <agent token> [topic]
// It connects over MCP, lists tools, pulls a carved context, and confirms that a note
// outside the carve answers like a missing one. It writes nothing.
export {};
const [base, token, topic = "Work"] = process.argv.slice(2);
if (!base || !token) { console.error("usage: bun scripts/smoke.ts <url> <token> [topic]"); process.exit(2); }
const url = base.replace(/\/+$/, "");
let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const rpc = async (id: number, method: string, params?: unknown) => {
  const r = await fetch(`${url}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  return { status: r.status, json: await r.json().catch(() => undefined) as any };
};

const health = await fetch(`${url}/health`).then((r) => r.ok).catch(() => false);
check("hub reachable", health, url);
const noTok = await fetch(`${url}/v1/context`).then((r) => r.status).catch(() => 0);
check("no token is refused", noTok === 401, String(noTok));
const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
check("MCP initialize", init.status === 200 && !!init.json?.result, init.json?.result?.instructions?.split("\n")[0] ?? `status ${init.status}`);
const tools = await rpc(2, "tools/list");
const names: string[] = (tools.json?.result?.tools ?? []).map((t: any) => t.name);
check("tools listed", ["orientation", "context_pack", "search", "read", "remember", "retire"].every((n) => names.includes(n)), names.join(", "));
check("orientation names this agent", /^# You are \S+/.test(init.json?.result?.instructions ?? ""), (init.json?.result?.instructions ?? "").split("\n")[0]);
const ctx = await rpc(3, "tools/call", { name: "context_pack", arguments: { topic } });
const text: string = ctx.json?.result?.content?.[0]?.text ?? "";
check(`context for "${topic}"`, text.length > 0, text.split("\n").find((l) => / of the \d+ notes/.test(l)) ?? `${text.length} chars`);
const hidden = await rpc(4, "tools/call", { name: "read", arguments: { id: "money/does-not-matter" } });
check("outside the carve reads as missing", hidden.json?.result?.isError === true, hidden.json?.result?.content?.[0]?.text);
console.log(ok ? "\nAll good: this agent can reach its slice and nothing else answered." : "\nSomething failed; see above.");
process.exit(ok ? 0 : 1);
