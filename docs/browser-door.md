# The browser door: for assistants that can only browse

Some hosted assistants can open web pages and fill a password from their own vault, but can't send an `Authorization` header and won't keep a key pasted in chat. The browser door gives them the same brain through a sign-in page. Code: `src/browser.ts`; tests: `test/browser.test.ts`.

## What it is

- `GET /b` is a sign-in form with two fields, **Agent** (`autocomplete="username"`) and **Key** (`type="password"`, `autocomplete="current-password"`), so a password vault can fill it.
- A good sign-in sets a session cookie (`pb_browser`, `HttpOnly; Secure; SameSite=Strict; Path=/b`, one hour) and goes to the start page.
- Pages, all plain HTML with note text escaped:

| Page | Same as |
|---|---|
| `/b/orientation` | `GET /v1/orientation`, with the browser instruction block to save in place of the API one |
| `/b/changes` (+ Done form per handoff) | `GET /v1/changes`, handoffs first ([handoffs](handoffs.md)), Done is `POST /v1/handoffs/done`: from the last visit by default, which moves the cursor, so the page says so. `?since=<date>` looks further back (links for 7 and 30 days), and when more notes changed than fit, a link shows up to 50 at once |
| `/b/memory-check` (page + form) | `GET`/`POST /v1/memory-check` ([memory sync](memory-sync.md)): changed facts with their pointers, questions, corrections, one form to answer |
| `/b/context?topic=…` | `GET /v1/context` |
| `/b/search?q=…` | `GET /v1/search` |
| `/b/notes/<id>` | `GET /v1/notes/<id>` |
| `/b/remember` (form) | `POST /v1/remember`; as_of starts at the hub's today, so an agent whose clock runs ahead isn't refused as future-dated |

Reads are logged and writes go through the same write path as every other door.

Every page sends `no-store`, `X-Frame-Options: DENY` and a CSP that allows nothing but inline styles and the inline logo favicon (`img-src data:`). The favicon is the dashboard's (`src/favicon.ts`): its bar is near-black on light tabs and white on dark ones.

## What it is not

- **Off by default.** Only agents with `browser: true` in `rules/policy.yaml` can sign in. `pocketbrain connect <agent> --browser` sets it, as the owner, and commits it. For an agent wider than a narrow trial agent it needs `--code <code>` from the agent's dashboard page first (G184), and without one it changes nothing.
- **Fewer routes.** No owner, resolver (disputes), capture, log or gardener routes. The resolver work stays on `/v1` with a bearer token.
- **The cookie is not a token.** It opens nothing outside `/b`.
- **A token's role holds here too.** A reader token (`token --role reader`) signs in with its cap: nothing private. A resolver token is refused at sign-in, since its routes aren't on this door; sign in with the reader token.
- **No key in a URL.** The key is accepted only in the sign-in form's POST body (`GET /b/login` is 405).
- **Kill switches act at once.** Every request re-checks the token behind the session: `pocketbrain token --revoke <agent>` and `status: paused` end sessions on the next click.
- Failed sign-ins all get the same page; the hub log says why (unknown key, door off, wrong agent name). After 20 failures in 10 minutes from one client (Cloudflare's `cf-connecting-ip`), the form answers 429 to that client only, so junk from one place can't lock the agent out. The agent name is checked for shape before it reaches the log.
- Sessions live in the hub's memory: a hub restart signs everyone out.

## Turning it on

On the hub:

```sh
pocketbrain connect instinct --browser --url https://brain.<domain> --key-only | pbcopy
```

This turns the door on for that agent, makes a new reader key (nothing private), puts only the key on the clipboard (never on screen) and prints the sign-in page and the instruction block on stderr. Then, by hand, in the assistant's own settings:

1. Save a vault entry for `https://brain.<domain>/b` with username = the agent name and password = the key from the clipboard. Don't send the key in a chat.
2. Paste the printed instruction block into the assistant's custom instructions.
3. Ask it something only the brain knows, and check that it says "from your brain".

The tunnel must let `/b` out: `pocketbrain hub tunnel-config` includes it. A hub whose cloudflared config was written before this needs that config again and a tunnel restart; `pocketbrain doctor` warns until it has it.

## Why not the other routes

- A key in the URL (`/mcp/<token>`, refused since 2026-10-25) ends up in tunnel logs, and the assistant still has to keep the key somewhere it can type it.
- Mail (the capture mailbox) only goes one way; there is no read path.
- Another assistant relaying for it doubles the reach of one token and goes against "a new agent can't learn the rest through another agent".

## Under eval

`bun evals/run.ts --llm --only agents` includes two browser-door episodes (`agents-browser-door-answer`, `agents-browser-door-remember`). The agent gets only a stand-in browser (`evals/lib/browser-mcp.ts`: open a page, submit a form, sign in from the vault) and the `browserInstruction` block, never the key.
