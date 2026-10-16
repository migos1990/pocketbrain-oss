# A door per pilot user

Each pilot runs their brain on their own machine. Their cloud assistants still need one fixed
public address. In the pilot, the operator gives each person a hostname under the operator's own
Cloudflare zone, served by a named tunnel that runs on the pilot's machine. Both halves go through
the `cloudflared` CLI. pocketBrain stores no Cloudflare key and calls no Cloudflare API itself.

## Operator: make the pilot's tunnel

Once, on the operator's machine: `brew install cloudflared`, then `cloudflared tunnel login` and
pick the zone. Then, for each pilot:

```sh
pocketbrain pilot door sam --zone brains.example
```

- It creates a named tunnel `pb-sam` and writes its credentials to `~/.cloudflared/pb-sam.json`
  (or `--out`), readable only by you.
- It routes `sam.brains.example` to that tunnel.
- If the file already exists, it stops: the tunnel was made before. If the DNS route fails, it
  says so and prints the command that finishes it.

Send the credentials file to the pilot through a password manager share, never by chat or email:
anyone holding it can run their door. The secret inside it is never printed.

## Pilot: install it

In the pilot's brain folder:

```sh
pocketbrain door install pb-sam.json --hostname sam.brains.example --name sam-mac
```

- The credentials go to `~/.cloudflared/<tunnel id>.json`, readable only by the pilot.
- `~/.cloudflared/config.yml` gets the same ingress as `pocketbrain hub tunnel-config`: only the
  agent API goes out, everything else is a 404, and the dashboard never goes out. A config that
  pocketBrain didn't write is kept unless you add `--force`.
- `rules/hub.yaml` gets `public_url: https://sam.brains.example` and the tunnel, as an owner
  commit. A brain with no `hub.yaml` yet becomes a hub named by `--name`. On a brain that is
  already a hub, only the door changes.

Then `pocketbrain start --launchd --tunnel <tunnel id> --write` writes the launchd files for the
server and the tunnel, and `pocketbrain doctor` checks that the door answers and forwards only
the agent API. Agents connect with `pocketbrain connect <agent> --url https://sam.brains.example`,
and a gardener on Managed Agents uses the same door ([gardener.md](gardener.md)).

## Taking a door back

On the operator's machine: `cloudflared tunnel delete pb-sam` and remove the DNS record. The
pilot's brain keeps working on their machine. Their agents lose the address until they get a new
door, or until they set up their own on their own domain ([hub.md](hub.md), "The public door").
