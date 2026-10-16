# Hub operations

One hub at a time, many full replicas (design record: [portability.md](history/portability.md) section 7). The hub is the only clone that commits brain changes and the only one agents talk to. Every other clone is a replica: it reads everything, and its writes wait as op files until the hub applies them. Any full replica can be promoted to hub with one command.

Without `rules/hub.yaml` none of this applies: the brain is one machine, as before.

## Setup

On the machine that will be the hub (the home box or laptop):

```sh
ssh-keygen -t ed25519 -N "" -f ~/.ssh/pocketbrain_home      # once per machine
pocketbrain hub init --name home --key ~/.ssh/pocketbrain_home \
  --git ssh://home.<tailnet>.ts.net/~/brain --public-url https://brain.example.com
```

This writes `rules/hub.yaml` (hub `home`, epoch 1, its public key) and turns on signing for every commit this clone makes. To set or change the public door later, run `pocketbrain hub url https://brain.example.com` on the hub (https, no path; one owner commit to `rules/hub.yaml`). If you sign with 1Password, pass `--signer op-ssh-sign` and the public key file.

On each other machine, clone the brain over the tailnet, then:

```sh
pocketbrain hub init --name laptop --key ~/.ssh/pocketbrain_laptop --git ssh://laptop.<tailnet>.ts.net/~/brain
```

It prints the `hub add-replica …` line to run on the hub. After that, `pocketbrain hub sync` on the laptop works. Add `--no-hub` for a copy that must never be promoted.

## Day to day

| Where | What happens |
|---|---|
| Hub | Writes commit directly, as before. `pocketbrain serve` also runs a tick every `tick_minutes` (default 5): it takes replicas' ops and applies them, and steps down if another clone holds a newer epoch. |
| Replica | `write` (CLI, capture) returns `queued` and saves `ops/<replica>/<ulid>.json`, committed and signed by this machine. Any other commit is refused with a message naming the hub. `serve` refuses to start. |
| Replica, `hub sync` | Fetches the hub's `main`, verifies every new commit's signature, moves to it, and pushes this clone's unapplied ops to `inbound/<replica>` on the hub. |
| Hub, `hub sync` | Ingests each `inbound/<replica>` branch, then replays: each op goes through `write()` and moves to `ops/applied/<YYYY-MM>/` with its outcome. |

Ops in one batch apply oldest `as_of` first, so a batch lands the same whatever order it was queued in. Replaying an op twice is a no-op. An older value that reaches the hub after a newer one went live is a conflict, settled or disputed by `write()` like any other.

## What the hub refuses

- An inbound commit not signed by that replica's key in `rules/hub.yaml`.
- An inbound commit that does anything but add files under `ops/<replica>/`.
- An op for an agent the replica may not write as (`may_write_as` in `rules/hub.yaml`).

Each refusal is an alert in `log/alerts.jsonl` and shows in `pocketbrain doctor`.

## Request budget

Each agent has a budget on every door (MCP, the API and the browser door): 120 requests a minute and 300 writes an hour by default. A write is a POST on the API, a writing MCP tool (remember, retire, capture, log_session, hand_off, handoff_done, memory_check_reply, ask_to_see and the gardener's runs), or a form post on the browser door. A write is counted when it arrives (so parallel writes can't all slip under the cap) and given back when it fails: a 404, a refused form or a bad request on the API or browser door spends nothing; on MCP a writing tool call counts even when the write is refused. Past either, the agent gets a 429 with `Retry-After` and "too many requests (or writes) from you; try again in N s"; on MCP it's a tool error with the same words. Reads keep working while writes wait, and other agents are untouched. Each token role counts on its own, so a reader token can't use up the same agent's resolver token, and an agent holding two tokens with different roles has two budgets. The resolver token (your own answers and texts) gets ten times the room. You get one alert per agent a day (`request_budget` in `log/alerts.jsonl`, on the dashboard; it is not texted and is not a leak); a loop or a routine retrying is the usual cause. Two coworkers signed in as the same agent share its budget.

Change it for everyone or for one agent in `rules/policy.yaml`:

```yaml
budget: { requests_per_minute: 120, writes_per_hour: 300 }
agents:
  town: { ..., budget: { writes_per_hour: 600 } }
```

`0` means none (`writes_per_hour: 0` makes an agent read-only on every door); a value that isn't a number keeps the default, and anything over 100000 counts as 100000. Counts are kept in memory, so restarting the hub starts them over.

Each assistant's page on the dashboard shows its budget live: requests in the last minute and writes in the last hour against its caps, one line per token role (the resolver key with its tenfold room), in red from 80% of a cap. A loop shows there before it hits the 429. The counts are the hub's: with `pocketbrain start` the dashboard runs in the same process and sees them; a dashboard started on its own (`pocketbrain dashboard`) says "counted by the hub" instead of showing zeros.

## Moving the hub

When the hub is down for good, or to move it on purpose, run this on the clone that should take over:

```sh
pocketbrain hub promote laptop
```

1. It fetches whatever is reachable and verifies every commit since the last check. Each commit must be signed by a key listed in the `hub.yaml` in force before it. Only the hub may change notes; a replica may only add its own ops, or promote itself by raising the epoch by exactly one. It also checks the hash chain of `log/writes.jsonl`. If anything fails it stops (`--force` overrides: your call).
2. It commits `rules/hub.yaml` naming the new hub with `epoch + 1`, signed.
3. It applies every queued op, including the ones this clone queued while it was a replica.
4. It prints your part: the DNS or tunnel change, starting the server, and the GitHub deploy key.

The old hub stops committing as soon as it learns of the new epoch, at its next `hub sync` or server tick. It learns from any replica listed in `hub.yaml`, not only the new hub. Anything it committed after it was replaced is kept on an `orphaned/<date>-<sha>` branch for you to look at; it never reaches `main`. A clone never follows a copy with a lower epoch.

## The public door

`pocketbrain hub tunnel-config` prints a cloudflared ingress that forwards only `/mcp` (including `/mcp/oauth`), `/v1`, the browser door `/b`, `/health`, `/openapi.json` and the OAuth door's metadata (`/.well-known/oauth-protected-resource/mcp/oauth`, see [oauth.md](oauth.md)) to the agent server, and returns 404 for everything else. The dashboard is never forwarded. `pocketbrain doctor` warns when the config on the machine forwards an older set of paths (for example without `/b`), and names this command.

## A fixed address on your domain

A `trycloudflare.com` address ([quickstart](quickstart.md)) changes on every restart, and OAuth assistants need one that doesn't. With a free Cloudflare account and your domain's DNS on Cloudflare:

```sh
cloudflared tunnel create pocketbrain                       # once; writes its credentials under ~/.cloudflared/
cloudflared tunnel route dns pocketbrain <brain.your-domain>
pocketbrain hub tunnel-config > ~/.cloudflared/config.yml   # then set hostname: to <brain.your-domain> and credentials-file: to the file create wrote
pocketbrain start --launchd --tunnel pocketbrain --write   # on a Mac: writes the two launchd files; load each with launchctl bootstrap gui/$(id -u) <file>
```

`start --launchd` without `--write` prints the two plists instead of installing them. Set the Mac not to sleep on power. When the hub is off, an agent can use its dated snapshot from `pocketbrain build --all` only if you gave it one ([agent-instructions.md](agent-instructions.md)); nothing switches over by itself.

For a pilot user served under the operator's domain, `pocketbrain door install` writes this config and the door in `hub.yaml` in one step ([pilot-door.md](pilot-door.md)).

## pocketbrain doctor

One screen, read-only, exits 1 if anything needs fixing. `--offline` skips the network checks; `--json` gives machine-readable output (a line with a repair carries its id in `fix`).

| Area | Checks |
|---|---|
| git | a `.git/index.lock` older than a minute, left by a killed git command, which stops every commit |
| hub | this clone's name and role, the hub, the epoch |
| signing | commits are signed, with a key that exists and is listed in `hub.yaml` |
| history | new commits verify against `hub.yaml`; the write log chain is intact |
| ops | what is queued here, inbound branches and ops not yet applied on the hub, hub alerts this week |
| replicas | each one reachable; a peer with a newer epoch, or a split brain at the same epoch |
| backup | commits not yet on `origin` |
| server | the agent server answers on 127.0.0.1 |
| door | the `public_url` (Funnel and vendor subdomains warned, quick tunnels failed) answers `/health`; the cloudflared config never routes to the dashboard |
| dashboard | the dashboard port answers on no address but loopback |
| snapshots | each live agent has a dated snapshot to fall back on, and how old it is |

### pocketbrain doctor --fix

Some lines have a repair that is safe, known and needs no value from you. `pocketbrain doctor --fix` lists each one, with the lines it answers, and changes nothing. `pocketbrain doctor --fix --yes` runs them, prints what each did, then runs doctor again; it exits 1 if a repair failed or a FAIL is left. Running it counts as one hand fix on the real-use bar ([real-use-bar.md](real-use-bar.md)), naming the repairs that ran.

| Repair | For | What it does |
|---|---|---|
| `lock` | a stale `.git/index.lock` | removes it (only when it is over a minute old) |
| `gardener-config` | no `rules/gardener.yaml`, or the gardener's Anthropic side not recorded | writes `ant_profile: pocketbrain`, one owner commit; the lock file stays the default `~/pocketbrain-agents/claude-lock.json` |
| `public-url` | no `public_url` in `rules/hub.yaml`, when the tunnel config names a hostname | `pocketbrain hub url https://<that hostname>` |
| `tunnel` | the cloudflared config forwards every path, routes to the dashboard, forwards an older set of paths (for example without `/b`), or doesn't end in 404 | rewrites only its `ingress:` to the rules `pocketbrain hub tunnel-config` prints, on the door's hostname; the tunnel name, credentials file and comments stay, and the old file is kept as `.bak`. Restart the tunnel after: `launchctl kickstart -k gui/$(id -u)/com.pocketbrain.tunnel` |
| `backup` | no backup yet, or none in over 3 days while main moved | `pocketbrain backup` |

Everything else keeps its written next step, because it needs you: a vault id, an FGA model, a token rotation, a snapshot to paste, a replica that is down.

## Captures, inbox answers and upkeep on a replica

These used to be refused on a replica. They now queue as signed ops too (`op: capture | inbox | upkeep` in the op file), and the hub applies them on sync. See [capture.md](capture.md#on-a-replica-everything-queues-as-a-signed-op). The phone drops files into a synced folder, and the machine that reads it signs the op.

## Not built yet

- Agent logs and relay decisions still commit directly. On a replica they are refused, so run them on the hub.
