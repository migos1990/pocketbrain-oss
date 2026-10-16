# First real connection: Town reads your brain over MCP

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

About 20 minutes on your Mac. At the end, Town answers a question from its slice of the brain and says it can't see your money. For this first test you need no domain, no Cloudflare account and no AgentMail key.

## 1. Install the tools (once)

```sh
xcode-select --install                     # git, if you don't have it
curl -fsSL https://bun.sh/install | bash   # Bun
brew install cloudflared                   # the tunnel
```

## 2. Get the code and your brain

From the project files, download `pocketbrain-handoff/pocketbrain-app.bundle` and `pocketbrain-handoff/pocketbrain-brain.bundle` into `~/Downloads`. Then:

```sh
cd ~
git clone ~/Downloads/pocketbrain-app.bundle pocketbrain
git clone ~/Downloads/pocketbrain-brain.bundle pocketbrain-brain
cd pocketbrain && bun install && bun test     # should say 68 pass, 0 fail
export PB_BRAIN=~/pocketbrain-brain
```

The brain stays on your Mac. Optionally, see the whole story first on a throwaway copy:

```sh
bun run demo --brain ~/pocketbrain-brain
```

## 3. Give Town a key

```sh
bun src/cli.ts token --agent town
```

This prints a token once, starting `pb_town_`. Save it in 1Password as "pocketBrain Town token". The brain keeps only its hash. If it ever leaks, `bun src/cli.ts token --revoke town` cuts Town off at once.

## 4. Start the hub and the tunnel

Use two Terminal tabs, and keep both open while you test.

```sh
# tab 1: the hub (listens on this Mac only)
cd ~/pocketbrain && PB_BRAIN=~/pocketbrain-brain bun src/cli.ts serve
```

```sh
# tab 2: a temporary public address, no account needed
caffeinate -dims cloudflared tunnel --url http://127.0.0.1:8787
```

Tab 2 prints an address like `https://something-random.trycloudflare.com`. That's your hub for this session. It changes each time you restart the tunnel.

## 5. Check it from the outside

In a third tab:

```sh
cd ~/pocketbrain && bun run smoke https://something-random.trycloudflare.com pb_town_… "intra exam"
```

You want six `ok` lines. The last one confirms that a money note answers as if it didn't exist.

## 6. Point Town at it

In Town's settings, add a custom MCP server:

- **URL:** `https://something-random.trycloudflare.com/mcp`
- **Header:** `Authorization: Bearer pb_town_…`

Town takes a pasted token, so it needs no OAuth: keep the plain `/mcp` URL. (Muse can only sign in with OAuth; it uses the separate door in [oauth.md](../oauth.md).) If Town has no field for headers, use `https://something-random.trycloudflare.com/mcp/pb_town_…` as the URL instead. That puts the token in the address, so revoke it after testing.

Town should list `orientation` first, then `context_pack`, `search`, `read`, `remember`, `retire` and a few more.

Then tell Town when to use it. In the first live test Town used the brain only when told "use pocketbrain"; what pocketBrain sends on connect wasn't enough. `pocketbrain connect town` prints a short block (also in [agent-instructions.md](../agent-instructions.md)). Paste it once into Town's custom instructions, not into a chat.

## 7. Try a carved query

Ask Town:

1. "What's my next step on the Northfield intra exam?" It should check the brain without being told, give the Dana deadline, cite the email and say "from your brain". If it answers without the brain, the standing instruction isn't in its custom instructions yet.
2. "Use pocketbrain: which bank or investment firm do I use?" It should say money isn't shared with it. The server returns nothing for that, so Town can't find it even if it tries.
3. Optionally: "Remember in pocketbrain that the intra exam was sent to Dana today, source: the Gmail message id." Town owns Northfield, so this is written directly, and `git -C ~/pocketbrain-brain log -1` shows a commit authored by town.

To see what Town read: `tail ~/pocketbrain-brain/log/reads.jsonl`.

## 8. Stop

Press Ctrl-C in both tabs. Then, if you used the token-in-URL form: `bun src/cli.ts token --revoke town`.

## After the test: making it permanent

These need your hands, so they're one decision card in the thread, not steps here:

- **A fixed address on your domain.** This needs a free Cloudflare account and your domain's DNS on Cloudflare. Then run `cloudflared tunnel create pocketbrain` and route `brain.<your domain>` to it. Agent settings then never change when the hub restarts.
- **Keeping the hub running.** Use a launchd job for `serve` and the tunnel, and set the Mac not to sleep on power. When the hub is off, agents fall back to their dated snapshot: `bun src/cli.ts build --all` writes `views/snapshots/<date>/<agent>.md`.
- **Muse, Claude and Instinct.** Each gets its own `token --agent <name>`. Instinct uses the same token on `https://…/v1/…`, and the spec is at `/openapi.json`.
- **Two tokens for Instinct.** Instinct holds the most (all slices, the resolver job, your texts) and its token sits in a vendor's API config, so one leak would be all of it. Split it: `token --agent instinct --role reader` is the token for its ordinary work (its slice below private; no disputes or texts; its citations of your messages wait in your inbox), and `token --agent instinct --role resolver` is the one for its dispute and text routine (`/v1/disputes`, `/v1/owner/`, nothing else). To switch, run `token --revoke instinct` first (it cuts every token the agent has), then issue both: the reader token goes where Instinct reads and writes (also the key in its vault for the browser door), the resolver token only into its scheduled routine. A token issued without `--role` keeps working as before.
- **AgentMail relay.** This needs your real inbox addresses in `rules/relay.yaml` and a key scoped to the relay inbox only. The admin key stays with you.
