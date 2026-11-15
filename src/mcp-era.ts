// SPDX-License-Identifier: AGPL-3.0-only
// Which MCP era a request on the hub's MCP door belongs to, and whether a modern one is well formed
// (docs/hub.md "MCP 2026-07-28", G817). The handshake protocols (2025-06-18 and earlier) open with
// initialize; 2026-07-28 has no handshake: every request carries its version in a header and in
// params._meta, mirrors its method and the tool's name in headers, and names the client's
// capabilities. The door serves both on one endpoint, picked by how the request opens. Nothing
// here reads who the caller is: identity is the token's, never the client's own name.
import { MODERN_PROTOCOLS, modernMcp } from "./calls";

// Newest first. LEGACY are the handshake protocols initialize answers with.
export const LEGACY_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const ALL_PROTOCOLS = [...MODERN_PROTOCOLS, ...LEGACY_PROTOCOLS];
export const SERVER_INFO = { name: "pocketbrain", version: "0.1.0" };
const NS = "io.modelcontextprotocol/";
// The newer protocol's own error codes, with the JSON-RPC ones it gives an HTTP status.
export const UNSUPPORTED_VERSION = -32022;
const HEADER_MISMATCH = -32020, INVALID_PARAMS = -32602;
// Methods whose params.name is mirrored in the Mcp-Name header.
const NAMED = new Set(["tools/call", "prompts/get"]);

export interface Refusal { status: number; code: number; message: string; data?: Record<string, unknown>; version?: string }
export type Era = { modern: false } | { modern: true; version: string; refuse?: undefined } | { modern: true; refuse: Refusal };

// An Mcp-Name value as the client meant it: `=?base64?…?=` carries a name that isn't header-safe.
export function headerValue(v: string): string {
  const m = v.match(/^=\?base64\?([A-Za-z0-9+/]*={0,2})\?=$/);
  return m ? Buffer.from(m[1], "base64").toString("utf8") : v;
}
// The header form of a name, for a client (the stdio bridge) that builds the headers from a body.
export const toHeaderValue = (v: string) => /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(v) && !/^=\?base64\?.*\?=$/.test(v) ? v : `=?base64?${Buffer.from(v, "utf8").toString("base64")}?=`;

export function mcpEra(headers: Headers, msg: { method?: unknown; params?: unknown }): Era {
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params as Record<string, unknown> : {};
  const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta as Record<string, unknown> : undefined;
  const head = headers.get("mcp-protocol-version") ?? undefined;
  const inMeta = meta?.[`${NS}protocolVersion`];
  // The handshake always answers, whatever it is stamped with: it is how a legacy client opens.
  if (msg.method === "initialize") return { modern: false };
  if (!modernMcp(head) && !modernMcp(inMeta) && msg.method !== "server/discover") return { modern: false };
  const bad = (code: number, message: string, extra: Partial<Refusal> = {}): Era => ({ modern: true, refuse: { status: 400, code, message, ...extra } });
  // A version later than the door speaks, wherever it is stamped, is said first: that client needs
  // the list of versions more than a note about its headers, and the owner's self-check counts it.
  const later = [head, inMeta].find((v): v is string => modernMcp(v) && !MODERN_PROTOCOLS.includes(v));
  if (later) return bad(UNSUPPORTED_VERSION, "Unsupported protocol version", { data: { supported: ALL_PROTOCOLS, requested: later }, version: later });
  if (head === undefined) return bad(HEADER_MISMATCH, "Header mismatch: the MCP-Protocol-Version header is missing");
  if (typeof inMeta === "string" && inMeta !== head) return bad(HEADER_MISMATCH, "Header mismatch: the MCP-Protocol-Version header and the version in _meta differ");
  if (typeof inMeta !== "string") return bad(INVALID_PARAMS, `invalid params: _meta needs ${NS}protocolVersion`);
  // Reached only by a server/discover stamped with something that is no 2026-07-28-or-later date.
  if (!MODERN_PROTOCOLS.includes(head)) {
    // Only a version that reads as a date is said back; anything else is the client's own text.
    const dated = /^\d{4}-\d{2}-\d{2}$/.test(head) && !Number.isNaN(Date.parse(head));
    return bad(UNSUPPORTED_VERSION, "Unsupported protocol version", { data: { supported: ALL_PROTOCOLS, requested: dated ? head : "" } });
  }
  const method = headers.get("mcp-method");
  if (method === null) return bad(HEADER_MISMATCH, "Header mismatch: the Mcp-Method header is missing");
  if (method !== msg.method) return bad(HEADER_MISMATCH, "Header mismatch: the Mcp-Method header and the body's method differ");
  if (typeof msg.method === "string" && NAMED.has(msg.method) && typeof params.name === "string") {
    const name = headers.get("mcp-name");
    if (name === null) return bad(HEADER_MISMATCH, "Header mismatch: the Mcp-Name header is missing");
    if (headerValue(name) !== params.name) return bad(HEADER_MISMATCH, "Header mismatch: the Mcp-Name header and the body's name differ");
  }
  const caps = meta?.[`${NS}clientCapabilities`];
  if (!caps || typeof caps !== "object" || Array.isArray(caps)) return bad(INVALID_PARAMS, `invalid params: _meta needs ${NS}clientCapabilities`);
  return { modern: true, version: head };
}

// A modern result: every one says it is complete and names the server; the lists and discover
// also say they may not be reused (each differs per agent, and a pause must show on the next call).
export const modernResult = (result: Record<string, unknown>, cacheable = false) => ({
  resultType: "complete", ...result, ...(cacheable ? { ttlMs: 0, cacheScope: "private" } : {}),
  _meta: { ...(result._meta && typeof result._meta === "object" ? result._meta as object : {}), [`${NS}serverInfo`]: SERVER_INFO },
});

// The headers a modern request needs, built from its body: stdio carries none (src/local-apps.ts).
export function modernHeaders(msg: { method?: unknown; params?: unknown }): Record<string, string> {
  const params = msg.params && typeof msg.params === "object" && !Array.isArray(msg.params) ? msg.params as Record<string, unknown> : {};
  const meta = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta as Record<string, unknown> : undefined;
  const v = meta?.[`${NS}protocolVersion`];
  if (!modernMcp(v) || typeof msg.method !== "string" || !/^[A-Za-z_/]{1,64}$/.test(msg.method)) return {};
  return { "mcp-protocol-version": v, "mcp-method": msg.method, ...(NAMED.has(msg.method) && typeof params.name === "string" ? { "mcp-name": toHeaderValue(params.name) } : {}) };
}
