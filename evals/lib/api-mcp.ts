// SPDX-License-Identifier: AGPL-3.0-only
// A stand-in for what a fresh API assistant has on switch day (evals/cases/switchday.ts), as an
// MCP server over stdio: an HTTP client for one origin, a keychain, and a memory of its own.
// A key the server hands out (POST /v1/enroll) goes into the keychain and is never shown to the
// agent; the keychain then signs every request to the origin. Keychain and memory are files, so
// they last from one conversation to the next, the way a hosted assistant keeps them.
//   bun evals/lib/api-mcp.ts   (PB_API_ORIGIN, PB_KEYCHAIN, PB_MEMORY)
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

const ORIGIN = process.env.PB_API_ORIGIN ?? "";
const KEYCHAIN = process.env.PB_KEYCHAIN ?? "";
const MEMORY = process.env.PB_MEMORY ?? "";
const MAX = 30_000;

const TOOLS = [
  { name: "http_request", description: "Send an HTTP request and get the status and body back. A key you were given is in your keychain and is sent for you; you never need to see or send it.", inputSchema: { type: "object", required: ["method", "url"], properties: { method: { type: "string", enum: ["GET", "POST"] }, url: { type: "string" }, body: { type: "object", description: "JSON body for POST" } } } },
  { name: "save_memory", description: "Save a note to your own memory. Your memory is shown to you at the start of every later conversation.", inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } } },
];

const keyIn = (keychain: string) => (keychain && existsSync(keychain) ? readFileSync(keychain, "utf8").trim() : "");
const key = () => keyIn(KEYCHAIN);

// Also used in-process by the scripted switch-day case, with its own origin and keychain.
export async function request(method: string, u: string, body?: unknown, origin = ORIGIN, keychain = KEYCHAIN): Promise<string> {
  const url = new URL(u, origin);
  if (url.origin !== origin) return `This client only reaches ${origin}.`;
  const k = keyIn(keychain);
  const res = await fetch(url, {
    method, headers: { ...(k ? { authorization: `Bearer ${k}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined && method !== "GET" ? { body: JSON.stringify(body) } : {}),
  });
  let text = await res.text();
  // The key from an enrollment goes to the keychain, never into the conversation.
  const issued = text.match(/"token"\s*:\s*"([^"]+)"/)?.[1];
  if (issued && keychain) { writeFileSync(keychain, issued); text = text.split(issued).join("[saved to your keychain]"); }
  if (k) text = text.split(k).join("[keychain]");
  return `HTTP ${res.status} ${url.pathname}${url.search}\n${text.slice(0, MAX)}`;
}

async function call(name: string, a: Record<string, any>): Promise<string> {
  if (name === "http_request") return request(String(a.method ?? "GET").toUpperCase(), String(a.url), a.body);
  if (name === "save_memory") {
    const text = String(a.text ?? "");
    const k = key();
    appendFileSync(MEMORY, `${k ? text.split(k).join("[keychain]") : text}\n`);
    return "Saved.";
  }
  throw new Error(`no tool ${name}`);
}

if (import.meta.main) {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id === undefined) continue; // notifications
      const reply = (result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\n");
      if (m.method === "initialize") reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "api", version: "0.1.0" } });
      else if (m.method === "tools/list") reply({ tools: TOOLS });
      else if (m.method === "tools/call") {
        try { reply({ content: [{ type: "text", text: await call(m.params.name, m.params.arguments ?? {}) }] }); }
        catch (e) { reply({ content: [{ type: "text", text: (e as Error).message }], isError: true }); }
      } else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } }) + "\n");
    }
  });
}
