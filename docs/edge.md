# The sealed edge

Status: a working proof, run locally. Nothing is deployed, and no Cloudflare setting is changed by it. Whether pocketBrain ever serves from somewhere other than your own machine is the owner's decision, so this stays off unless you run it.

## What it is for

When the hub is asleep (the Mac is off, or traveling), assistants get nothing. The sealed edge keeps each assistant's slice somewhere that's always on, sealed so the place that stores it can't read it. While the hub sleeps, the edge answers reads from that slice and holds writes for the hub. When the hub wakes, it runs the held writes through the normal write path.

## How the keys work

- `pocketbrain edge enroll <agent> [--role reader]` issues a new token for the agent (shown once); `--role reader` makes it a reader token: it can decrypt only a cell carved below private (see the next point). The hub keeps the token's hash in `rules/tokens.yaml`, as for any token. It also keeps a wrap key derived from the token (HKDF-SHA256) in `~/.config/pocketbrain/edge/home.json` (mode 600, never in the brain or git). The token itself is never stored.
- `pocketbrain edge publish --out <dir>` builds each enrolled agent's cell (the same scrubbed slice as `src/cell.ts`) and seals it with AES-256-GCM under a fresh random key. It then wraps that key once per live enrolled plain token. If the agent has a live enrolled reader token, publish also builds a second cell carved under the reader role (nothing above personal: no private note, and private facts and their values scrubbed from the notes it keeps), seals it under its own key, and wraps that key for the reader tokens only (G249). A reader token's holder who decrypts the bundle with their own client gets that capped cell and nothing else; the reader cap is in the cryptography, not only in the edge's software. Each publish uses new keys, but a bundle already on the edge keeps the keys it was sealed with: making a published plain token a reader doesn't take back the full cell it can already open there, so revoke it and enroll a new reader token instead. Bundles are format v2; a v1 bundle opens nothing, so publish again after upgrading.
- The edge holds only ciphertext and wraps. Each wrap is named by a hash of its wrap key, never by the token hash in `rules/tokens.yaml`. The edge can open an agent's cell only while a request carrying one of that agent's live tokens is in hand.
- A write at the edge (`remember`, `retire`, `capture`) is signed with an HMAC under a key derived from the token's wrap key, sealed to the hub's X25519 public key and queued. The edge can't read it either, and whoever stores the bundles and the queue can't forge one: without a live token there is no signing key.
- `pocketbrain edge replay --from <dir>` (on the hub) opens each queued write, checks its signature against the wrap key in the hub's home state, and checks its token hash against `rules/tokens.yaml` as it is now. An unsigned or forged write gets `refused` ("not signed"), and so does a write queued before signing existed. Each signed write runs once: the hub keeps a hash of each one it replayed in `log/edge-replayed.jsonl`, so a copy put back in the queue is refused. It then runs the write under that token's role, as the live server runs each request, through the same core functions: every check, the leak tripwire and the conflict steps. A reader token's write stays a reader's: an owner message id it cites waits for the owner, and a retire of a private fact it can't see is refused (G202). The role is the one in `rules/tokens.yaml` at replay, not at queueing: a token revoked in the meantime gets `refused`, a token you made a reader replays as a reader, and one you made role-less replays as role-less (your own later choice, as a live request would get). A write from an agent with hours is refused, and you get an alert (`gardener_hours`), as the live tripwire raises.

## What a publish leaves out

- **Paused agents.** No bundle, so the edge answers 401.
- **Agents with hours** (`windows`, or the gardener). Their hours and the out-of-hours tripwire are checked by the live hub only, so they get no bundle, and replay refuses any write they queued.
- **Agents with no live enrolled token.** A revoked token loses its wrap, and its bundle is removed.
- **Agents inside the wall, or no longer in `policy.yaml`.** No bundle.
- **Resolver tokens.** Only plain and reader tokens are wrapped: the resolver's routes need the hub. A reader token gets the reader-capped cell only.

## Trying it

```sh
pocketbrain edge enroll planner              # prints the new token once
pocketbrain edge publish --out /tmp/edge
pocketbrain edge serve --from /tmp/edge      # a stand-in edge on 127.0.0.1:8789: same /mcp and /v1 as the hub
pocketbrain edge replay --from /tmp/edge     # back on the hub: run what was queued
```

At the edge, only these work:

- **Reads:** `orientation`, `whats_new`, `context_pack`, `search`, `who_is` and `read`.
- **Writes:** `remember`, `retire` and `capture`, which are queued for the hub.

Anything else (`why` included: the edge has no write log) answers that it needs the hub.

## Limits

- The edge decrypts a cell in memory, per request, to answer. Code running on the edge while a request is in flight sees that one agent's slice. At rest, it sees nothing.
- A pause or revoke reaches the edge only at the next publish.
- Reads answered at the edge aren't in the hub's read log, and `remember` replays skip the after-write model check that the live server runs.
- Who routes an assistant to the edge when the hub sleeps (a Worker in front of the tunnel) isn't built. That is a Cloudflare change, which is the owner's to make.
