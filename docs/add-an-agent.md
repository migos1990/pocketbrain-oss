# Add an agent

The checklist for every new assistant, after the first one that `pocketbrain init` set up. Five steps: pick its door, carve its slice, connect it, tell it when to use the brain, test it. Revoking is at the end.

## The short way

Once you know its door (step 1), one command does steps 2 and 3:

```sh
pocketbrain add newbot --slices area:work,contacts-basic --door mcp --url https://brain.<your domain>
```

It shows what `newbot` would see and grants nothing. Run it again with `--yes` to grant it. That adds `newbot` as a **trial** agent (writes wait for you), leaves money out (`--exclude-types` to change), commits `rules/policy.yaml`, and then prints:

- `--door mcp` or `--door api`: its token, where to paste it, and its standing instruction;
- `--door local`: the `claude mcp add` line for Claude Code on this machine, and the block for `~/.claude/CLAUDE.md`;
- `--door invite`: a one-time code instead of a token, for an agent that can make web calls. It sends `POST <address>/v1/enroll` with the code and gets its own token, so the token never passes through your hands. The code works once, for 15 minutes; `pocketbrain invite <agent>` makes a new one for an existing agent;
- `--door oauth`: the connector address, and its standing instruction. No token: for the next 10 minutes, your own next new sign-in is approved as `newbot`, once. Sign in from the assistant within that time and there's nothing to bind.

An agent that only has your address can find its doors at `<address>/.well-known/pocketbrain`, and its orientation ends with its standing instruction, so a framework that keeps its own instructions can save it itself.

**Switching assistants?** `pocketbrain add nova --like planner` starts the new one from the old one's slices and leave-outs, as trial, with an invite code and its standing instruction; see [switch-day.md](switch-day.md).

`add` (and `carve --confirm` for a new agent) refuses a name that is also an area, since an agent named after an area sees all of it. `add` also refuses an agent that already exists, the `all` slice and unknown slices. If an OAuth assistant reconnects later (Muse registers a new connection each time), `pocketbrain oauth expect <agent>` reopens the 10-minute window for it.

**On the dashboard instead:** when an assistant signs in through the OAuth door before you added it, it waits on the **Assistants** page under *Sign-in connections*. Open *or as a new assistant*, give it a name and tick its slices, then press *See what it would get*. The page shows how many notes it would see, which areas, whether any money or private notes are in, and an **Approve** button that creates it as a trial agent and lets that one sign-in in. A waiting sign-in lapses a day after its last call, and at most 10 new ones are listed an hour.

**When the assistant asks first:** a waiting sign-in has one tool, `request_access`, and its `initialize` tells it to call it with a name, what it will use the brain for, and the slices it would like. The Assistants page then shows "`hark`, a new trial assistant. The assistant says its name is "Hark" and its purpose: "…" Asks for: …" with **Review and approve as trial**, which opens the same preview, filled in. The request is only a suggestion (code: `src/access-request.ts`):

- Its text is shown escaped, marked as the assistant's own words, and never given to a model.
- The assistant always gets the same answer ("Sent to the owner. Nothing is readable until the owner approves…"), whatever it asked. Nothing in it says which slices, agents or names exist, so the waiting session can't be used to guess them.
- `all` is dropped; it can never ask for more than trial. The other slice names it gave are kept as it gave them: unknown ones show struck through, and only `area:` slices and slices you marked `requestable: true` are pre-checked (see below). Anything else it named is listed but left for you to tick.
- A name already taken, or reserved (`hub`, `relay`, `gardener`, `all`, anything that reads as you: `owner`, `louis`, your name in policy.yaml, or as another agent's id, label or alias), gets the plain id `assistant` (`assistant-2`…), never the existing agent and never a near-copy of it: a request named `helper`, `helper2` or `helper-1` while you have a helper is `assistant-N`, so the push never shows a `helper-2` that reads as yours. Only a name someone else already asked for and you haven't approved yet gets `-2`, `-3`…. `pocketbrain add` and Approve refuse those names too.
- Its name never becomes the label: the new agent's label is its id, and the name is shown only as "the assistant says its name is …". A label you type on Approve is refused when it reads as you or another agent: accents, case and punctuation don't count ("Stéward" is steward), Cyrillic, Greek and other look-alike letters count as Latin ("Аlex" with a Cyrillic А is alex, for an owner named Alex, and dotless ı is i), digits count as the letters they mimic, letter pairs as the letter they draw (cl as d, rn as m, vv as w: "stewarcl" is steward) and l as i ("p1anner" is planner), a name holding a hub role ("gardener-bot", "pocketbrain-admin") reads as that role, and a label that holds your name or the word owner anywhere ("Alex (owner)", "Alex M.") reads as you. The phone push for its ask-to-see names it by id, with any label beside it: "Hark (hark) wants to read…". The same reading picks a request's id: a request named "p1anner" or "gardener-bot" gets assistant-N, and invisible characters (bidi overrides, zero-width spaces, and letters that draw as blank space such as the Hangul filler or the empty Braille cell) are dropped from its name and purpose before you see them, and a pile of accents on one letter is cut to two.
- If its name, or its name without a number at the end, matches an agent you paused, set read-only or revoked, the card says so in red ("You paused helper; this looks like it coming back", "You revoked helper on 2026-10-15; …") and offers no one-click review. Check it really is the assistant you meant to stop before you let it in by hand. A revoke (the Revoke button, `token --revoke`, or `oauth revoke` of its last connection) stays flagged until you let a sign-in connection in as that agent again (`oauth bind` or `oauth expect`); a new pasted token or invite doesn't clear it. Look-alike letters and a trailing number or version count as the same name ("һelper" with a Cyrillic һ, "helper2", "helper_v2" all read as helper); a wholly different name isn't flagged, so check the client against the one you revoked.
- `pocketbrain oauth status` shows the same request under each waiting connection: the name it would get, its own words for name and purpose, the slices it asked for, and the same warning.
- `initialize` lists only the `area:` slices; your own named slices (which can name people) stay unlisted.
- One request per sign-in; asking again replaces it. A sign-in past the hourly cap can't file one. Its body is capped at 16 KB as it streams, however it is sent.
- Only your own sign-ins get the waiting session; a coworker's waits with a plain refusal.

**Slices an assistant may ask for:** area slices (`area:work`) can always be pre-checked on a request. A named slice in `rules/slices.yaml` is pre-checked only when you add `requestable: true` to it:

```yaml
slices:
  trips:
    types: [trip]
    requestable: true   # an access request naming it gets it pre-checked
```

Leave it off for any slice that names people or is wide (a slice with no filter is as wide as `all`).

You can still change the name or untick slices in *or as a new agent* before you approve.

Then do steps 4 and 5. The rest of this page is the same thing by hand.

Each assistant gets its own name in `rules/policy.yaml`, its own slice and its own credential, so you can cut one off without touching the others. Two assistants never share an agent name unless you want one revoke to cut both.

## 1. Pick its door

Look at the assistant's settings, not its marketing. What it offers decides the door:

| The assistant's settings offer | Door | Credential | Examples |
|---|---|---|---|
| A custom MCP server with a URL **and** a header or API key field | `/mcp` | pasted token | Town |
| A custom MCP server with a URL only, then a sign-in page | `/mcp/oauth` | OAuth sign-in, then you approve it once | claude.ai, Muse |
| A local MCP config on this machine | `/mcp` on `127.0.0.1:8787` | pasted token, no tunnel | Claude Code |
| No MCP, but it can call a web address with a header | `/v1` (JSON API, spec at `/openapi.json`) | pasted token | Instinct |
| None of these | none live | a dated snapshot, see [agent-instructions.md](agent-instructions.md) | |

If a URL-only form has no sign-in step, you can put the token in the address instead (`<address>/mcp/<token>`). That is a test-only fallback: the token ends up in the assistant's logs, so revoke it after.

A cloud assistant needs your public address (your named tunnel, see [hub.md](hub.md#a-fixed-address-on-your-domain)). The OAuth door also needs [oauth.md](oauth.md) set up once; after that, each new OAuth assistant is only steps 2 to 5.

## 2. Carve its slice

Start small: a new assistant is a **trial** agent. It sees up to `personal` sensitivity, and everything it writes waits for your OK. Pick from the ready-made slices (`area:<area>` for each area, `contacts-basic` for names and roles) and the ones in `rules/slices.yaml`:

```sh
pocketbrain carve newbot --slices area:work,contacts-basic --exclude-types money --preview
```

The preview lists every note it would see. When it looks right, grant it:

```sh
pocketbrain carve newbot --slices area:work,contacts-basic --exclude-types money --confirm
```

That adds `newbot` to `rules/policy.yaml` as a trial agent, in one owner commit, and builds its view. A new agent never starts with the `all` slice, and money is left out unless `--exclude-types` says otherwise (`none` for nothing), the same default as `add` (G193). For an agent that already exists, `carve --confirm` only shrinks what it sees, judged on what it would actually receive: no new note, text or fact, no fact a slice holds back today, no value scrubbed today let through (G179), and no loosening of the grant itself, such as `--exclude-types none` for an agent that leaves money out (G228) or a swap to a slice without one of today's filters (G248): any program with a shell can run the command line, an assistant included, so showing an agent more happens on the dashboard, on its page ("What is it for?"), where it needs your login. Then add `transport: api` to that line if it uses the JSON API, and a `label:` if you want a nicer name on the dashboard. `pocketbrain carve newbot --why <note id>` says why one note is in or out.

Promote it to `tier: core` (writes go straight in) only after it has earned it, and give it an area to own only if it should be the one keeping that area up to date ([design record](history/architecture.md), area ownership).

An agent's own corner needs no slice: its capability notes under `agents/<name>/`, and the notes it wrote itself in an area named after it, are always in its view. Nothing else in that area is: an area you add later under an agent's name (an `areas:` key, or a note's `area:` edited by hand) reaches that agent only through its slices, like any other area. Better still, don't name an area after an agent.

## 3. Connect it

**Pasted token** (`/mcp`, `/v1`, Claude Code):

```sh
pocketbrain connect newbot --url https://brain.<your domain>
```

It prints a token once, what to paste into the assistant's connector settings, and the standing instruction for step 4. Save the token in your password manager. Only its hash is kept.

For Claude Code, use the local address and the `claude mcp add --scope user --transport http "pocketbrain" http://127.0.0.1:8787/mcp --header "Authorization: Bearer <token>"` line instead.

**OAuth sign-in** (`/mcp/oauth`):

1. In the assistant's connector settings, add `https://brain.<your domain>/mcp/oauth`. Sign in with your own account at the sign-in service and approve.
2. Ask it anything once. The first answer says the connection waits for the owner.
3. Approve it: on the dashboard's **Assistants** page, under *Sign-in connections*, pick the agent and press Approve. Or `pocketbrain oauth status`, then `pocketbrain oauth bind <client-id> --agent newbot --name Newbot`. Only approve a sign-in you just made yourself.

Some assistants register a new connection every time you reconnect them (Muse does). Approve the new one each time.

For the standing instruction, run `pocketbrain connect newbot` too and ignore the token it prints, or copy the MCP block from [agent-instructions.md](agent-instructions.md). Revoke that unused token with `pocketbrain token --revoke newbot` only if you have no other token for it, since this also cuts its OAuth connections.

## 4. Tell it when to use the brain

Paste the standing instruction (from `connect`, or [agent-instructions.md](agent-instructions.md)) **once into the assistant's own custom instructions, memory or system prompt**, not into a chat. Without it, most assistants use the brain only when you say "use pocketbrain". Claude Code: add it to `~/.claude/CLAUDE.md`.

## 5. Test it

In a new conversation:

1. Ask something only the brain knows, **without** saying "pocketbrain". It should answer from its slice and say "from your brain". If it doesn't, step 4 didn't take.
2. Ask about something outside its slice (money, say). It should come back as if the note didn't exist.
3. Optionally, have it remember something with a source. As a trial agent, it lands in your inbox as a proposal.

`pocketbrain explain newbot <topic>` shows what its slice holds and what it was handed. Each time you have to explain pocketBrain to it again, log it: `pocketbrain reexplain newbot "<what>"`.

## Rotating a token

A pasted token (Town, Claude Code, an API assistant) is changed without a break:

```sh
pocketbrain token rotate town              # shows its slice and what would end; changes nothing
pocketbrain token rotate town --yes        # the new token and the connector lines to paste
```

The old token keeps working for 24 hours (`--overlap <hours>`, 0 to 168), so the assistant keeps
answering until you paste the new one. After that the old token is refused, like a revoked one,
and its line leaves `rules/tokens.yaml` at the next change. It is one owner commit ("owner: town
token rotated; the old one works until …"). A second rotate never makes an older token last longer.

- `--role reader` rotates a core agent's reader token and leaves its other tokens alone.
- The gardener rotates its own token into its vault: `pocketbrain gardener rotate`.
- A resolver token carries your own texts, so it has no overlap: revoke it and issue a new one.
- `pocketbrain doctor` warns when a pasted token is older than 90 days, with the rotate command.
- A token the sealed edge holds (`edge enroll`) is a separate token: enroll a new one there. The edge refuses a rotated-out token once its overlap ends, and drops it at the next `edge publish`.

## Revoke it

```sh
pocketbrain token --revoke newbot
```

Or press Revoke on the dashboard's Assistants page. Either one cuts every pasted token **and** every OAuth connection for that agent on its next call. `pocketbrain oauth revoke <client-id>` cuts one OAuth connection only. To narrow what it sees instead, run `carve … --confirm` again with fewer slices.

The agent's line stays in `rules/policy.yaml` until you delete it, so its history in the read log still has a name.

For assistant builders: the steps an agent takes on its own, from discovery to staying in sync, are in [spec/agent-onboarding.md](spec/agent-onboarding.md). The door they then read and write through is [spec/memory-passport.md](spec/memory-passport.md), with a conformance suite any server can run.
