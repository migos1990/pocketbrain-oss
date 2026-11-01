# Add an agent

New here? [connect.md](connect.md) has a short page per app (Cursor, VS Code, Codex, Gemini CLI, Claude Desktop, Claude on the web). This page is the full reference.

The checklist for every new assistant, after the first one that `pocketbrain init` set up. Five steps: pick its door, carve its slice, connect it, tell it when to use the brain, test it. Revoking is at the end.

## One command per kind

For the assistants pocketBrain knows, name the kind and answer one question:

```sh
pocketbrain add <name> --kind claude-ai|claude-code|town|browser --url https://brain.<your domain>
```

It shows what the assistant would see, asks "Grant it?", and on yes grants it (`--yes` skips the question). The kind picks the door. Without `--slices` it is a trial agent (up to personal, money left out, its writes wait for you) with `contacts-basic` and one area (`work` if there is one) for a kind whose token the terminal makes, or every area for `claude-ai`, whose door is your own sign-in. A terminal alone mints only for an agent that narrow (G184, G241); widen it on the dashboard, or give a wider agent its token with the one-time code from its page: `pocketbrain connect <agent> --kind <kind> --code <code>`. Then it prints only what is left for you, numbered:

| Kind | What `add --kind` does | What is left for you | Owner actions, before → after |
|---|---|---|---|
| `claude-code` | issues a token, runs `claude mcp add` for you, writes the standing instruction into `~/.claude/CLAUDE.md` between `<!-- pocketbrain -->` lines (replaced, never duplicated) | nothing; if the `claude` command isn't installed, one line to run | 4 → 1 |
| `town` (any MCP connector with a header field) | issues a token | 1. add the connector (URL and header), 2. paste the standing instruction | 4 → 3 |
| `claude-ai` (sign-in connector) | opens the 10-minute window for your own next sign-in | 1. add the connector and sign in, 2. paste the standing instruction into your preferences | 4 → 3 |
| `browser` (only fills web forms, like Instinct) | turns the browser door on, issues a reader key | 1. save the sign-in in its vault, 2. paste the browser instruction | 5 → 3 |

The agent `init` made is named after the kind you picked and connects with that kind's command: `pocketbrain connect <agent> --kind claude-code|claude-ai|town|browser` (init runs the Claude Code one itself when Claude Code is installed). A name that holds yours (`jim-claude` for Jim) is refused, since its asks would read as yours: use the kind (`claude-code`) or the assistant's own name.

Before, each kind took `add` to preview and `add --yes` to grant, then each paste by hand; the browser door also needed `connect --browser`, and Claude Code its `claude mcp add` line and a hand edit of `CLAUDE.md`. After, the command (with its yes) is one action. Counted from nothing to an answer from `context_pack`, not counting the test question. `test/add-kind.test.ts` checks each kind end to end.

## The short way

Once you know its door (step 1), one command does steps 2 and 3:

```sh
pocketbrain add newbot --slices area:work,contacts-basic --door mcp --url https://brain.<your domain>
```

It shows what `newbot` would see and grants nothing. Run it again with `--yes` to grant it. That adds `newbot` as a **trial** agent (writes wait for you), leaves money out (`--exclude-types` to change), commits `rules/policy.yaml`, and then prints:

- `--door mcp` or `--door api`: its token, where to paste it, and its standing instruction;
- `--door local`: the `claude mcp add` line for Claude Code on this machine, and the block for `~/.claude/CLAUDE.md`;
- `--door invite`: a one-time code instead of a token, for an agent that can make web calls. It sends `POST <address>/v1/enroll` with the code and gets its own token, so the token never passes through your hands. The code works once, for 15 minutes; `pocketbrain invite <agent>` makes a new one for an existing trial agent (a wider one's code comes from its dashboard page, see step 3);
- `--door oauth`: the connector address, and its standing instruction. No token: for the next 10 minutes, your own next new sign-in is approved as `newbot`, once. Sign in from the assistant within that time and there's nothing to bind.

An agent that only has your address can find its doors at `<address>/.well-known/pocketbrain`, and its orientation ends with its standing instruction, so a framework that keeps its own instructions can save it itself.

**Switching assistants?** `pocketbrain add nova --like planner` starts the new one from the old one's slices and leave-outs, as trial, with an invite code and its standing instruction; see [switch-day.md](switch-day.md).

`add` (and `carve --confirm` for a new agent) refuses a name that is also an area, since an agent named after an area sees all of it. `add` also refuses an agent that already exists, the `all` slice and unknown slices. If an OAuth assistant reconnects later (Muse registers a new connection each time), `pocketbrain oauth expect <agent>` reopens the 10-minute window for it.

**On the dashboard instead:** when an assistant signs in through the OAuth door before you added it, it waits on the **Assistants** page under *Sign-in connections*. Open *or as a new assistant*, give it a name and tick its slices, then press *See what it would get*. The page shows how many notes it would see, which areas, whether any money or private notes are in, and an **Approve** button that creates it as a trial agent and lets that one sign-in in. A waiting sign-in lapses a day after its last call, and at most 10 new ones are listed an hour.

**When the assistant asks first:** a waiting sign-in has one tool, `request_access`, and its `initialize` tells it to call it with a name, what it will use the brain for, and the slices it would like. The tool itself lists your area slices (`area:work`, …) as the only names it takes, since not every assistant shows a server's instructions; your own named slices are never listed. The Assistants page then shows "`hark`, a new trial assistant. The assistant says its name is "Hark" and its purpose: "…" Asks for: …" with **Review and approve as trial**, which opens the same preview, filled in. The request is only a suggestion (code: `src/access-request.ts`):

- Its text is shown escaped, marked as the assistant's own words, and never given to a model.
- The assistant always gets the same answer ("Sent to the owner. Nothing is readable until the owner approves…"), whatever it asked. Nothing in it says which slices, agents or names exist, so the waiting session can't be used to guess them.
- `all` is dropped; it can never ask for more than trial. The other slice names it gave are kept as it gave them: unknown ones show struck through, and only `area:` slices and slices you marked `requestable: true` are pre-checked (see below). Anything else it named is listed but left for you to tick.
- A name already taken, or reserved (`hub`, `relay`, `gardener`, `all`, anything that reads as you: `owner`, `louis`, your name in policy.yaml, or as another agent's id, label or alias), gets the plain id `assistant` (`assistant-2`…), never the existing agent and never a near-copy of it: a request named `helper`, `helper2` or `helper-1` while you have a helper is `assistant-N`, so the push never shows a `helper-2` that reads as yours. Two waiting requests with the same new name both get that id; approve one, and approving the other is refused as taken, so decline it (asked again, it gets `assistant`). `pocketbrain add` and Approve refuse a taken or reserved id, and one that reads as you, another agent or a hub role ("st3ward", "gardener-bot"), by the same reading as a label (next point), with two differences: only a whole part of your name counts (for Ann Lee, `ann-bot` is refused, `scanner` isn't), and a number at the end doesn't hide an agent (`steward-2`), except the `assistant-2` a request gets.
- Its name never becomes the label: the new agent's label is its id, and the name is shown only as "the assistant says its name is …". A label you type on Approve is refused when it reads as you or another agent: accents, case and punctuation don't count ("Stéward" is steward), Cyrillic, Greek and other look-alike letters count as Latin ("Аlex" with a Cyrillic А is alex, for an owner named Alex, and dotless ı is i), digits count as the letters they mimic, letter pairs as the letter they draw (cl as d, rn as m, vv as w: "stewarcl" is steward) and l as i ("p1anner" is planner), a name holding a hub role ("gardener-bot", "pocketbrain-admin") reads as that role, and a label that holds your name or the word owner anywhere ("Alex (owner)", "Alex M.") reads as you. The phone push for its ask-to-see names it by id, with a label beside it only when the label says more than the id: "claude.ai (claude) wants to read…", but just "hark" for a label Hark. The same reading picks a request's id: a request named "p1anner" or "gardener-bot" gets the id `assistant` (`assistant-2`, `-3`… when that is taken), and invisible characters (bidi overrides, zero-width spaces, and letters that draw as blank space such as the Hangul filler or the empty Braille cell) are dropped from its name and purpose before you see them, and a pile of accents on one letter is cut to two.
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

A token is accepted only in the `Authorization` header, never in the address: a URL-only form without a sign-in step can't connect (the `/mcp/<token>` form was removed on 2026-10-25 because a token in a URL ends up in tunnel and assistant logs).

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

Promote it to `tier: core` (writes go straight in) only after it has earned it, and give it an area to own only if it should be the one keeping that area up to date ([design record](history/architecture.md), area ownership). A core agent's fact outside the areas it owns files itself too (since 2026-10-25, the owner's "nobody approves facts"): a new fact lands, a newer value from a source at least as strong files as an update (the old one goes to history), and any other different value is a conflict that waits for the Gardener ([decision deck](decision-deck.md), "Conflicts wait for the Gardener"); over your own word it asks you at once, and the side you pick keeps citing its email. Outside its areas it still waits for you on a private note (or above), on a note holding a private fact or one it can't see, for an attribute its slice leaves out, when it takes a fact back, or when it claims your word. A weaker source than the held one never moves a max, min or latest value from outside: that is a held conflict too.

An agent's own corner needs no slice: its capability notes under `agents/<name>/`, and the notes it wrote itself in an area named after it, are always in its view. Nothing else in that area is: an area you add later under an agent's name (an `areas:` key, or a note's `area:` edited by hand) reaches that agent only through its slices, like any other area. Better still, don't name an area after an agent.

## 3. Connect it

**Pasted token** (`/mcp`, `/v1`, Claude Code):

```sh
pocketbrain connect newbot --url https://brain.<your domain>
```

It prints a token once, what to paste into the assistant's connector settings, and the standing instruction for step 4. Save the token in your password manager. Only its hash is kept.

**A token from the terminal needs your yes for anything wider than trial.** Any program that can run a shell can run `pocketbrain`, so on its own the terminal mints a token (`token`, `connect`, `connect --kind`, `add` and `add --kind`, `invite`, `edge enroll`, and init's Claude Code step) only for a narrow agent: a trial agent whose writes wait for you, that sees nothing private, whose slices are named areas, kinds or tags (never `all`, and never a list of notes with a filter added, which selects everything), that reaches at most one area (`area:work` plus `contacts-basic` is fine; a slice with no area and every field reaches across areas), that has money left out, and that holds no role (gardener, resolver, your text channel or editor). `add` with its defaults and the first agent `init` made are like that; `add` with more than one area or `--exclude-types none` and a token door is refused before anything is written (G241), so add it with `--door oauth` or narrower and widen it from the dashboard. For any other agent (a core agent, steward with `all`), open its page on the dashboard (Assistants, then the agent) and press **One-time code**. The page shows a code that works once, for 15 minutes, for that agent only. Then:

```sh
pocketbrain token --agent steward --code <code>       # or: pocketbrain connect steward [--kind claude-code] --code <code>
```

A code is bound to the kind of key it was made for: the plain **One-time code** makes the agent's normal or reader key; the resolver's page also has **One-time code for a resolver key**, which alone makes `--role resolver` (G245). Wrong codes typed at the terminal count against a limit kept in `.git/pb-enroll-fails.json`, across runs, and each one is a `token_code_refused` alert. Making a code creates that file; if it is missing, isn't a file or isn't a list of times, no code is taken from a terminal (G285, G314). A shell that writes `[]` back between guesses is not counted, though each guess is still an alert; that is part of G279 below. A code is spent once even when several terminals redeem it at the same moment (a lock file, `.git/pb-invites.lock`, G283). The hub's `/v1/enroll` never waits on that lock: while another redeem holds it, it answers 503 at once; a lock that is stale (its process gone, older than 30 seconds, or dated in the future) is taken over (G314). The lock is written whole before it appears (a file linked into place), so another terminal never finds it empty and takes it for stale (G335). `pocketbrain token --revoke` cancels the agent's open codes first; if the lock stays busy for 3 seconds, its sign-ins are still revoked but its keys are not, and the command says so and exits 1, so run it again (G336). The dashboard's **Revoke** pauses the agent first, so a revoke that fails this way leaves it paused (G352). A `.break` file left beside the lock (by a takeover that crashed, or dated in the future) is cleared the same way, and a caller that can't get the lock by its deadline answers busy, never waits on: `/v1/enroll` answers 503 at once (G351). A code redeemed at `/v1/enroll` is a `token_minted` alert too. A code `pocketbrain invite` made for a narrow agent is refused if the agent has been widened since (G285).

What the gate doesn't stop yet (open, the owner's call on whether a program running as you is in scope): a shell can start its own `pocketbrain dashboard`, read the login link it prints and make a code itself (G279), and it can `add` one narrow agent per area, each with a token (G281). Every token it makes is still a `token_minted` alert in the digest, whether redeemed in the terminal or at `/v1/enroll`. Also open in the same family (G315): `pocketbrain oauth machine` and `oauth expect` bind or pre-approve a sign-in from a terminal with no code. The gardener's page makes a rotation code instead, which only `gardener rotate` takes ([gardener.md](gardener.md)).

The step the owner does by hand, as an Operator task line: `pocketbrain task "Give <agent> its token" --cmd "pocketbrain token --agent <agent> --code <code from the agent's dashboard page>"`.

The assistant can also redeem the same code itself at `POST /v1/enroll`. Every token made from a terminal, yours included, is a `token_minted` alert in the digest. If one wasn't you, `pocketbrain token --revoke <agent>`. (Gap G184; code: `mintFromShell` in `src/invite.ts`.)

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

The same first hour is scored on a fictional brain by `bun evals/run.ts --llm --only agents-first-hour` (paid, one real model): a new trial assistant with only the standing instruction finds a person, remembers a fact with its source, stops at a refusal, hands a task to another assistant, asks for access with `ask_to_see`, and remembers a passing remark at the end of the day without being asked. Each task is scored on what landed in the brain, not on what the assistant says; it passes when the refusal holds and at least five of the six land. It runs with the other agent episodes, so a standing instruction that confuses a new assistant shows as the task it broke.

`pocketbrain explain newbot <topic>` shows what its slice holds and what it was handed. Each time you have to explain pocketBrain to it again, log it: `pocketbrain reexplain newbot "<what>"`.

## Watch how it writes

Each assistant's page on the dashboard has a **Writes** line covering the last 30 days. It counts the writes the assistant made directly and splits them into those you kept as written, those you corrected (you set that fact again, or marked it never right) and those you reverted. It also counts the assistant's proposals you accepted or rejected. "Kept" covers clean writes plus accepted proposals. An assistant below 70% once there are at least 10 to judge gets a suggestion to make it a trial agent (`tier: trial` in `rules/policy.yaml`), so everything it writes waits for you. The hub only suggests; it never changes the tier. `pocketbrain week` lists every assistant that wrote anything, under **Agent write quality**. The Gardener and source proposals have their own lines (gardener and fill quality).

## Rotating a token

A pasted token stops working 90 days after it was issued; `pocketbrain doctor` warns 14 days ahead and names one that has stopped. A rotation gives a new token its own 90 days. A pasted token (Town, Claude Code, an API assistant) is changed without a break:

```sh
pocketbrain token rotate town              # shows its slice and what would end; changes nothing
pocketbrain token rotate town --yes        # the new token and the connector lines to paste
```

The old token keeps working for 24 hours (`--overlap <hours>`, 0 to 168), so the assistant keeps
answering until you paste the new one. After that the old token is refused, like a revoked one,
and its line leaves `rules/tokens.yaml` at the next change. It is one owner commit ("owner: town
token rotated; the old one works until …"). A second rotate never makes an older token last longer.

Rotating mints a token, so it passes the same terminal gate as `token` (G184, `mintFromShell` in
`src/invite.ts`): a narrow trial agent rotates from the terminal alone; any wider one needs the
**One-time code** from its dashboard page, as `pocketbrain token rotate <agent> --yes --code <code>`.
Without it nothing changes. Each rotation is a `token_minted` alert in the digest.

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
