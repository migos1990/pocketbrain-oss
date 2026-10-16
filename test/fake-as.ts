// SPDX-License-Identifier: AGPL-3.0-only
// Test-only stand-ins for the two outside parties of the OAuth door: a hosted authorization
// server (what WorkOS AuthKit does: dynamic registration, client metadata documents, PKCE,
// tokens signed with a key published at /jwks) and an assistant (Helper or Planner) that discovers
// everything from pocketBrain's 401, the way the MCP authorization spec describes.
// Never shipped: pocketBrain itself never issues OAuth tokens.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signJwt(key: KeyObject, kid: string, claims: Record<string, unknown>, alg = "ES256"): string {
  const head = b64u(JSON.stringify({ alg, kid, typ: "at+jwt" }));
  const body = b64u(JSON.stringify(claims));
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${b64u(sig)}`;
}

export interface FakeAS {
  issuer: string;
  key: KeyObject;
  kid: string;
  signedIn: { sub: string };           // who consents at /authorize
  registered: Map<string, { redirect_uris: string[]; client_name?: string }>;
  rotateKey(): void;                   // publish a new signing key and sign with it from now on
  hits: { jwks: number; metadata: number }; // how often the keys and the metadata were fetched
  down: boolean;                       // true: /jwks and the metadata answer 503
  wrongIssuer: boolean;                // true: the metadata names another issuer
  stop(): void;
}

// `auth0: true` shapes it like Auth0 (what Muse meets): issuer with a trailing slash, the client in
// azp, aud as a list, and rotating refresh tokens with a reuse grace: a used refresh token still
// works for `reuseGraceMs`, after that reusing it revokes its whole family.
export function startFakeAS(ownerSub = "user_owner", o: { auth0?: boolean; reuseGraceMs?: number } = {}): FakeAS {
  let { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const published = [{ publicKey, kid: "k1" }];
  const codes = new Map<string, { client_id: string; redirect_uri: string; challenge: string; resource: string; sub: string }>();
  const refresh = new Map<string, { client_id: string; resource: string; sub: string; family: string; used?: number }>();
  const revokedFamilies = new Set<string>();
  const registered = new Map<string, { redirect_uris: string[]; client_name?: string }>();
  const state: FakeAS = {
    issuer: "", key: privateKey, kid: "k1", signedIn: { sub: ownerSub }, registered, stop: () => server.stop(true),
    hits: { jwks: 0, metadata: 0 }, down: false, wrongIssuer: false,
    rotateKey() {
      ({ privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" }));
      state.key = privateKey; state.kid = `k${published.length + 1}`;
      published.push({ publicKey, kid: state.kid });
    },
  };
  const base = () => (o.auth0 ? state.issuer.replace(/\/$/, "") : state.issuer);

  const mint = (client_id: string, resource: string, sub: string, family = b64u(randomBytes(6))) => {
    const now = Math.floor(Date.now() / 1000);
    const claims = o.auth0
      ? { iss: state.issuer, sub, aud: [resource, `${base()}/userinfo`], azp: client_id, scope: "openid offline_access", iat: now, exp: now + 300 }
      : { iss: state.issuer, sub, aud: resource, client_id, iat: now, exp: now + 300, jti: b64u(randomBytes(8)) };
    const access = signJwt(state.key, state.kid, claims);
    const rt = b64u(randomBytes(24));
    refresh.set(rt, { client_id, resource, sub, family });
    return Response.json({ access_token: access, token_type: "Bearer", expires_in: 300, refresh_token: rt });
  };

  // Client metadata document (CIMD): the client_id is an https URL; the AS fetches it.
  async function clientRedirects(client_id: string): Promise<string[] | undefined> {
    if (registered.has(client_id)) return registered.get(client_id)!.redirect_uris;
    if (!/^https?:\/\//.test(client_id)) return undefined;
    const r = await fetch(client_id);
    if (!r.ok) return undefined;
    const doc = await r.json() as { client_id?: string; redirect_uris?: string[] };
    return doc.client_id === client_id ? doc.redirect_uris : undefined;
  }

  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/jwks") state.hits.jwks++;
      if (url.pathname.startsWith("/.well-known/")) state.hits.metadata++;
      if (state.down && (url.pathname === "/jwks" || url.pathname.startsWith("/.well-known/"))) return new Response("unavailable", { status: 503 });
      if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({
        issuer: state.wrongIssuer ? "https://elsewhere.example/" : state.issuer,
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        registration_endpoint: `${base()}/register`,
        jwks_uri: `${base()}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true,
      });
      if (url.pathname === "/jwks") return Response.json({ keys: published.map((k) => ({ ...k.publicKey.export({ format: "jwk" }), kid: k.kid, alg: "ES256", use: "sig" })) });
      if (url.pathname === "/register" && req.method === "POST") {
        const b = await req.json() as { redirect_uris?: string[]; client_name?: string };
        if (!b.redirect_uris?.length) return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
        const client_id = `client_${b64u(randomBytes(9))}`;
        registered.set(client_id, { redirect_uris: b.redirect_uris, client_name: b.client_name });
        return Response.json({ client_id, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: b.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }, { status: 201 });
      }
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const client_id = q.get("client_id") ?? "", redirect_uri = q.get("redirect_uri") ?? "";
        const redirects = await clientRedirects(client_id);
        if (!redirects?.includes(redirect_uri)) return new Response("unknown client or redirect", { status: 400 });
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return new Response("bad request", { status: 400 });
        const code = b64u(randomBytes(16));
        codes.set(code, { client_id, redirect_uri, challenge: q.get("code_challenge")!, resource: q.get("resource") ?? "", sub: state.signedIn.sub });
        const to = new URL(redirect_uri);
        to.searchParams.set("code", code);
        if (q.get("state")) to.searchParams.set("state", q.get("state")!);
        return new Response(null, { status: 302, headers: { location: to.toString() } });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          const verifier = f.get("code_verifier") ?? "";
          if (!c || c.client_id !== f.get("client_id") || c.redirect_uri !== f.get("redirect_uri") || b64u(createHash("sha256").update(verifier).digest()) !== c.challenge)
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          return mint(c.client_id, f.get("resource") ?? c.resource, c.sub);
        }
        if (f.get("grant_type") === "refresh_token") {
          const r = refresh.get(f.get("refresh_token") ?? "");
          if (!r || r.client_id !== f.get("client_id") || revokedFamilies.has(r.family)) return Response.json({ error: "invalid_grant" }, { status: 400 });
          if (o.reuseGraceMs === undefined) refresh.delete(f.get("refresh_token") ?? "");
          else if (r.used !== undefined && Date.now() - r.used > o.reuseGraceMs) { revokedFamilies.add(r.family); return Response.json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, { status: 403 }); }
          else r.used ??= Date.now();
          return mint(r.client_id, r.resource, r.sub, r.family);
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  state.issuer = `http://127.0.0.1:${server.port}${o.auth0 ? "/" : ""}`;
  return state;
}

// A tiny host for a client metadata document (what Planner publishes at its own URL).
export function startClientHost(redirect_uri: string) {
  let id = "";
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req): Response {
      if (new URL(req.url).pathname === "/oauth-client.json")
        return Response.json({ client_id: id, client_name: "Fake Planner", redirect_uris: [redirect_uri], grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none" });
      return new Response("not found", { status: 404 });
    },
  });
  id = `http://127.0.0.1:${server.port}/oauth-client.json`;
  return { clientId: id, stop: () => server.stop(true) };
}

// The assistant's side, from nothing but the server's URL. `call` sends a request to pocketBrain.
export async function connect(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  mcpUrl: string,
  how: { dcr: { client_name: string; redirect_uri: string } } | { cimd: { client_id: string; redirect_uri: string } },
) {
  // 1. An unauthenticated call: the 401 names the protected resource metadata.
  const r401 = await call(new URL(mcpUrl).pathname, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
  const www = r401.headers.get("www-authenticate") ?? "";
  const prmUrl = www.match(/resource_metadata="([^"]+)"/)?.[1];
  if (r401.status !== 401 || !prmUrl) throw new Error(`no OAuth challenge: ${r401.status} ${www}`);
  // 2. The resource metadata names the authorization server.
  const prm = await (await call(new URL(prmUrl).pathname)).json() as { resource: string; authorization_servers: string[] };
  const as = await (await fetch(`${prm.authorization_servers[0].replace(/\/$/, "")}/.well-known/oauth-authorization-server`)).json() as Record<string, any>;
  // 3. Register: dynamic registration (Helper) or a client metadata document URL (Planner).
  let client_id: string, redirect_uri: string;
  if ("dcr" in how) {
    const reg = await fetch(as.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: how.dcr.client_name, redirect_uris: [how.dcr.redirect_uri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }) });
    client_id = (await reg.json() as { client_id: string }).client_id;
    redirect_uri = how.dcr.redirect_uri;
  } else {
    if (!as.client_id_metadata_document_supported) throw new Error("AS doesn't take client metadata documents");
    ({ client_id, redirect_uri } = how.cimd);
  }
  // 4. Authorization code with PKCE S256 and the resource indicator (RFC 8707).
  const verifier = b64u(randomBytes(32));
  const challenge = b64u(createHash("sha256").update(verifier).digest());
  const auth = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id, redirect_uri, code_challenge: challenge, code_challenge_method: "S256", resource: prm.resource, state: "xyz" })) auth.searchParams.set(k, v);
  const back = await fetch(auth, { redirect: "manual" });
  const code = new URL(back.headers.get("location") ?? "about:blank").searchParams.get("code");
  if (!code) throw new Error(`authorize failed: ${back.status}`);
  const tok = await fetch(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri, resource: prm.resource }) });
  const t = await tok.json() as { access_token: string; refresh_token: string };
  // A refresh, from the current refresh token or one the caller kept (two refreshes racing).
  const refresh = async (refresh_token = t.refresh_token) => {
    const r = await fetch(as.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token, client_id, resource: prm.resource }) });
    const got = await r.json() as { access_token?: string; refresh_token?: string };
    if (!r.ok || !got.access_token) throw new Error(`refresh refused: ${r.status}`);
    Object.assign(t, got);
    return got.access_token;
  };
  return { client_id, token: () => t.access_token, refreshToken: () => t.refresh_token, refresh, prm };
}
