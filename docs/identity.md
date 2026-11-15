# Identity words, in pocketBrain

People who work on sign-in and access already have words for most of what pocketBrain does. This page maps them, so a security or identity reader can place each piece, and says what is not built.

The split behind all of it: **the sign-in service says who is at the door; the owner's rules say what is behind it.** A token proves that the owner signed in, through one app. Which assistant that app is, and what it may read, is decided on the owner's machine in `rules/oauth.yaml` and `rules/policy.yaml`, never by the sign-in service and never by the assistant (invariant 2 in CLAUDE.md). The cut of the memory is the product, so it stays with the owner.

## The map

| Identity word | In pocketBrain | Code | Doc |
|---|---|---|---|
| Hosted authorization server | The hub never issues tokens. It checks each one against the owner's sign-in service: signature from the published keys, issuer, audience (this brain's door only), expiry, and that the account is the owner's, a named coworker's or a bound machine | `checkAccessToken`, `agentForOAuth` in `src/oauth.ts` | [oauth.md](oauth.md) |
| Client registration, pending approval | A new app that signs in gets nothing. It waits, and may only say who it is, what it is for and which slices it would like (`request_access`). The owner binds it to one assistant, or opens a ten-minute window for the next sign-in | `src/access-request.ts`, `bindClient` and `expectClient` in `src/oauth.ts` | [add-an-agent.md](add-an-agent.md) |
| Scopes | An assistant's slices of the memory, capped by its tier's ceiling (`max_sensitivity`) and its left-out types. Enforced in code on every read, through a per-assistant cell that holds only that slice | `grantFor` in `src/carve.ts`, `src/cell.ts` | [slice-proof.md](slice-proof.md) |
| Consent screen | Before the owner says yes, the dashboard shows what that assistant would get: how many notes, which areas, whether money or private notes are in, and examples. One sentence from the owner can also become a proposed slice | `newAgentPage` in `src/dashboard/html-brain.ts`, `src/consent.ts` | [consent.md](consent.md) |
| Step-up authorization | `ask_to_see`: an assistant asks for one read outside its slice; the owner approves on the phone (the sign-in service's push, through CIBA) or on the dashboard. One approval is one read of one note. The slice never changes | `src/asks.ts` | [ask-to-see.md](ask-to-see.md) |
| Revocation | Revoke cuts every way an assistant connects at once (tokens, sign-in connections), and with a management client also deletes its app at the sign-in service, so the assistant stops retrying | `revokeAgentClients`, `cutAtAuthServer` in `src/oauth.ts` | [oauth.md](oauth.md) |
| Deprovisioning | A coworker's account blocked or deleted at the sign-in service is refused here within the check interval (30 seconds by default), and refused if the check goes stale (fail closed) | `src/offboard.ts` | [oauth.md](oauth.md) |
| Delegated access to another person | A coworker's own account maps to one assistant with one slice, read through their own assistant | `addCoworker` in `src/oauth.ts`; a dated, read-only slice for a collaborator in `src/share.ts` | [oauth.md](oauth.md), [share.md](share.md) |
| Machine identity | The night job signs in with client credentials and is bound to the Gardener only | `bindMachine` in `src/oauth.ts` | [gardener.md](gardener.md) |
| Fine-grained authorization, second lock | OpenFGA (or Auth0 FGA) holds which assistant may read which slice, never a note. It can only take a slice away, and it fails closed | `src/fga.ts` | [fga.md](fga.md) |
| Audit log | Every read, by assistant and day, hash-chained; an "unusual" line when a day sits outside its usual areas | `src/readlog.ts`, `src/whoread.ts` | [sleep-and-explain.md](sleep-and-explain.md) |
| Kill switch | Pause or read-only per assistant, checked on every request | `status` in `rules/policy.yaml`, `src/server.ts` | [hub.md](hub.md) |
| Least privilege by default | A new assistant starts on trial: personal at most, money out, and its writes wait for the owner | `src/addagent.ts` | [add-an-agent.md](add-an-agent.md) |

A line for a slide: single sign-on gave you one login for many apps; this gives you one memory for many assistants, with the same controls: scopes, consent, step-up, revoke, audit, offboarding.

## Seeing it

The owner's screens for each row: the Assistants page in Settings (waiting sign-ins, Approve, Revoke), `/see/<agent>` (See as: one assistant's cut, fact by fact), Settings, Also here (an ask to see), and each assistant's page (What it read, day by day). Everything above runs on the made-up demo brain (`examples/demo-brain`), so it can be shown without anyone's real memory.

## What it does not do

- **The sign-in service never decides what an assistant reads.** Moving the cut into the provider would hand the product to a vendor; it stays in `rules/`.
- **Revoke stops serving; it cannot make an assistant forget.** What an assistant already read may sit in its own vendor's memory. Say "loses access", never "forgets".
- **A company's identity provider vouching for an employee** (MCP's enterprise-managed authorization, where the company's admin decides which servers the company assistant may reach) is not built. The coworker binding is the closest shape today: one outside account, one assistant, one slice.
- **One sign-in service for many owners' hubs** is not built. Each owner sets up their own today ([connect/claude-web.md](connect/claude-web.md)).
