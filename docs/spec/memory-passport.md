# Memory Passport: an open door to a personal memory server

Status: draft 0.2, 2026-10 (0.2 adds handoffs, route-limited credentials, waiting sign-ins and the request budget). Implementation-neutral. pocketBrain is one implementation; [conformance/reference-server.ts](../../conformance/reference-server.ts) is a second, small one that shares no code with it. Notes on where pocketBrain stands are marked *pocketBrain*.

A personal memory server holds one person's memory (the **owner**) and serves it to several AI assistants (**agents**), each limited to a **slice**. Memory Passport is the wire contract an assistant vendor implements once to connect to any such server: one URL in the assistant's settings, and the assistant reads and writes within its slice.

How an agent gets a credential and the owner's approval is in [agent-onboarding.md](agent-onboarding.md). This document is the door itself: what an approved agent sends and what it gets back. The key words MUST, SHOULD and MAY are used as in RFC 2119.

## The one rule

**Whatever an agent may not see answers exactly like something that doesn't exist.** A hidden note, a hidden fact, and a value from either never appear in any answer to that agent, and the answers don't differ in a way that tells the agent they are there: not in status, not in wording, not in timing it can measure cheaply. Every requirement below is a case of this rule or of "every write cites a source".

## Discovery

`GET /.well-known/memory-passport`, without a credential, answers JSON:

```json
{ "memory_passport": "0.2", "doors": { "api": { "url": "https://brain.example/v1", "auth": "bearer" } }, "orientation": "https://brain.example/v1/orientation" }
```

- It MUST carry `memory_passport` (the version) and `doors.api.url`. It MAY list more doors (MCP, OAuth: see agent-onboarding.md).
- It MUST NOT reveal anything about the owner or the memory.

*pocketBrain:* the same document as `/.well-known/pocketbrain`, which also lists the MCP and OAuth doors and the enroll route.

## Credentials

Every `/v1` route takes `Authorization: Bearer <credential>`, one credential per agent. A missing, unknown or revoked credential MUST get `401`, and the answer MUST NOT carry memory content.

- A credential anywhere but the `Authorization` header (a query parameter such as `access_token`, a cookie, another header) MUST count as no credential: `401`. URLs end up in logs.
- Who the caller is comes only from the credential. A header, query parameter or body field naming an agent (`X-Agent`, `?agent=`, `"by"`) MUST change nothing.

### Waiting sign-ins

An assistant can sign in before the owner has approved it (the OAuth door in agent-onboarding.md). Until the owner approves, its credential MUST get nothing from the memory on any door: on `/v1` it answers exactly like an unknown credential (`401`, same body). A server MAY let a waiting sign-in file one access request (a name for itself, what it is for, the slices it would like); the request grants nothing, and only the owner's approval does.

*pocketBrain:* the waiting session on `/mcp/oauth` offers one MCP tool, `request_access`, and nothing else; the request shows on the owner's dashboard card (src/access-request.ts).

### Route-limited credentials

A server MAY issue an agent a credential that works on some routes only, for example a **resolver** credential for the owner's dispute and message routes (outside this spec). On every other route it MUST be refused, with a `4xx` that carries no memory and is the same whatever note it asked for, and its writes MUST NOT be recorded.

*pocketBrain:* `pocketbrain token --agent <agent> --role resolver` (the agent named as resolver or the owner's channel only) works on `/v1/disputes` and `/v1/owner/` and answers `403` everywhere else; `--role reader` is the opposite split, its slice below private.

### Request budget

A server MAY cap how many requests one credential sends (a runaway loop retrying). Over the cap it MUST answer `429` with a `Retry-After` header (seconds or an HTTP date) and no memory. The budget counts requests, not what they ask for: over it, a visible, a hidden and a missing note all answer `429`, and a hidden and a missing one alike. One agent over its budget MUST NOT stop another.

*pocketBrain:* 120 requests a minute and 300 writes an hour per agent and token role by default, on every door (`budget:` in policy.yaml, [hub.md](../hub.md#request-budget), src/budget.ts); B1 reaches it.

## Flags only tighten

A server MAY accept query parameters or body fields this spec doesn't define. Such a flag MAY narrow an answer; it MUST NOT widen one. With any flags, a hidden note still answers like a missing one, a hidden fact or value still stays out, and a write gets no further than it would without them (a write held for the owner stays held, whatever `verification`, `direct` or `force` it claims).

## Routes

All paths are under `doors.api.url`. Errors are JSON `{ "error": "…" }` unless stated.

### `GET /v1/orientation`

What this agent sees, what is withheld, how it may write and what the markers mean, as text (Markdown). It MUST describe only the caller's own slice: no other agent's name, no hidden content.

### `GET /v1/search?q=…`

A JSON list of hits, best first: `[{ "id", "title", "type", "area" }]`. Only notes in the caller's slice; a hit's fields MUST NOT carry a hidden value. A search for a hidden note's id MUST answer like a search for a missing id in the same folder.

### `GET /v1/notes/{id}`

`id` is URL-encoded (`people%2Fjane-roy`). A note in the caller's slice answers `200`:

```json
{ "id": "projects/course-a", "title": "Course A", "type": "project", "area": "work", "aliases": [],
  "facts": { "next_step": { "value": "Grade the midterm", "as_of": "2026-10-01", "sources": ["gmail:f000000000000003"] } },
  "body": "Course logistics. Budget questions go to [withheld]." }
```

- A note outside the slice MUST answer exactly like a missing note: `404`, with a body and headers that differ only by the id the agent asked for, however the id is written (encoded or plain slash, other case, trailing slash, `.md`).
- A fact the agent may not see MUST be left out of `facts`.
- A hidden value or a link to a hidden note inside visible text MUST be replaced with a marker. `[withheld]` is RECOMMENDED; orientation MUST say what the marker means.

### `POST /v1/remember`

```json
{ "id": "projects/course-a", "attribute": "room", "value": "B-201", "as_of": "2026-10-01", "sources": ["gmail:f000000000000009"] }
```

The answer is JSON with an `outcome`:

| Outcome | Status | Meaning |
|---|---|---|
| `committed` | 200 | Recorded. |
| `inbox` | 200 | Held for the owner's approval (a new agent's writes, or a write outside the agent's own area). |
| `noop` | 200 | The memory already said this. |
| `refused` | 4xx | Not recorded; `message` says why and how to fix it. |

- A write without at least one source (`scheme:id`) MUST be refused. `as_of` is when the fact became true and MUST NOT be after the server's today.
- A write to a note outside the slice MUST answer exactly like a write to a missing note.
- A write to a fact the agent may not see MUST answer like a write to a fact that doesn't exist yet: same status, same outcome, and no hidden value or date in the message. It MUST NOT replace or reveal the hidden fact.
- Server-side fields (who wrote it, when) come from the credential, never from the body.

### `POST /v1/handoffs`

```json
{ "to": "planner", "task": "Booked the room; the catering is left", "next_step": "Order lunch for 12" }
```

One agent hands a task it started to another of the owner's agents, by name. The answer is `200` with `{ "id", "reply" }`.

- The answer to the sender MUST be the same whether the handoff was delivered or held for the owner: a handoff can't be used to test what the recipient may see.
- A handoff whose text carries a value the recipient may not see MUST NOT reach it as written: the server holds it for the owner (RECOMMENDED) or withholds the value.
- The recipient MUST NOT be told which agent sent it. Orientation still names no other agent.

### `GET /v1/changes`

What changed in the caller's slice since it last asked. Its `handoffs` list (`[{ "id", "task", "next_step", "at", "from" }]`, `from` naming no agent) holds the handoffs waiting for the caller, first. `POST /v1/handoffs/done { "id" }` closes one. A server MAY add other fields; the list of changed notes is outside this spec.

## Bundles

A server MAY export memory as a JSON bundle, so the owner can leave or move it. A **slice bundle** is one agent's view: `{ "memory_passport": "0.2", "bundle": "slice", "agent", "exported", "notes": [ … ] }`, each note exactly as `GET /v1/notes/{id}` answers that agent, so it MUST hold nothing that agent may not see. Only the owner exports; no agent route returns a bundle. A bundle MUST NOT carry credentials.

*pocketBrain:* `pocketbrain export [--agent <agent>] --out <file>`; its own whole-brain bundle and `pocketbrain import` are in [export.md](../export.md).

## Conformance

[conformance/](../../conformance) holds the test suite. It runs against any server over HTTP:

1. Load [conformance/fixture.json](../../conformance/fixture.json) into the server: six notes about a fictional owner, and two agents, `full` (sees everything, writes directly) and `limited` (three notes plus one person's role, writes held for the owner).
2. Give each agent a credential.
3. `bun conformance/run.ts <base url> --full <token> --limited <token> [--resolver <token>] [--waiting <token>]`. `--resolver` is a route-limited credential for the full agent and `--waiting` one for a sign-in the owner hasn't approved; without them, their checks are skipped (SKIP in the report).

The suite checks discovery (D1, D2), credentials (A1, A2), orientation (O1), reads (R1 to R5), search (S1 to S3, R6), flags (F1 to F5), identity (I1 to I3) and writes (W1 to W5), reads before writes; then, from 0.2, handoffs (H1 to H3), route-limited credentials (P1, P2), waiting sign-ins (Q1) and, last, the request budget (B1: up to 400 reads as the limited agent; a server that never answers `429` passes, since a budget is optional). It exits 1 when a MUST check fails. It writes to the server, so run it on a throwaway copy.

Each check that guards the one rule is shown to bite: [conformance/mutants.ts](../../conformance/mutants.ts) wraps the reference server with one plausible mistake at a time (a `403` for a hidden note written with a plain slash, a header saying why a note is missing, `include_hidden=true` honoured, `direct: true` skipping the owner, an `X-Agent` header or a query token taken as identity, the writer's name taken from the body, a handoff's sender told it was held, a handoff delivered unchecked under its sender's name, a resolver credential that reads, a waiting sign-in read as an agent, a `429` without `Retry-After`, a budget that skips hidden notes), and each mutant must fail exactly the checks named for it.

To try it without a server of your own: `bun conformance/reference-server.ts 8790` prints four tokens (full, limited, resolver, waiting); pass them to `run.ts`. Its request budget is 300 requests per credential per minute.

*pocketBrain:* `test/conformance.test.ts` runs the suite in process against pocketBrain on `examples/brain` (plus the fixture's one extra note), with its resolver token and a waiting sign-in from a test authorization server, against the reference server and against every mutant, on every `bun test`. `bun run conformance` (CI job `conformance`) runs it over real HTTP against a reference server and a pocketBrain hub on a throwaway copy (Q1 skipped for the hub: a waiting sign-in needs a live authorization server). Both pass every check that runs, B1 included: each one's budget answers `429` within the suite's 400 reads. The fixture's limited agent writes through the owner's inbox; a run with a limited agent that writes directly would also exercise the hidden-fact write rule against a committed write, a case pocketBrain tracks as an open gap.

## Not in scope (0.2)

Onboarding and approval (agent-onboarding.md), MCP framing of the same operations, retiring facts, the list of changed notes in `/v1/changes`, agent journals, disputes and the owner's routes, agent-to-agent mail (handoffs are in), storage format, and models.
