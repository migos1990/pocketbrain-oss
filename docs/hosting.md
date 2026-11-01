# Where the brain runs

pocketBrain is one process, `pocketbrain start`, next to a folder of Markdown files under git. Any machine that runs Bun can be its home: a laptop, a desktop, a home server, a rented VPS or a container. This page says what the hub needs from wherever it runs, then gives a few ways to get it. None of them is required.

## What the hub needs

| Need | Why | Without it |
|---|---|---|
| **A process that stays up** while your assistants use the brain | It answers them and runs the nightly tidy pass | Apps on the same computer still work whenever it's awake. A missed nightly pass runs at the next start or wake. |
| **The brain folder and its git history** on a disk you trust | That's the brain | Back it up: `pocketbrain backup --init` |
| **A private keys folder**, `~/.config/pocketbrain/keys/` (moved with `PB_CONFIG_DIR`) | Model and source keys, one file each, never in the brain | Only needed once you add a model or a source |
| **A private agent-keys folder**, `~/.config/pocketbrain/agent-keys/` | The key of each app on this computer, for its bridge ([below](#keys-at-rest)) | Only for apps connected with `--kind` |
| **Loopback only** for the dashboard, port 8788 | It's yours alone; it refuses to answer on anything but 127.0.0.1 | Open it on the same machine, or see [dashboard-tailnet.md](dashboard-tailnet.md) |
| **A fixed public https address** for the agent port, 8787 | Only for assistants in the cloud | Apps on the same computer use `http://127.0.0.1:8787` |

The public address must forward only the agent paths and nothing else. `pocketbrain hub tunnel-config` prints the exact list; today it is `/mcp`, `/mcp/oauth`, `/v1/…`, `/b`, `/health`, `/openapi.json` and `/.well-known/oauth-protected-resource/mcp/oauth`. Anything else should answer 404. Never forward the dashboard's port.

Once the address works, record it so `connect` and `add` print it: `pocketbrain hub url https://<your address>`, then `pocketbrain doctor` checks it from outside.

## Keys at rest

pocketBrain keeps only a hash of each assistant's key in the brain (`rules/tokens.yaml`), with one exception. An app on this computer connected with `pocketbrain add <app> --kind <app>` gets its key saved in `~/.config/pocketbrain/agent-keys/<app>`, so the app's own config holds only the command `pocketbrain mcp --agent <app>` and never the key. That file is a real key, stored in plain text:

- the folder is created readable by you alone (0700) and the file too (0600). The bridge refuses a file anyone else can read;
- any program running as you can read it, the same as a key pasted into the app's config. Don't sync or back up `~/.config/pocketbrain/agent-keys/` to a shared place;
- the bridge sends it only to the hub on this computer (`127.0.0.1`, `::1` or `localhost`), and refuses any other address, so editing an app's config can't send the key elsewhere;
- `pocketbrain token --revoke <app>`, or **Revoke** on the dashboard, cuts the app off and deletes the file. `pocketbrain uninstall --yes` removes the whole folder.

## A laptop that sleeps

The simplest setup, and a fine one. Run `pocketbrain start` when you work, and connect the apps on that laptop ([connect.md](connect.md)). Everything waits while the lid is closed. The only thing you give up is cloud assistants, which can't reach a sleeping laptop.

To start it without a terminal window open:

- **Mac:** `pocketbrain start --launchd --write` writes the launchd files; load them as [hub.md](hub.md#a-fixed-address-on-your-domain) shows. The menu-bar app can install them too ([menubar.md](menubar.md)).
- **Linux, or WSL:** a systemd user unit. Save this as `~/.config/systemd/user/pocketbrain.service`, with the path `which pocketbrain` printed:

  ```ini
  [Unit]
  Description=pocketBrain hub

  [Service]
  ExecStart=/home/you/.bun/bin/pocketbrain start
  Restart=on-failure

  [Install]
  WantedBy=default.target
  ```

  Then `systemctl --user enable --now pocketbrain`. On WSL, systemd has to be on (`[boot] systemd=true` in `/etc/wsl.conf`).

## Ways to get a public address

Pick the one that fits what you already have. Each one ends at `http://127.0.0.1:8787` on the hub's machine.

- **Cloudflare quick tunnel**, to try a cloud assistant that takes a header: `cloudflared tunnel --url http://127.0.0.1:8787`. No account needed, but the address changes on every restart, so it can't carry a sign-in ([quickstart.md](quickstart.md#connect-an-assistant-in-the-cloud)).
- **Cloudflare named tunnel** on a domain whose DNS is on Cloudflare: a fixed address, and `pocketbrain hub tunnel-config` writes its config ([hub.md](hub.md#a-fixed-address-on-your-domain)).
- **Tailscale Funnel**: a fixed `https://<machine>.<tailnet>.ts.net` address without a domain. Point it at port 8787 only, never at the dashboard. `pocketbrain doctor` warns about it because the address follows the machine's name.
- **A reverse proxy you already run** (Caddy, nginx, Traefik) on a VPS or home server, with its own https certificate. Forward only the paths listed above to `127.0.0.1:8787`.
- **A container:** run `pocketbrain start --host 0.0.0.0` inside it so the agent port can leave the container, and publish it to the host's loopback only (`docker run -p 127.0.0.1:8787:8787 …`). A plain `-p 8787:8787` puts the port that takes assistants' keys on your whole network. Your reverse proxy or tunnel on the host then forwards to `127.0.0.1:8787`. The dashboard stays on the container's own loopback. Keep the brain folder and the keys folder on volumes. No image is published yet.

The author's own setup (a Mac mini at home, launchd, a Cloudflare named tunnel and Tailscale for the dashboard on the phone) is one example of the list above, not a requirement.
