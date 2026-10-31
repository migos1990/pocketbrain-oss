// SPDX-License-Identifier: AGPL-3.0-only
// Request ids (backlog #300, docs/request-ids.md): one handle per request through the hub.
// src/server.ts makes the id when a request arrives (never the client's own: an agent could reuse
// another's), answers with it as X-Request-Id and writes one line to log/requests.jsonl. Inside
// the request, every commit gets a `Request-Id:` trailer (src/git.ts) and every jsonl log line a
// `request_id` (src/util.ts appendJsonl, src/readlog.ts appendChained), so `pocketbrain trace <id>`
// (src/trace.ts) can put the path back together. The id travels with the async context, so
// writes queued through `serial` keep it; work picked up later (the after-check) carries its own.
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";

export const REQUEST_ID = /^req_[0-9a-f]{20}$/;
export interface RequestCtx { id: string; door?: string; agent?: string; tool?: string }

const als = new AsyncLocalStorage<RequestCtx>();
export const newRequestId = () => `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
export const currentRequest = (): RequestCtx | undefined => als.getStore();
export const requestId = (): string | undefined => als.getStore()?.id;
export function withRequest<T>(ctx: RequestCtx, fn: () => T): T { return als.run(ctx, fn); }
// Work picked up later for a request (an after-check from the queue) runs under that request's
// id, or under none: never under whichever request happened to start the pickup.
export function asRequest<T>(id: string | undefined, fn: () => T): T { return id ? als.run({ id, door: "after-check" }, fn) : als.exit(fn); }
// What the request turned out to be once the door knows (the agent, the MCP tool).
export function noteRequest(fields: Partial<Omit<RequestCtx, "id">>) {
  const c = als.getStore();
  if (c) Object.assign(c, fields);
}

export const requestsFile = (root: string) => join(root, "log", "requests.jsonl");
export interface RequestLine { at: string; request_id: string; door: string; method: string; route: string; agent?: string; tool?: string; status: number; ms: number }

// Words a logged route may keep: the hub's own fixed route names. Every other segment (a note id,
// an action id, a token, anything a stranger typed) is logged as `:x`, so a path can never carry
// a secret into log/requests.jsonl (G337).
const ROUTE_WORDS = new Set(["v1", "notes", "mcp", "oauth", "b", "enroll", "dashboard", "health", "orientation", "changes", "context", "search", "who", "why",
  "handoffs", "done", "remember", "retire", "logs", "capture", "gardener", "last", "upkeep", "sleep", "memory-sync", "verify", "memory-check", "ask", "act",
  "disputes", "resolve", "escalate", "answer", "owner", "louis", "login", "logout", "register", "authorize", "token", "revoke", "jwks", "callback",
  ".well-known", "memory-passport", "oauth-authorization-server", "openid-configuration", "pocketbrain", "openapi.json"]);
export function routeOf(path: string): string {
  const segs = path.split("/").slice(1, 9).map((s) => (ROUTE_WORDS.has(s) ? s : ":x"));
  return "/" + segs.join("/");
}

// The door a path came in by, and the path as it may be logged: a route template (routeOf), no
// query string (a search's words) and no token (/mcp/<token> for clients that can't send headers).
export function doorOf(path: string): { door: string; route: string } {
  if (/^\/mcp\/pb_[A-Za-z0-9_-]+\/?$/.test(path)) return { door: "mcp", route: "/mcp/<token>" };
  const door = path.startsWith("/mcp/oauth") ? "mcp-oauth" : path.startsWith("/mcp") ? "mcp" : path === "/v1/enroll" ? "enroll"
    : path.startsWith("/v1") ? "api" : path === "/b" || path.startsWith("/b/") ? "browser" : "other";
  return { door, route: routeOf(path) };
}
