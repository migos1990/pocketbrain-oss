// SPDX-License-Identifier: AGPL-3.0-only
// The OAuth door, for hosted assistants that can't paste a token (Muse). pocketBrain is only
// the resource server here: a hosted authorization server (architecture 0.2; Auth0 is
// the pick, see docs/oauth.md) registers clients (dynamic registration or client metadata
// documents), signs the owner in and issues the tokens. This file
//   - publishes the protected resource metadata (RFC 9728) for /mcp/oauth only,
//   - checks each access token (signature from the AS's JWKS, issuer, audience, expiry, owner),
//   - maps the token's OAuth client to a pocketBrain agent through rules/oauth.yaml, which only
//     the owner edits. A client nobody bound yet authenticates but gets nothing: it waits in
//     .oauth/pending.json until the owner binds it (`pocketbrain oauth bind`).
// Pasted tokens (src/auth.ts) stay the path for everyone else; /mcp keeps its plain 401 so
// Town never starts an OAuth flow there.
import { constants, createPublicKey, verify as verifySig, type KeyObject, type webcrypto } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { loadRules } from "./rules";
import { git } from "./git";
import { OWNER } from "./owner";
import { coworkerStanding } from "./offboard";

export const OAUTH_MCP_PATH = "/mcp/oauth";
export const PRM_PATH = `/.well-known/oauth-protected-resource${OAUTH_MCP_PATH}`;

export interface OAuthClient { agent: string; bound: string; name?: string }
export interface OAuthConfig {
  issuer: string;                 // the hosted AS, exactly as it appears in the token's iss
  resource: string;               // this server's public URL for /mcp/oauth; tokens must carry it in aud
  owner_subject: string;          // the owner's user id at the AS; a token for anyone else is refused
  jwks_uri?: string;              // default: read from the issuer's metadata
  client_claim?: string;          // default: client_id, then azp
  scopes_supported?: string[];
  clients?: Record<string, OAuthClient>;
  revoked?: string[];             // client ids cut off for good; never listed as pending again
  management_client_id?: string;  // an AS app allowed to delete clients (Auth0: machine-to-machine, delete:clients);
                                  // its secret is the key AUTH0_MGMT_CLIENT_SECRET, never in this file
  coworkers?: Record<string, Coworker>; // other people's accounts at the AS, keyed by their subject
  machines?: Record<string, { agent: string; bound: string }>; // client-credentials apps (no person), by client id
  coworker_check_s?: number;      // how often the hub asks the AS whether coworkers are still active (src/offboard.ts)
  coworker_max_age_s?: number;    // past this without an answer, coworkers are refused
  expect?: Expect;                // an open approval window (pocketbrain add --door oauth / oauth expect)
  // Agents the owner revoked, with the day, until a connection is let in as them again. A request
  // that looks like one of them is flagged on the card and in oauth status (src/access-request.ts).
  revoked_agents?: Record<string, string>;
  // Old connections a reconnect replaced (backlog 289): refused here at once, listed until they
  // are deleted at the sign-in service, so Reconnects don't fill its app cap.
  replaced?: Record<string, { agent: string; on: string }>;
}

// The owner's next sign-in, approved as this agent without a client-id hunt: one client, a
// sign-in by the owner's own account only, first seen after the window opened, before `until`.
// Opening and using it are both owner commits to rules/oauth.yaml, so the record is git.
export interface Expect { agent: string; name?: string; opened: string; until: string }

// A coworker the owner lets in: their own account at the AS, mapped to one agent in policy.yaml,
// so whatever assistant they connect sees only that agent's slice. Their connections are bound
// per coworker: a client id the owner bound for themselves never works with a coworker's token
// (shared client ids, like client metadata documents, would otherwise carry the owner's grant).
export interface Coworker { name: string; agent: string; added: string; clients?: Record<string, { bound: string }> }
export interface CoworkerPending { subject: string; client_id: string; first_seen: string; last_seen: string; calls: number; user_agent?: string }

// What a waiting sign-in says about itself through request_access (src/access-request.ts). A
// suggestion for the owner's review, never a grant: cleaned and capped. `name` is the label to
// suggest (the agent id when its own name reads as the owner or another agent), `said` the name
// it gave; `slices` the names it asked for, existing or not.
export interface AccessRequest { agent: string; name: string; said?: string; purpose: string; slices: string[]; at: string }
export interface Pending { client_id: string; first_seen: string; last_seen: string; calls: number; user_agent?: string; request?: AccessRequest }

const file = (root: string) => join(root, "rules", "oauth.yaml");
const pendingFile = (root: string) => join(root, ".oauth", "pending.json");

export function loadOAuth(root: string): OAuthConfig | undefined {
  if (!existsSync(file(root))) return undefined;
  const c = YAML.parse(readFileSync(file(root), "utf8")) as OAuthConfig | null;
  if (!c?.issuer || !c.resource || !c.owner_subject) return undefined;
  return c;
}

function save(root: string, c: OAuthConfig, msg: string) {
  mkdirSync(join(root, "rules"), { recursive: true });
  writeFileSync(file(root), "# The OAuth door (docs/oauth.md). Only the owner edits this file (pocketbrain oauth).\n" + YAML.stringify(c, { aliasDuplicateObjects: false }));
  git(root, ["add", "rules/oauth.yaml"]);
  git(root, ["commit", "-q", "-m", `owner: ${msg}`, "--", "rules/oauth.yaml"], OWNER);
}

export function setupOAuth(root: string, o: { issuer: string; resource: string; owner_subject: string; jwks_uri?: string }) {
  for (const u of [o.issuer, o.resource, o.jwks_uri].filter(Boolean) as string[]) {
    const p = new URL(u);
    if (p.protocol !== "https:" && !/^(127\.0\.0\.1|localhost)$/.test(p.hostname)) throw new Error(`${u}: https only`);
  }
  if (!new URL(o.resource).pathname.endsWith(OAUTH_MCP_PATH)) throw new Error(`resource must end with ${OAUTH_MCP_PATH}`);
  const prev = loadOAuth(root);
  save(root, { ...o, clients: prev?.clients ?? {}, revoked: prev?.revoked ?? [], ...(prev?.revoked_agents ? { revoked_agents: prev.revoked_agents } : {}), ...(prev?.replaced ? { replaced: prev.replaced } : {}) }, "oauth door set up");
}

// ---------- pending clients (not in git: the server writes it, the owner reads it) ----------

// A waiting connection is a request to the owner. It lapses a day after its last call (the
// assistant has to call again to be listed), and at most PENDING_PER_HOUR new ones are noted an
// hour, so a flood of registrations can't bury the owner's own.
export const PENDING_TTL_MS = 24 * 3600_000;
export const PENDING_PER_HOUR = 10;

function readPending(root: string): Pending[] {
  try { return JSON.parse(readFileSync(pendingFile(root), "utf8")) as Pending[]; } catch { return []; }
}

export function listPending(root: string, now = Date.now()): Pending[] {
  return readPending(root).filter((p) => now - Date.parse(p.last_seen) < PENDING_TTL_MS);
}

function writePending(root: string, list: Pending[]) {
  mkdirSync(join(root, ".oauth"), { recursive: true });
  writeFileSync(join(root, ".oauth", ".gitignore"), "*\n");
  writeFileSync(pendingFile(root), JSON.stringify(list.slice(-50), null, 2));
}

function notePending(root: string, clientId: string, userAgent?: string) {
  const now = new Date().toISOString();
  const list = listPending(root);
  const p = list.find((x) => x.client_id === clientId);
  if (!p && list.filter((x) => Date.now() - Date.parse(x.first_seen) < 3600_000).length >= PENDING_PER_HOUR) return;
  if (p) { p.last_seen = now; p.calls++; } else list.push({ client_id: clientId, first_seen: now, last_seen: now, calls: 1, user_agent: userAgent?.slice(0, 200) });
  writePending(root, list);
}

// Attaches a waiting sign-in's access request, replacing any earlier one (one open request per
// client). False when that sign-in isn't listed (lapsed, or over the hourly cap).
export function setPendingRequest(root: string, clientId: string, request: AccessRequest): boolean {
  const list = listPending(root);
  const p = list.find((x) => x.client_id === clientId);
  if (!p) return false;
  p.request = request;
  writePending(root, list);
  return true;
}

function dropPending(root: string, clientId: string) {
  const list = listPending(root);
  if (list.some((p) => p.client_id === clientId)) writeFileSync(pendingFile(root), JSON.stringify(list.filter((p) => p.client_id !== clientId), null, 2));
}

const coworkerPendingFile = (root: string) => join(root, ".oauth", "coworker-pending.json");

export function listCoworkerPending(root: string): CoworkerPending[] {
  try { return JSON.parse(readFileSync(coworkerPendingFile(root), "utf8")) as CoworkerPending[]; } catch { return []; }
}

function noteCoworkerPending(root: string, subject: string, clientId: string, userAgent?: string) {
  const now = new Date().toISOString();
  const list = listCoworkerPending(root);
  const p = list.find((x) => x.client_id === clientId && x.subject === subject);
  if (p) { p.last_seen = now; p.calls++; } else list.push({ subject, client_id: clientId, first_seen: now, last_seen: now, calls: 1, user_agent: userAgent?.slice(0, 200) });
  mkdirSync(join(root, ".oauth"), { recursive: true });
  writeFileSync(join(root, ".oauth", ".gitignore"), "*\n");
  writeFileSync(coworkerPendingFile(root), JSON.stringify(list.slice(-50), null, 2));
}

// ---------- the owner's levers ----------

export function addCoworker(root: string, subject: string, name: string, agent: string) {
  const c = loadOAuth(root);
  if (!c) throw new Error("no rules/oauth.yaml: run pocketbrain oauth setup first");
  if (subject === c.owner_subject) throw new Error("that's your own account");
  const a = loadRules(root).policy.agents[agent];
  if (!a || a.inside_wall || a.role === "gardener") throw new Error(`${agent} isn't an outside assistant in policy.yaml`);
  if (Object.values(c.clients ?? {}).some((b) => b.agent === agent)) throw new Error(`${agent} is already used by one of your own connections; give ${name} an agent of their own`);
  (c.coworkers ??= {})[subject] = { name, agent, added: new Date().toISOString().slice(0, 10), clients: c.coworkers?.[subject]?.clients ?? {} };
  save(root, c, `coworker ${name} let in as ${agent}`);
}

export function bindCoworkerClient(root: string, subject: string, clientId: string) {
  const c = loadOAuth(root);
  const cw = c?.coworkers?.[subject];
  if (!c || !cw) throw new Error(`no coworker ${subject}`);
  if (c.revoked?.includes(clientId)) throw new Error(`${clientId} was revoked`);
  (cw.clients ??= {})[clientId] = { bound: new Date().toISOString().slice(0, 10) };
  save(root, c, `coworker ${cw.name}'s connection approved`);
  const rest = listCoworkerPending(root).filter((p) => !(p.subject === subject && p.client_id === clientId));
  if (existsSync(coworkerPendingFile(root))) writeFileSync(coworkerPendingFile(root), JSON.stringify(rest, null, 2));
}

// A background agent with its own identity at the AS (Auth0: a Machine to Machine application
// authorized for this API), instead of a pasted token. Only an agent with role: gardener: an
// assistant that talks to a person signs in as that person.
export function bindMachine(root: string, clientId: string, agent: string) {
  const c = loadOAuth(root);
  if (!c) throw new Error("no rules/oauth.yaml: run pocketbrain oauth setup first");
  const a = loadRules(root).policy.agents[agent];
  if (!a || a.role !== "gardener") throw new Error(`${agent} isn't a gardener in policy.yaml; only background agents connect as a machine`);
  if (c.revoked?.includes(clientId)) throw new Error(`${clientId} was revoked`);
  (c.machines ??= {})[clientId] = { agent, bound: new Date().toISOString().slice(0, 10) };
  save(root, c, `machine client bound to ${agent}`);
}

// Cuts a coworker off: every connection they made stops on its next request.
export function removeCoworker(root: string, subject: string): boolean {
  const c = loadOAuth(root);
  const cw = c?.coworkers?.[subject];
  if (!c || !cw) return false;
  delete c.coworkers![subject];
  save(root, c, `coworker ${cw.name} removed`);
  return true;
}


export function expectClient(root: string, agent: string, o: { name?: string; minutes?: number; now?: Date } = {}): Expect {
  const c = loadOAuth(root);
  if (!c) throw new Error("no rules/oauth.yaml: run pocketbrain oauth setup first");
  const a = loadRules(root).policy.agents[agent];
  if (!a || a.inside_wall || a.role === "gardener") throw new Error(`${agent} isn't an outside assistant in policy.yaml`);
  if (Object.values(c.coworkers ?? {}).some((x) => x.agent === agent)) throw new Error(`${agent} is a coworker's agent; approve their connections with oauth coworker bind`);
  const minutes = Math.min(Math.max(o.minutes ?? 10, 1), 30);
  const now = o.now ?? new Date();
  c.expect = { agent, ...(o.name ? { name: o.name } : {}), opened: now.toISOString(), until: new Date(now.getTime() + minutes * 60_000).toISOString() };
  save(root, c, `approval window for ${agent} open until ${c.expect.until}`);
  return c.expect;
}

// Called for an unbound client of the owner's own account. Re-reads the file and binds in one
// synchronous step, so two sign-ins racing for the window can't both get it.
function useExpect(root: string, clientId: string): string | undefined {
  const c = loadOAuth(root);
  if (!c || c.revoked?.includes(clientId)) return undefined;
  // Muse sends its first calls in parallel: the one that used the window bound the client (and
  // closed the window), so the others take that binding instead of being sent to wait.
  if (c.clients?.[clientId]) return c.clients[clientId].agent;
  const e = c.expect;
  if (!e) return undefined;
  const now = new Date().toISOString();
  if (now > e.until) return undefined;
  const seen = listPending(root).find((p) => p.client_id === clientId);
  if (seen && seen.first_seen < e.opened) return undefined;
  const a = loadRules(root).policy.agents[e.agent];
  if (!a || a.inside_wall || a.role === "gardener" || notOwnClient(c, clientId)) return undefined;
  const old = replaceOld(c, e.agent, clientId);
  (c.clients ??= {})[clientId] = { agent: e.agent, bound: now.slice(0, 10), ...(e.name ?? old.name ? { name: e.name ?? old.name } : {}) };
  if (c.revoked_agents?.[e.agent]) delete c.revoked_agents[e.agent];
  delete c.expect;
  save(root, c, `oauth client ${clientId} approved as ${e.agent} (window opened ${e.opened})${old.ids.length ? `, replacing ${old.ids.length} old connection(s)` : ""}`);
  dropPending(root, clientId);
  return e.agent;
}

// A reconnect (backlog 289): the agent's other connections are replaced by the new one. They are
// refused at once, like a revoke, and listed in `replaced` until deleted at the sign-in service.
// The agent itself isn't revoked, so it isn't flagged as coming back. Returns the old ids and
// the last label, which the new connection keeps when none is given.
function replaceOld(c: OAuthConfig, agent: string, keep: string): { ids: string[]; name?: string } {
  const old = Object.entries(c.clients ?? {}).filter(([id, v]) => v.agent === agent && id !== keep);
  const on = new Date().toISOString().slice(0, 10);
  for (const [id] of old) { delete c.clients![id]; (c.replaced ??= {})[id] = { agent, on }; }
  if (old.length) c.revoked = [...new Set([...(c.revoked ?? []), ...old.map(([id]) => id)])];
  return { ids: old.map(([id]) => id), name: old.map(([, v]) => v.name).filter(Boolean).at(-1) };
}

// An app the hub knows as something other than an agent's own sign-in: the management app, a
// machine app (the Gardener's) or a coworker's. It is never bound to an agent, so a reconnect
// never retires it and cleanup never deletes it at the sign-in service.
function notOwnClient(c: OAuthConfig, id: string): string | undefined {
  if (id === c.management_client_id) return "the management app";
  if (c.machines?.[id]) return `a machine app (${c.machines[id].agent})`;
  const cw = Object.values(c.coworkers ?? {}).find((x) => x.clients?.[id]);
  if (cw) return `${cw.name}'s connection`;
  return undefined;
}

// keepOld: an assistant that really has two connections as one agent keeps both. Binding a
// replaced client that cleanup hasn't deleted yet undoes the replace.
export function bindClient(root: string, clientId: string, agent: string, name?: string, o: { keepOld?: boolean } = {}): string[] {
  const c = loadOAuth(root);
  if (!c) throw new Error("no rules/oauth.yaml: run pocketbrain oauth setup first");
  const a = loadRules(root).policy.agents[agent];
  if (!a || a.inside_wall) throw new Error(`${agent} isn't an outside agent in policy.yaml`);
  const other = notOwnClient(c, clientId);
  if (other) throw new Error(`${clientId} is ${other}, not an assistant's sign-in`);
  if (c.replaced?.[clientId]) {
    c.revoked = (c.revoked ?? []).filter((x) => x !== clientId);
    delete c.replaced[clientId];
    if (!Object.keys(c.replaced).length) delete c.replaced;
  }
  if (c.revoked?.includes(clientId)) throw new Error(`${clientId} was revoked; reconnect the assistant to get a new client`);
  const cw = Object.values(c.coworkers ?? {}).find((x) => x.agent === agent);
  if (cw) throw new Error(`${agent} is ${cw.name}'s agent; bind your own connections to an agent of yours`);
  const old = o.keepOld ? { ids: [] as string[] } : replaceOld(c, agent, clientId);
  (c.clients ??= {})[clientId] = { agent, bound: new Date().toISOString().slice(0, 10), ...(name ?? old.name ? { name: name ?? old.name } : {}) };
  if (c.revoked_agents?.[agent]) delete c.revoked_agents[agent];
  save(root, c, `oauth client bound to ${agent}${old.ids.length ? `, replacing ${old.ids.length} old connection(s)` : ""}`);
  dropPending(root, clientId);
  return old.ids;
}

// Cuts a client off for good. Its tokens stop working on the next request.
export function revokeClient(root: string, clientId: string) {
  const c = loadOAuth(root);
  if (!c) return false;
  const known = !!c.clients?.[clientId] || !!c.machines?.[clientId] || listPending(root).some((p) => p.client_id === clientId);
  // Cutting an agent's last connection counts as revoking it, for the coming-back flag.
  const agent = c.clients?.[clientId]?.agent ?? c.machines?.[clientId]?.agent;
  delete c.clients?.[clientId];
  delete c.machines?.[clientId];
  c.revoked = [...new Set([...(c.revoked ?? []), clientId])];
  if (agent && !Object.values(c.clients ?? {}).some((x) => x.agent === agent)) (c.revoked_agents ??= {})[agent] = new Date().toISOString().slice(0, 10);
  save(root, c, "oauth client revoked");
  dropPending(root, clientId);
  return known;
}

// Every OAuth client bound to an agent, revoked. Called by revokeTokens, so the dashboard's
// Revoke button cuts both pasted tokens and OAuth connections.
export function revokeAgentClients(root: string, agent: string): number {
  const c = loadOAuth(root);
  const ids = Object.entries(c?.clients ?? {}).filter(([, v]) => v.agent === agent).map(([k]) => k);
  const subs = Object.entries(c?.coworkers ?? {}).filter(([, v]) => v.agent === agent).map(([k]) => k);
  ids.push(...Object.entries(c?.machines ?? {}).filter(([, v]) => v.agent === agent).map(([k]) => k));
  if (!c) return 0;
  const closed = c.expect?.agent === agent;
  if (closed) delete c.expect;
  // Kept so a request that looks like this agent coming back is flagged (backlog 209); a name
  // that isn't an agent (a typo) is not recorded.
  const real = !!loadRules(root).policy.agents[agent];
  if (real) (c.revoked_agents ??= {})[agent] = new Date().toISOString().slice(0, 10);
  if (!ids.length && !subs.length) { if (real || closed) save(root, c, closed ? `approval window for ${agent} closed` : `${agent} revoked`); return 0; }
  for (const id of ids) { delete c.clients?.[id]; delete c.machines?.[id]; }
  if (ids.length) c.revoked = [...new Set([...(c.revoked ?? []), ...ids])];
  let n = ids.length;
  for (const s of subs) { n += Object.keys(c.coworkers![s].clients ?? {}).length; delete c.coworkers![s]; }
  save(root, c, `oauth clients of ${agent} revoked`);
  return n;
}

// Clients bound to an agent, for the AS-side cut that follows revokeAgentClients.
export function clientsOf(root: string, agent: string): string[] {
  return Object.entries(loadOAuth(root)?.clients ?? {}).filter(([, v]) => v.agent === agent).map(([k]) => k);
}

export function setManagement(root: string, clientId: string | undefined) {
  const c = loadOAuth(root);
  if (!c) throw new Error("no rules/oauth.yaml: run pocketbrain oauth setup first");
  if (clientId) c.management_client_id = clientId; else delete c.management_client_id;
  save(root, c, clientId ? "oauth management client set" : "oauth management client cleared");
}

export const asBase = (c: OAuthConfig) => (c.issuer.endsWith("/") ? c.issuer : c.issuer + "/");

// A Management API token for the owner's management client (client credentials).
export async function managementToken(c: OAuthConfig, secret: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const base = asBase(c);
  const r = await fetchFn(new URL("oauth/token", base), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: c.management_client_id, client_secret: secret, audience: new URL("api/v2/", base).toString() }),
  });
  if (!r.ok) throw new Error(`token: HTTP ${r.status}`);
  const token = ((await r.json()) as { access_token?: string }).access_token;
  if (!token) throw new Error("token: none in the answer");
  return token;
}

export interface AsCut { deleted: string[]; failed: { client_id: string; why: string }[]; skipped?: string }

// The second half of a revoke: delete the clients at the authorization server too (Auth0's
// Management API), so the assistant itself shows the connection as gone instead of retrying with
// a refresh token. Best effort and never needed for safety: revokeClient/revokeAgentClients
// already refuse every request from these clients. Each outcome goes to .oauth/as-cuts.json.
export async function cutAtAuthServer(root: string, ids: string[], fetchFn: typeof fetch = fetch): Promise<AsCut> {
  const out: AsCut = { deleted: [], failed: [] };
  const c = loadOAuth(root);
  const secret = process.env.AUTH0_MGMT_CLIENT_SECRET;
  if (!ids.length) out.skipped = "no clients";
  else if (!c?.management_client_id || !secret) out.skipped = "no management client (pocketbrain oauth management <client-id> and the key AUTH0_MGMT_CLIENT_SECRET)";
  else {
    const base = asBase(c);
    let token: string | undefined;
    try {
      token = await managementToken(c, secret, fetchFn);
    } catch (e) {
      for (const id of ids) out.failed.push({ client_id: id, why: (e as Error).message });
    }
    if (token) for (const id of ids) {
      try {
        const r = await fetchFn(new URL(`api/v2/clients/${encodeURIComponent(id)}`, base), { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
        if (r.ok || r.status === 404) out.deleted.push(id); else out.failed.push({ client_id: id, why: `HTTP ${r.status}` });
      } catch (e) { out.failed.push({ client_id: id, why: (e as Error).message }); }
    }
  }
  if (ids.length) {
    const f = join(root, ".oauth", "as-cuts.json");
    mkdirSync(join(root, ".oauth"), { recursive: true });
    writeFileSync(join(root, ".oauth", ".gitignore"), "*\n");
    let log: unknown[] = [];
    try { log = JSON.parse(readFileSync(f, "utf8")); } catch {}
    log.push({ at: new Date().toISOString(), ...out });
    writeFileSync(f, JSON.stringify(log.slice(-50), null, 2));
  }
  return out;
}

// The owner's one click for replaced connections (backlog 289): delete them at the sign-in
// service, and forget the ones it deleted (or no longer has). They stay refused here either way.
export async function cleanupReplaced(root: string, fetchFn: typeof fetch = fetch): Promise<AsCut> {
  const c0 = loadOAuth(root);
  const ids = Object.keys(c0?.replaced ?? {}).filter((id) => !notOwnClient(c0!, id) && !c0!.clients?.[id]);
  const cut = await cutAtAuthServer(root, ids, fetchFn);
  if (cut.deleted.length) {
    const c = loadOAuth(root)!;
    for (const id of cut.deleted) delete c.replaced?.[id];
    if (c.replaced && !Object.keys(c.replaced).length) delete c.replaced;
    save(root, c, `${cut.deleted.length} replaced oauth client(s) deleted at the sign-in service`);
  }
  return cut;
}

// ---------- protected resource metadata and the 401 challenge ----------

export function resourceMetadata(c: OAuthConfig) {
  return {
    resource: c.resource,
    authorization_servers: [c.issuer],
    bearer_methods_supported: ["header"],
    resource_name: "pocketBrain",
    ...(c.scopes_supported?.length ? { scopes_supported: c.scopes_supported } : {}),
  };
}

export function challenge(c: OAuthConfig, error?: string): string {
  const prm = new URL(PRM_PATH, c.resource).toString();
  return `Bearer resource_metadata="${prm}"${error ? `, error="${error}"` : ""}`;
}

// ---------- JWT check against the AS's keys ----------

type Jwk = webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string };
const ALGS: Record<string, { hash: string | null; ec?: boolean; pss?: boolean }> = {
  RS256: { hash: "sha256" }, RS384: { hash: "sha384" }, RS512: { hash: "sha512" },
  PS256: { hash: "sha256", pss: true },
  ES256: { hash: "sha256", ec: true }, ES384: { hash: "sha384", ec: true },
  EdDSA: { hash: null },
};

// `missAt`: when an unknown key id last made us fetch again. Only those fetches are rate limited,
// so a key the AS just rotated in is fetched at once even if the keys were fetched seconds ago.
// Calls arriving together share one fetch (`inflight`), and after a failed fetch nothing asks the
// AS again for JWKS_MIN_REFRESH (`failed`): the keys in hand keep working past their time to
// live, so an outage at the AS doesn't cut assistants off, and junk tokens can't make every
// request a fetch.
const jwksCache = new Map<string, { keys: Jwk[]; at: number; missAt?: number }>();
const inflight = new Map<string, Promise<Jwk[]>>();
const failed = new Map<string, { at: number; error: string }>();
const discovered = new Map<string, { uri: string; at: number }>();
// Keys older than JWKS_MAX_STALE are dropped even while the AS is down, so a key the AS pulled
// during an outage can't be trusted for ever.
const JWKS_TTL = 10 * 60_000, JWKS_MIN_REFRESH = 30_000, JWKS_MAX_STALE = 24 * 3600_000;
const usable = (h: { at: number } | undefined) => !!h && Date.now() - h.at < JWKS_MAX_STALE;

async function jwksUri(c: OAuthConfig): Promise<string> {
  if (c.jwks_uri) return c.jwks_uri;
  const d = discovered.get(c.issuer);
  if (d && Date.now() - d.at < JWKS_TTL) return d.uri;
  const f = failed.get(`meta:${c.issuer}`);
  if (f && Date.now() - f.at < JWKS_MIN_REFRESH) { if (usable(d)) return d!.uri; throw new Error(f.error); }
  let mismatch = false;
  const base = c.issuer.replace(/\/+$/, "");
  for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    try {
      const r = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const j = await r.json() as { jwks_uri?: string; issuer?: string };
        if (j.jwks_uri && j.issuer === c.issuer) { discovered.set(c.issuer, { uri: j.jwks_uri, at: Date.now() }); return j.jwks_uri; }
        mismatch = true;
      }
    } catch { /* try the next */ }
  }
  // Metadata that answers for another issuer is an answer, not an outage: forget what we had.
  if (mismatch) discovered.delete(c.issuer);
  else if (usable(d)) return d!.uri;
  failed.set(`meta:${c.issuer}`, { at: Date.now(), error: "no jwks_uri: set it in rules/oauth.yaml" });
  throw new Error("no jwks_uri: set it in rules/oauth.yaml");
}

async function fetchKeys(uri: string, miss: boolean): Promise<Jwk[]> {
  const hit = jwksCache.get(uri);
  try {
    const r = await fetch(uri, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`jwks ${r.status}`);
    const keys = ((await r.json()) as { keys?: Jwk[] }).keys ?? [];
    const now = Date.now();
    jwksCache.set(uri, { keys, at: now, ...(miss ? { missAt: now } : hit?.missAt !== undefined ? { missAt: hit.missAt } : {}) });
    failed.delete(uri);
    return keys;
  } catch (e) {
    failed.set(uri, { at: Date.now(), error: (e as Error).message });
    if (usable(hit)) return hit!.keys;
    throw e;
  }
}

async function keysFor(c: OAuthConfig, kid: string | undefined): Promise<Jwk[]> {
  const uri = await jwksUri(c);
  const hit = jwksCache.get(uri);
  const now = Date.now();
  const fresh = hit && now - hit.at < JWKS_TTL;
  const known = hit?.keys.some((k) => !kid || k.kid === kid);
  if (hit && fresh && known) return hit.keys;
  const miss = !!hit && known === false;
  if (miss && hit.missAt !== undefined && now - hit.missAt < JWKS_MIN_REFRESH) return hit.keys; // unknown kid: don't hammer the AS
  const f = failed.get(uri);
  if (f && now - f.at < JWKS_MIN_REFRESH) { if (usable(hit)) return hit!.keys; throw new Error(f.error); }
  if (miss) hit.missAt = now;
  let p = inflight.get(uri);
  if (!p) { p = fetchKeys(uri, miss).finally(() => inflight.delete(uri)); inflight.set(uri, p); }
  return p;
}

export function clearJwksCache() { jwksCache.clear(); inflight.clear(); failed.clear(); discovered.clear(); }

const b64 = (s: string) => Buffer.from(s, "base64url");

export type TokenCheck =
  | { ok: true; client: string; claims: Record<string, unknown> }
  | { ok: false; status: 401 | 403; error: string; reason: string };

export async function checkAccessToken(c: OAuthConfig, token: string): Promise<TokenCheck> {
  const bad = (reason: string): TokenCheck => ({ ok: false, status: 401, error: "invalid_token", reason });
  const parts = token.split(".");
  if (parts.length !== 3) return bad("not a JWT");
  let header: { alg?: string; kid?: string; typ?: string }, claims: Record<string, unknown>;
  try { header = JSON.parse(b64(parts[0]).toString()); claims = JSON.parse(b64(parts[1]).toString()); } catch { return bad("unreadable token"); }
  const alg = header.alg ? ALGS[header.alg] : undefined;
  if (!alg) return bad(`alg ${header.alg} not accepted`);
  let keys: Jwk[];
  try { keys = await keysFor(c, header.kid); } catch (e) { return { ok: false, status: 401, error: "invalid_token", reason: `can't fetch the AS keys: ${(e as Error).message}` }; }
  const candidates = keys.filter((k) => (!header.kid || k.kid === header.kid) && (!k.alg || k.alg === header.alg) && k.use !== "enc");
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), sig = b64(parts[2]);
  const verified = candidates.some((k) => {
    try {
      const key: KeyObject = createPublicKey({ key: k, format: "jwk" });
      if (header.alg === "EdDSA") return key.asymmetricKeyType === "ed25519" && verifySig(null, data, key, sig);
      if (alg.ec) return key.asymmetricKeyType === "ec" && verifySig(alg.hash, data, { key, dsaEncoding: "ieee-p1363" }, sig);
      if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") return false;
      return verifySig(alg.hash, data, alg.pss ? { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST } : key, sig);
    } catch { return false; }
  });
  if (!verified) return bad("bad signature");
  const now = Math.floor(Date.now() / 1000), leeway = 60;
  if (claims.iss !== c.issuer) return bad("wrong issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(c.resource)) return bad("token not issued for this server (aud)");
  if (typeof claims.exp !== "number" || claims.exp + leeway < now) return bad("expired");
  if (typeof claims.nbf === "number" && claims.nbf - leeway > now) return bad("not yet valid");
  const client = [c.client_claim, "client_id", "azp"].filter(Boolean).map((k) => claims[k as string]).find((v) => typeof v === "string") as string | undefined;
  // A machine token (client credentials) names the app itself as its subject; Auth0 writes "<client id>@clients".
  const machine = !!client && !!c.machines?.[client] && (claims.sub === client || claims.sub === `${client}@clients`);
  if (claims.sub !== c.owner_subject && !machine && !(typeof claims.sub === "string" && c.coworkers?.[claims.sub])) return { ok: false, status: 403, error: "insufficient_scope", reason: "this brain only answers its owner's account and the coworkers the owner let in" };
  if (!client) return bad("no client id in the token");
  return { ok: true, client, claims };
}

// The agent behind an OAuth access token, or why not. Unbound clients are noted for the owner.
export async function agentForOAuth(root: string, token: string, userAgent?: string):
  Promise<{ agent: string } | { status: 401 | 403 | 404; error: string; reason: string; header?: string; waiting?: string }> {
  const c = loadOAuth(root);
  if (!c) return { status: 404, error: "not_found", reason: "not found" };
  const r = await checkAccessToken(c, token);
  if (!r.ok) return { status: r.status, error: r.error, reason: r.reason, header: challenge(c, r.error) };
  if (c.revoked?.includes(r.client)) return { status: 401, error: "invalid_token", reason: "this connection was revoked by the owner; reconnect to ask again", header: challenge(c, "invalid_token") };
  const policy = loadRules(root).policy.agents;
  const sub = r.claims.sub as string;
  const m = c.machines?.[r.client];
  if (m && (sub === r.client || sub === `${r.client}@clients`)) {
    const a = policy[m.agent];
    if (!a || a.inside_wall || a.role !== "gardener") return { status: 403, error: "access_denied", reason: "this machine's agent is no longer a gardener in the owner's rules" };
    return { agent: m.agent };
  }
  if (sub !== c.owner_subject) {
    const cw = c.coworkers![sub];
    if (!cw.clients?.[r.client]) {
      noteCoworkerPending(root, sub, r.client, userAgent);
      return { status: 403, error: "access_denied", reason: `this connection of ${cw.name}'s waits for the owner's approval: pocketbrain oauth coworker bind ${sub} ${r.client}` };
    }
    if (!policy[cw.agent] || policy[cw.agent].inside_wall) return { status: 403, error: "access_denied", reason: "this coworker's agent is no longer in the owner's rules" };
    const standing = coworkerStanding(sub);
    if (standing !== "active") return { status: 403, error: "access_denied", reason: standing === "unknown" ? `can't confirm ${cw.name}'s account at the sign-in service right now` : `${cw.name}'s account is ${standing === "gone" ? "deleted" : "blocked"} at the sign-in service` };
    return { agent: cw.agent };
  }
  const bound = c.clients?.[r.client]?.agent ?? useExpect(root, r.client);
  if (!bound) {
    notePending(root, r.client, userAgent);
    // The owner's own sign-in, not yet approved: the server may give it the waiting session
    // (request_access only, nothing from the brain).
    return { status: 403, error: "access_denied", reason: `this connection (client ${r.client}) waits for the owner's approval: pocketbrain oauth bind ${r.client} --agent <agent>`, waiting: r.client };
  }
  if (!policy[bound] || policy[bound].inside_wall) return { status: 403, error: "access_denied", reason: "this connection's agent is no longer in the owner's rules" };
  return { agent: bound };
}
