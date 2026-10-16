# Step 0b: verify what each assistant can connect to

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

Louis reported on 2026-10-08: **Town and Muse support custom MCP servers. Instinct can make plain API calls but not custom MCP. All three have Gmail, calendar and Drive.** This checklist confirms those answers with a live call. It doesn't try to discover them.

## Town and Muse (custom MCP)

1. Add a test MCP server URL (an unmodified Basic Memory or GBrain behind a tunnel, which we provide when you're ready).
2. Note the auth it accepts: OAuth, API key or header, or none.
3. Ask it one question that can only be answered from the test notes. Check that it calls the server.
4. Check whether it calls the server *unprompted* once a standing instruction says "check memory at the start".
5. Check whether it works in the mobile app too.

## Instinct (plain API)

1. Confirm it can call an HTTPS endpoint with a header-based key (GET for read, POST for write).
2. Confirm it can be told *when* to call it (standing instruction, or a skill/routine).
3. Ask the same test question through the API.

## Record it here

| Assistant | Transport | Auth that works | Calls unprompted? | Mobile? | Notes |
|---|---|---|---|---|---|
| Instinct | API (reported) | | | | |
| Town | MCP (reported) | | | | |
| Muse | MCP (reported) | | | | |

## What it changes

- The gate in architecture.md 0.2 passes on Louis's report (2 of 3 can do MCP). The phase-2 server needs **two front doors**, MCP and a small read/write web API, on the same views and the same write path.
- All three agents can reach Gmail, calendar and Drive, so per-agent views are **minimization** (less sent to each vendor, smaller prompt-injection blast radius), not protection from the agents themselves. That keeps views simple: an agent's view can stay broad unless a note is sensitive *and* not already in that agent's mailbox or Drive.
