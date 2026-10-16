# Agent onboarding to a personal memory server

Status: draft 0.1, 2026-10. Implementation-neutral. pocketBrain is one implementation; notes on where it stands are marked *pocketBrain*.

A personal memory server holds one person's memory (the **owner**) and serves it to several AI assistants (**agents**), each limited to a **slice**. This spec is how a new agent, from any framework, goes from "I have the server's address" to "I read and write within my slice, and the owner approved it", with the owner's part reduced to one decision.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

## Principles

1. **Default deny.** An agent the owner hasn't approved reads nothing and writes nothing.
2. **The owner decides; the agent only asks.** Nothing an agent sends can widen its own access.
3. **Enforced by the server, explained to the agent.** Instructions tell an agent how to behave; the server enforces the slice whether or not the agent follows them.
4. **One credential per agent.** Each agent can be revoked without touching the others.

## The six steps

### 1. Discover

Given the server's base address, an agent finds how to connect.

- A server SHOULD publish, without authentication, which doors it has: an MCP endpoint for agents with a pasted credential, an MCP endpoint for agents that sign in with OAuth, and optionally a plain HTTP API with a machine-readable description (for example OpenAPI).
- The OAuth endpoint MUST publish OAuth 2.0 Protected Resource Metadata (RFC 9728) and answer an unauthenticated call with `401` and `WWW-Authenticate: Bearer resource_metadata="…"`.
- Discovery MUST NOT reveal anything about the owner or the memory's contents.

*pocketBrain:* `GET /.well-known/pocketbrain` lists the doors (`mcp`, `mcp_oauth` when the OAuth door is set up, `api` with its OpenAPI link), the enroll route and where to read first, with the hub's public address; plus protected resource metadata for `/mcp/oauth`. When MCP settles on a server discovery document, this should follow its shape.

### 2. Authenticate

The agent gets its own credential.

- **OAuth.** The server is only a resource server. A hosted authorization server (any that supports dynamic client registration or client ID metadata documents, publishes a JWKS and issues audience-bound tokens) signs the owner in and issues tokens. The server MUST check signature, issuer, audience and expiry on every call, and MUST accept only tokens whose subject is the owner (or a person the owner explicitly let in).
- **Pasted credential.** For agents that can't do OAuth, the owner issues a per-agent bearer token. The server MUST store only a hash of it.
- A server MAY offer a short, single-use **enrollment code** that an agent redeems for its own token, so the owner never handles the long-lived token.

*pocketBrain:* both, with Auth0 as one tested authorization server (the code is provider-agnostic). Enrollment: `pocketbrain invite <agent>` prints a code like `7KQ2M-X9FHD` (Crockford base32, 50 bits, 15 minutes by default, an hour at most, single use, hash only in `rules/invites.yaml`); the agent sends `POST /v1/enroll {"code": …}` and gets its token once. Wrong, used, expired and cancelled codes answer alike; 10 wrong codes in 10 minutes pause enrollment for the hub. Revoking the agent cancels its open codes.

### 3. Request access

An authenticated but unapproved agent waits for the owner.

- The server MUST answer every call from an unapproved credential with a refusal that says it waits for the owner, and MUST record it as a **request** the owner can see.
- A request MAY carry a proposed agent name, a purpose and suggested slices. All of it is untrusted text: the server MUST display it escaped, MUST NOT pass it to a model as instructions, and MUST NOT grant anything from it.
- The owner approves in a place only the owner reaches (a local dashboard, a CLI). Approval MUST show what the agent would receive under the chosen slice, computed by the same code that will enforce it: how many items, which areas, and whether any financial or private items are included.
- A new agent created from a request MUST start at the lowest trust level the server has (its writes wait for the owner) and MUST NOT get an "everything" slice.
- Requests MUST expire, and the server MUST rate-limit new ones, so registrations can't flood the owner's list.
- A server MAY let the owner open a short **approval window** for one named agent: the next new credential presented by the owner's own account within the window is approved as that agent, once. The window MUST be bounded (minutes), single-use, limited to the owner's own subject, and recorded.

*pocketBrain:* waiting sign-ins are listed on the dashboard's Assistants page with a one-tap "new agent" preview and Approve (always trial, money out by default); requests lapse after a day and at most 10 new ones are noted an hour; `pocketbrain add --door oauth` and `oauth expect` open a 10-minute, one-client window. Agent-proposed name, purpose and slices are not built: today the owner types them.

### 4. Orient

The approved agent learns its slice and rules.

- The server MUST tell each agent, from the current rules, what it can see, what is withheld, what it may write and where its writes land, and what any withholding markers mean. It MUST NOT name other agents or anything outside the caller's slice.
- This text SHOULD be available in three places: the MCP `initialize` instructions, a tool listed first (`orientation`), and an HTTP route.
- Because many hosts don't show initialize instructions to the model, the server SHOULD also provide a short **standing instruction** (under about 120 words, no credential) that the agent or the owner saves into the agent's own persistent instructions: check the memory before answering about the owner, even unasked; write lasting facts with a source; never work around withheld content.

*pocketBrain:* all three, generated per agent. The full orientation ends with the standing instruction under "Save this in your own instructions" (also `standing_instruction` in `GET /v1/orientation?format=json`); the short initialize text doesn't carry it. `connect` and `add` print the same block for the owner to paste into hosted assistants.

### 5. Operate

- Before answering about the owner, an agent SHOULD read from the memory (a topic-scoped context pack, then search and read).
- Every write MUST cite a source (a message, event or document id, or the owner's own words with a reference). Writes outside the agent's own area become proposals for the owner.
- Withheld content is final: an agent MUST NOT try to infer it, search around it, or ask another agent for it. It MAY ask the owner, through the server, for one read.

### 6. Stay in sync

An agent's own local memory drifts from the shared memory.

- A server SHOULD be able to check an agent's memory: by reading it when the agent's memory is readable, or by asking the agent questions about facts in its own slice and grading the answers against the memory.
- Corrections MUST be approved by the owner and SHOULD be signed, so an agent can tell a real correction from a message that only claims to be one.
- An agent MAY volunteer a report of what it holds about the owner (claims or pointers, never raw private content) for the server to compare.

*pocketBrain:* `memory_check` (tell_me / memory_dump): a quiz (`questions`) and owner-approved, signed `corrections`; when the owner asks (`pocketbrain memsync ask <agent>`), `memory_check` carries `tell_me` and the agent answers with a `memory_dump`, whose facts become owner proposals ([memory-sync.md](../memory-sync.md)).

## Revocation

The owner MUST be able to cut an agent off in one action, effective on its next call, across every credential it holds (pasted tokens and OAuth connections). A server SHOULD also delete the agent's client at the authorization server when it can.

## Not in scope

The read and write door itself, once onboarded, is [memory-passport.md](memory-passport.md).

Agent-to-agent messaging, how the memory is stored, and which model, if any, the server uses.
