# Agent refusals

The hub refuses an assistant for many reasons: a note outside its slice, a write without a source, a fact above its level, a tool it isn't offered. A refusal that keeps happening means the assistant's instruction, or the refusal's own wording, needs work. `pocketbrain week` shows which.

## What is recorded

Every MCP tool call, every `/v1` API request and every browser-door page (`/b`) an assistant opens adds one line to `log/calls.jsonl`:

- when, which assistant, and which tool or route;
- when it was refused, the refusal's **kind**.

A route is recorded by its resource, never by a note's path or a dispute's number: `GET /v1/notes`, `POST /v1/disputes/resolve`. A tool name the hub doesn't offer is recorded as `unknown tool`. Connecting is a call too: MCP `initialize` is recorded as `initialize` (and `GET /v1` as itself), and in `log/reads.jsonl` it is a `connect`, not an orientation read, so an assistant that connects but never calls a tool shows as just that. A browser-door page is recorded by its path without its query (`GET /b/context`, `GET /b/notes`), an unknown page as `GET /b/other`, and a refused one by its status code.

The kind is the refusal text cut to its first eight words, with quoted text, numbers, note paths, addresses and links taken out. "no note people/jane-roy in your view" becomes `no note <id> in your view`. So the same refusal reads the same each time, and no note content lands in the log. Like the other files in `log/`, it stays on your Mac and only you read it.

## A protocol the hub doesn't speak yet

MCP's 2026-07-28 revision drops the `initialize` handshake: an app stamps every request with its version and may first ask `server/discover`. The hub speaks the handshake versions only. A request stamped 2026-07-28 or later, and `server/discover`, get HTTP 400 with a plain error that names the versions the hub speaks and says to start with `initialize`; nothing runs. That is the answer an app that speaks both needs in order to fall back, so the hub never answers with the newer protocol's own "unsupported version" error, which would tell the app not to.

Each try is a line here: `mcp 2026-07-28 tools/list`, or `mcp unstamped server/discover`. Only a date and a plain method name are kept of what the app sent. A method the hub doesn't know is `unknown method <name>`. The daily self-check `mcp_version` (`docs/real-use-bar.md`) tells you once which assistant asked, so you can check it still reads the brain.

## When a door skips the log

Every agent read comes through a door that logs a call, so `pocketbrain doctor` warns (`call log`) when an assistant read the brain in the last day with no line here: the call log is missing a door, and its refusal stats would be wrong without saying so.

## In the week report

`pocketbrain week` adds an **Agent refusals** section:

- a row per assistant: its calls this week, how many were refused (and the share), its five commonest tools, and its three commonest refusal kinds;
- a line for each assistant refused more than 20% of the time, with its commonest refusal: its standing instruction or that refusal's text probably needs a fix;
- the refusals an assistant retried anyway, meaning the same refusal on the same tool again within 10 minutes. The refusal text didn't tell it what to do instead.

The section is left out of a week with no calls.
