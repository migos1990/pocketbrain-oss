# The OAuth door: for assistants that can't paste a token

Most assistants connect with a pasted token (`pocketbrain token --agent <agent>`, with `--code` from the dashboard for an agent wider than trial, sent as `Authorization: Bearer …` to `/mcp` or `/v1`). Some hosted assistants only offer "add an MCP server by URL" and then sign in with OAuth. Muse is one: its connector form takes only an endpoint and a docs URL, and it registers itself with OAuth dynamic client registration (RFC 7591). The OAuth door is for those assistants.

pocketBrain never issues OAuth tokens itself. A hosted authorization server does that (architecture section 0: no self-built authorization server, ever). pocketBrain only checks the tokens it is shown.

## How it fits

| Path | Who | Auth |
|---|---|---|
| `POST /mcp` | Town, Claude, anything that can paste a token | pasted token. A missing token gets a plain 401 with no `WWW-Authenticate` header, because Town starts an OAuth flow when it sees one. |
| `/v1/…` | Instinct and other plain API callers | pasted token, unchanged |
| `POST /mcp/oauth` | Muse and other OAuth-only assistants | OAuth access token from the hosted authorization server |
| `GET /.well-known/oauth-protected-resource/mcp/oauth` | the assistant, before signing in | none: protected resource metadata (RFC 9728) naming the authorization server |

What the assistant does, all on its own once it has the URL:

1. Calls `/mcp/oauth` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp/oauth"`.
2. Reads that document, which names the authorization server.
3. Reads the authorization server's metadata and registers: dynamic client registration (Muse), or a client ID metadata document URL (Town, if it ever uses this door).
4. Sends you to the authorization server to sign in, with PKCE (S256) and `resource=https://brain.<your domain>/mcp/oauth`.
5. Calls `/mcp/oauth` with the access token it gets back, and refreshes it at the authorization server when it expires.

What pocketBrain checks on every call:

- the signature, against the authorization server's published keys (JWKS, cached 10 minutes, refetched at once for an unknown key id, then at most every 30 seconds). Calls arriving together share one fetch. When a fetch fails (an error answer, a timeout or no connection), the keys in hand keep working and nothing asks the server again for 30 seconds, so an outage at the authorization server doesn't cut assistants off; keys older than a day are dropped even then. The cost: a key the server removed during the outage, or in the 30 seconds after a failed fetch, is still trusted until the next good fetch. The issuer's metadata, when it is how the keys are found, is looked up once per 10 minutes, not per request; the address it gave is kept at most a day, and dropped at once if the metadata names another issuer;
- `iss` is the authorization server in `rules/oauth.yaml`, `aud` contains this server's `resource`, and the token hasn't expired;
- `sub` is your own account at the authorization server. A token for anyone else is refused, even if they managed to sign in there;
- the token's client (`client_id`, else `azp`) is **bound to an agent** in `rules/oauth.yaml`. A client nobody bound yet authenticates but gets nothing from the brain and is listed as waiting. If it signed in as **your** account, it gets a waiting session: `initialize` says it waits for you, and its only tool is `request_access` (name, purpose, slices it would like), which shows on the dashboard ([add-an-agent.md](add-an-agent.md)). It gets the same answer whatever it asks, so it learns nothing about your slices or agents, and its body is capped at 16 KB as it streams. Any other call is refused. (The hub refuses any request body over 1 MB, or over your raised log or capture limit, before reading it.) Coworkers' unbound clients still get a plain 403.

After that, the call is handled exactly like a pasted-token call for that agent: same slice, same cells, same kill switches.

## Your levers

```sh
pocketbrain oauth status                              # settings, bound connections, connections waiting for you and what each asked for
pocketbrain oauth bind <client-id> --agent muse --name "Muse"   # let a waiting connection in as muse
pocketbrain oauth expect <agent>                      # your own next new sign-in, within 10 minutes, connects as <agent>, once
pocketbrain oauth revoke <client-id>                  # cut one connection off for good
pocketbrain token --revoke muse                       # cut muse off everywhere: pasted tokens and every OAuth connection
```

The dashboard's Revoke button calls the same function as `token --revoke`, so it cuts OAuth connections too. Revocation bites on the next call, because the binding is checked on every request; there is no wait for the access token to expire. A revoked client never shows up as waiting again; the assistant has to reconnect, which registers a new client that waits for you.

Muse and claude.ai register a new client each time you reconnect them. So run `pocketbrain oauth expect muse` before reconnecting (or `pocketbrain oauth status` and bind the new client after). Letting the new client in as an agent that already has one replaces the old one: the old client is refused from then on and keeps its label for the new one, and it is listed under "Replaced by a reconnect" on the dashboard's Assistants page and in `oauth status`. Each is still an app at Auth0, which caps a free tenant's apps, so delete them there with one click (**Delete N old apps at the sign-in service**) or `pocketbrain oauth cleanup`; both need the management client below. An assistant that really has two connections as one agent keeps both with `oauth bind <client-id> --agent <agent> --keep-old`. The dashboard's **Approve** and an `oauth expect` window always replace. To undo a replace before cleanup deletes the old app, bind the old client again with `--keep-old` (`oauth bind` and `oauth status` print the line); once deleted at Auth0 it is gone. A replace is not a revoke: the agent isn't flagged as coming back. The management app, a machine app (the Gardener's) and a coworker's connections are never bound to an agent, so a reconnect never replaces them and cleanup never deletes them.

`oauth expect` (and `pocketbrain add --door oauth`, which opens it for a new agent) writes the window to `rules/oauth.yaml` as an owner commit. The first unbound client signed in as **your** account (`sub` is the owner subject; coworkers and machines never match), first seen after the window opened and before it closes, is bound to that agent, also as an owner commit naming the client. Then the window closes: a second sign-in waits as usual. A connection that was already waiting before the window opened is never swept in. Revoking the agent closes its window.

A waiting connection is listed for a day after its last call; at most 10 new ones are noted an hour. The dashboard can also create a new trial agent for a waiting connection in one step ([add-an-agent.md](add-an-agent.md)).

## Which authorization server

**Auth0.** Picked 2026-10-09. Auth0 supports dynamic client registration, publishes a JWKS, and issues JWT access tokens whose audience is an API identifier, which is all pocketBrain checks. Nothing in `src/oauth.ts` is specific to one provider: any authorization server with registration, a JWKS and a settable audience works. WorkOS AuthKit was the first pick and is dropped; Stytch Connected Apps is still a fallback. Cloudflare Access was dropped earlier, because its documentation does not show it acting as a registration-capable authorization server for a self-hosted MCP endpoint.

Settings in Auth0 (names as of 2026-10; check the dashboard if they moved):

1. Create a tenant (free plan). Its domain, for example `https://<tenant>.us.auth0.com/`, is the issuer. Keep the trailing slash: Auth0 puts it in every token's `iss`, and pocketBrain compares it exactly.
2. Applications → APIs → Create API. Identifier: `https://brain.<your domain>/mcp/oauth`, signing algorithm RS256. Turn on **Allow Offline Access** so the assistant can refresh its token.
   Then, in that API's access settings, let self-registered assistants in. Under **Application Access Policy**, set **User-delegated Access** to **All apps allowed**. Under **Default Permissions for third-party applications**, set **User-delegated Access** to **Authorized**, and leave **Client Access** unauthorized. Without both, Auth0 stops the sign-in with *invalid_request: Client "…" is not authorized to access resource server "…"*. Clients that register themselves (DCR) are third-party apps, and a new client is registered on every reconnect, so a per-app grant doesn't last (names as of 2026-10).
3. Settings → General → API Authorization Settings: set **Default Audience** to that same identifier. Muse may not send a `resource` or `audience` parameter, and without a default audience Auth0 hands out an opaque token pocketBrain can't check.
4. Settings → Advanced: turn on **OIDC Dynamic Application Registration**.
5. Make your login connection available to registered apps: apps that register themselves are third-party apps and only see domain-level connections. If the dashboard has no switch for this, use the Management API Explorer: `PATCH /api/v2/connections/<connection id>` with `{"is_domain_connection": true}`.
6. On that connection, turn sign-ups off, so only your own account exists. Sign in once and copy your user id from User Management → Users (for example `auth0|…`, or `google-oauth2|…` if you use Google sign-in).

Then, on the hub:

```sh
pocketbrain oauth setup --issuer https://<tenant>.us.auth0.com/ \
  --resource https://brain.<your domain>/mcp/oauth --owner-subject 'auth0|…'
```

pocketBrain finds the keys from the issuer's metadata. If that fails, add `--jwks https://<tenant>.us.auth0.com/.well-known/jwks.json`.

Auth0 puts the registering client's id in the token's `azp` claim, which is what `oauth bind` matches.

The resource must be a stable address: the Cloudflare named tunnel on your domain. A `trycloudflare.com` address changes on every restart and would break every token.

## Muse, step by step

1. Hub running, named tunnel up (`pocketbrain hub tunnel-config` already lets `/mcp/oauth` and its metadata through).
2. `pocketbrain oauth setup …` as above.
3. Open a window for Muse first: `pocketbrain oauth expect muse --name Muse`. Your next new sign-in within 10 minutes becomes Muse, once, with no client id to copy.
4. In Muse's connector form: **MCP endpoint** `https://brain.<your domain>/mcp/oauth`; **MCP docs** any public page that says what the connector does (this file, once the repo is public).
5. Muse opens the sign-in page in its own browser. Sign in with your Auth0 account and approve. Muse's first calls, even sent in parallel, all get in.
6. Ask Muse something from its slice, then something outside it (money). The second should come back as if the note didn't exist.

If you added the connector before opening the window, Muse's first session is the waiting one: it can only file an access request (`request_access`) and reads nothing, and the window won't sweep in a connection that was already waiting. Approve it on the dashboard's Assistants page (*Sign-in connections*), or run `pocketbrain oauth status`, find the waiting client, and `pocketbrain oauth bind <client-id> --agent muse --name Muse`.

`test/oauth-muse.test.ts` plays this whole flow against an Auth0-shaped fake: registration, PKCE, the window, parallel first calls, refreshes (also two racing with one refresh token), a signing key rotated in seconds before a refresh, a reconnect, and the door URL with a trailing slash.

## What we know from another live connector

Another MCP server (a separate app with its own authorization server) has had Muse connected since 2026-09-26. From it:

- Muse uses dynamic client registration, then authorization code with PKCE S256, from an in-app browser on the phone. Its callback is on Meta's agent host, which many Meta agents share, so the callback alone doesn't identify Muse.
- Muse registers a new client on every reconnect (hence step 3 before any reconnect). Each one is an app in Auth0, which caps a free tenant's apps: the new one replaces the old, and `pocketbrain oauth cleanup` (or the dashboard's button) deletes the old apps there.
- That server logged one Muse bug: a fresh token refused right after a refresh, caused by a parallel refresh replaying the old refresh token. Refresh happens at Auth0 here, and pocketBrain accepts any valid access token from a bound client, old or new, so pocketBrain itself doesn't refuse it. Two things around a refresh did make pocketBrain refuse, both fixed and tested: Muse's parallel first calls through an `oauth expect` window (only the first got in), and a token signed with a key the authorization server had rotated in less than 30 seconds after pocketBrain last fetched its keys. If Muse still drops its sign-in after a refresh, that is Auth0 refusing the replayed refresh token (refresh token rotation on the Muse app); Auth0's logs show it, and a reuse interval on rotation, or rotation off for that app, stops it (inferred from Auth0's documented behaviour, not seen live).
- That server ignored `scope` and `resource`, and Muse still worked. Neither is required from Muse here either: Auth0's default audience sets it.

## Not built

- Scopes per tool group. The binding to an agent and that agent's slice decide everything; scopes would add nothing the slice doesn't already enforce.
- The OAuth door on `/v1`. Instinct uses pasted tokens.

## Revoke reaches Auth0 (optional)

By default, Revoke (dashboard or `pocketbrain oauth revoke`) cuts a client off here: every request from it is refused. The assistant still holds a refresh token at Auth0 and keeps trying. To also delete the client at Auth0, so the assistant shows the connection as gone:

1. In Auth0, create a Machine to Machine application authorized for the Auth0 Management API with only the `delete:clients` scope.
2. `pocketbrain oauth management <its client id>`
3. Put its client secret in the key file `~/.config/pocketbrain/keys/AUTH0_MGMT_CLIENT_SECRET` (mode 600, from 1Password), then restart the hub.

Each revoke then calls the Management API after the local cut, and `oauth cleanup` uses it to delete the apps a reconnect replaced. That call is best effort: if Auth0 is down or refuses, the client stays refused here and the outcome is written to `.oauth/as-cuts.json`. The secret never goes in `rules/oauth.yaml`.

## Coworkers

A coworker can connect their own assistant to your brain, signed in at the authorization server as themselves, and see one agent's slice only.

To make that agent read-only with an end date, personal at most and no money, create it with `pocketbrain share add` first (`docs/share.md`), then add the coworker on it. `pocketbrain share end` also removes the coworker.

1. Add an agent for them in `rules/policy.yaml` with the slices they may read (for example `alice: { tier: trial, slices: [project-x] }`).
2. `pocketbrain oauth coworker add <their user id at the AS> --name Alice --agent alice`. Their account must exist at the AS (in Auth0, create the user or invite them; sign-ups stay off).
3. They add the connector and sign in. The connection waits; `pocketbrain oauth status` lists it.
4. `pocketbrain oauth coworker bind <their user id> <client-id>`.

Bindings are per person: a client id you bound for yourself never answers a coworker's token, even when the client id is shared (client metadata documents). An agent is either yours or one coworker's, never both. Revoke on the agent (dashboard or CLI) or `pocketbrain oauth coworker remove <user id>` cuts them off on their next request. Everything else applies unchanged: the carve, FGA if on, the read log, the kill switch.

### Offboarding follows the sign-in service

With a management client set (see "Revoke reaches Auth0"), the hub also asks Auth0 every 30 seconds whether each coworker's account is still active. Give the management app the extra permission `read:users`. Block or delete a coworker in Auth0 and their assistants are refused at the next check, even with an access token that hasn't expired; the owner gets one alert ("coworker left: cut at sign-in"). Unblock them and they're let back in. If Auth0 can't be asked for 10 minutes, coworkers are refused until it answers. Tune with `coworker_check_s` and `coworker_max_age_s` in `rules/oauth.yaml`.

## The gardener's own identity

The gardener can sign in as itself instead of carrying a pasted token: a machine app at the authorization server, using client credentials, with no person behind it.

1. In Auth0, create a Machine to Machine application and authorize it for the pocketBrain API (identifier = the resource URL).
2. `pocketbrain oauth machine <its client id> --agent gardener`. Only an agent with `role: gardener` can be bound this way.
3. The gardener gets its tokens from Auth0 (`grant_type=client_credentials`, `audience=<resource>`) and calls `/mcp/oauth`.

Everything that holds for the gardener's pasted token holds here: its hours and the tripwire, the proposal cap, its slice, the read log. Revoke on the gardener cuts the machine too.
