# Request ids

When an agent says "it failed", ask it for the request id. Every answer the hub gives, on every door (MCP, OAuth MCP, the API, the browser door, enrolment, even a 401), carries an `X-Request-Id` header such as `req_3f2a9c0e1b7d4a6f8e21`. Then run:

```
pocketbrain trace req_3f2a9c0e1b7d4a6f8e21
```

It shows that one request's path through the hub:

- **Request**: when it came in, the door, the method and route (a template: only the hub's own route words are kept, every other segment is `:x`; no query string and no token), the MCP tool if there was one, the agent, the status and how long it took. This comes from `log/requests.jsonl`.
- **Log lines**: every log line the request wrote, in order. That covers the write log (the outcome and the check that refused it), alerts, reads, and the after-check queue. An after-check that ran later still carries the id of the request that queued it.
- **Commits**: every commit the request made, from its `Request-Id:` trailer, with the hash, author, kind and fact keys.

`--json` gives the same thing as JSON.

## What it never shows

Trace prints names only: agents, fact keys, outcomes, check names, kinds. It never prints a value, a note's text, a refusal's reason text, or a commit subject. `log/requests.jsonl` never holds a body, a query string or a token: a `/mcp/<token>` path is logged as `/mcp/<token>`, and a path a stranger made up (`GET /sk-proj-…`) is logged as `/:x`, so no secret shape reaches the file. The file is local: `pocketbrain init` lists `log/requests.jsonl` in the brain's `.gitignore`, so a `git add log` does not commit it (an older brain can add the line).

## Where the id comes from

The hub makes the id itself. A client's own `X-Request-Id` is never used, because one agent could otherwise reuse another's id and muddle a trace. Inside the request, the id goes on:

- every commit, as a `Request-Id:` trailer (`src/git.ts`);
- every jsonl log line, as `request_id` (`appendJsonl` in `src/util.ts`, `appendChained` in `src/readlog.ts`).

Writes made outside a request, such as the night pass, pulls or owner commands, carry no id. See `src/reqid.ts`.

## Size

`log/requests.jsonl` is about 200 bytes per request. `/health` is not logged, because the probe calls it all day. The night's housekeeping keeps the last 30 days of this file (`trimRequestLog` in `src/growth.ts`). It is the one log that gets cut; the hash-chained logs stay whole.
