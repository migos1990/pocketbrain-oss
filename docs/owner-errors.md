# Errors you can hit, and their fix

Every error page and command-line failure the owner can meet, written by `src/owner-errors.ts`. `{name}` is filled in when it shows. `test/owner-errors.test.ts` fails when this file and the code differ; rewrite it with `PB_ERRORS_UPDATE=1 bun test test/owner-errors.test.ts`.

## Dashboard pages

| Id | What you see |
|---|---|
| `dash.host` (421) | This dashboard only answers on this computer's own address (127.0.0.1 or localhost). Fix: run pocketbrain menubar open-dashboard. |
| `dash.login-key` (403) | That login link is old or cut short: the dashboard makes a new one each time it starts. Fix: run pocketbrain menubar open-dashboard. |
| `dash.sign-in-again` (403) | This page can show private values, so it opens only within 10 minutes of signing in. Fix: click "Sign in again" on this page in the dashboard, and open the new link. |
| `dash.phone-link-used` (403) | This sign-in link was already used, or it's more than a day old. Fix: click "Text me a sign-in link" on this page in the dashboard, and open the new link. |
| `dash.signed-out` (401) | You're not signed in here: a sign-in lasts 30 days, on this browser only. Fix: run pocketbrain menubar open-dashboard. |
| `dash.link-cap` (429) | Three sign-in links were sent to your phone in the last hour. Fix: use the newest one, or on the Mac, then run pocketbrain dashboard phone-link. |
| `dash.link-no-channel` (409) | No text channel can send a sign-in link ({reason}). Fix: on the Mac, then run pocketbrain dashboard phone-link. |
| `dash.link-relayed` (409) | Your text channel goes through an assistant, so a sign-in link never travels on it. Fix: on the Mac, then run pocketbrain dashboard phone-link. |
| `dash.link-busy` (409) | Another sign-in link was being made or used at that moment. Fix: reload the page, and press the button again. |
| `dash.link-not-sent` (502) | The text with your sign-in link didn't go out ({reason}). Fix: on the Mac, then run pocketbrain dashboard phone-link. |
| `dash.app-not-paired` (401) | This phone isn't paired with your brain any more, or it was removed. Fix: on the Mac, then run pocketbrain dashboard phone-link, and open the link in the pocketBrain app. |
| `dash.app-signed-out` (401) | This phone's 30-day sign-in has ended, and Face ID only makes a live sign-in fresh. Fix: on the Mac, then run pocketbrain dashboard phone-link, and open the link in the pocketBrain app. |
| `dash.app-nonce` (403) | That Face ID sign-in was old or already used, so nothing was done. Fix: reload the page, and try Face ID again. |
| `dash.app-phone-cap` (429) | This phone made a sign-in fresh too many times in the last hour, so Face ID waits. Fix: on the Mac, then run pocketbrain dashboard phone-link. |
| `dash.app-cap` (429) | Too many phone keys this hub didn't know in the last hour, so the app's Face ID sign-in waits an hour. Fix: on the Mac, then run pocketbrain dashboard phone-link. |
| `dash.cross-origin` (403) | Another site's page tried to press a dashboard button, so nothing was done. Fix: run pocketbrain menubar open-dashboard, and press the button there. |
| `dash.bad-form` (400) | That wasn't one of the dashboard's own forms, so nothing was done. Fix: reload the page, and press the button again. |
| `dash.csrf` (403) | This page is from before your latest sign-in, so nothing was done. Fix: reload the page, and press the button again. |
| `dash.no-button` (404) | That button isn't in this version of the dashboard, so nothing was done. Fix: reload the page. |
| `dash.method` (405) | This address only takes the dashboard's own page loads and buttons. Fix: open the dashboard's Home page. |
| `dash.connection-gone` (404) | That connection isn't waiting any more: an assistant's sign-in waits a day, then lapses. Fix: ask the assistant to connect again, then open the dashboard's Assistants page, where it shows up. |
| `dash.cant-add` (400) | Can't add it: {reason}. Fix: open the dashboard's Assistants page. |
| `dash.note` (404) | {reason}. Fix: open the dashboard's Brain page, and search for the note. |
| `dash.no-note` (404) | No note {id} (it may have been forgotten or renamed). Fix: open the dashboard's Brain page, and search for it. |
| `dash.no-day` (404) | The brain has no saved version from {day}. Fix: open the dashboard's Brain page, and pick a day from a note's history. |
| `dash.no-version` (404) | The note has no saved version from then. Fix: open the dashboard's Brain page, and pick a save from the note's history. |
| `dash.consent-gone` (404) | That proposal is gone: proposals are kept until the dashboard restarts. Fix: type the sentence again, then click "Propose" on the assistant's page in the dashboard. |
| `dash.proposal-gone` (404) | That proposal is gone: proposals are kept until the dashboard restarts. Fix: open the dashboard's Brain page, and ask for the change again. |
| `dash.no-agent` (404) | No assistant called {name}. Fix: open the dashboard's Assistants page. |
| `dash.not-found` (404) | There's no page at this address. Fix: open the dashboard's Home page. |
| `dash.tailnet-owner-only` (403) | This dashboard only answers its owner, on their own tailnet (never through a funnel or the public door). Fix: open it from one of your devices signed in to your Tailscale account, then read docs/dashboard-tailnet.md. |
| `dash.tailnet-device` (403) | This device isn't one of the devices you listed for the dashboard on your tailnet. Fix: run pocketbrain dashboard tailnet on --device <its Tailscale address>, on the hub machine, then restart the hub. |
| `dash.internal` (500) | Something broke inside the dashboard; the details are in the hub's log. Fix: reload the page, and if it happens again, run pocketbrain doctor. |

## Command line

| Id | What you see |
|---|---|
| `cli.no-brain` | No brain here: {dir} has no rules/policy.yaml, and no brain is remembered. Fix: run pocketbrain init, or point at yours with --brain <folder>. |
| `cli.unknown` | There's no command {cmd}. Fix: run pocketbrain help. |
| `cli.crash` | pocketbrain {cmd} stopped on an error it didn't expect: {message}. Fix: run pocketbrain doctor, and run the command again with PB_DEBUG=1 for the full trace if it finds nothing. |

## Consent ("What is it for?" and pocketbrain consent)

| Id | What you see |
|---|---|
| `consent.no-slice` (400) | The proposal picked no slice. Fix: say more about what the assistant does, then click "Propose" on the assistant's page in the dashboard. |
| `consent.all` (400) | The proposal asked for everything, and the whole brain is never granted from a sentence. Fix: name the part of your life it handles, then click "Propose" on the assistant's page in the dashboard. |
| `consent.unknown-slice` (400) | The proposal named slice(s) the brain doesn't have: {names}. Fix: say it with the names of your areas, then click "Propose" on the assistant's page in the dashboard. |
| `consent.unknown-kind` (400) | The proposal named kind(s) the brain doesn't have: {names}. Fix: say it with the kinds of notes your brain has, then click "Propose" on the assistant's page in the dashboard. |
| `consent.not-proposal` (400) | The model's answer wasn't a proposal. Fix: click "Propose" on the assistant's page in the dashboard, once more. |
| `consent.empty` (400) | There's no sentence to read. Fix: say in one sentence what the assistant is for, then click "Propose" on the assistant's page in the dashboard. |
| `consent.too-long` (400) | That's more than one sentence (300 characters at most). Fix: shorten it, then click "Propose" on the assistant's page in the dashboard. |
| `consent.bad-name` (400) | {agent} can't be an assistant's name: 2 to 31 lowercase letters, digits and dashes, starting with a letter. Fix: run pocketbrain consent my-assistant "what it is for", with a name like that. |
| `consent.reserved-name` (400) | {agent} is the hub's own name. Fix: run pocketbrain consent my-assistant "what it is for", with another name. |
| `consent.inside` (400) | {agent} keeps the brain in order and sees it all by design; its slice isn't set from a sentence. Fix: read docs/gardener.md. |
| `consent.not-in-policy` (400) | {agent} isn't in policy.yaml yet. Fix: run pocketbrain add {agent} --slices <a,b>. |
| `consent.widens` (403) | This shows {agent} more than it sees today ({more}); showing more needs your login. Fix: type the same sentence under "What is it for?", then click "Propose" on {agent}'s page in the dashboard, and then "Apply". |

## pocketbrain doctor

| Id | What you see |
|---|---|
| `doctor.git-lock` | .git/index.lock is {minutes} min old, left by a git command that was killed; nothing can commit until it's gone. Fix: run pocketbrain doctor --fix --yes. |
| `doctor.act` | {problem}; no actions until it is fixed in rules/policy.yaml. Fix: read docs/act.md. |
| `doctor.hub-unnamed` | This clone has no replica name, so it can't commit (the hub is {hub}). Fix: run pocketbrain hub init --name <machine>. |
| `doctor.no-keygen` | ssh-keygen isn't installed, so commits can't be signed or verified. Fix: run sudo apt install openssh-client. |
| `doctor.signing-optional` | rules/hub.yaml doesn't require signed commits, so a promoted hub can't tell forged history from real. Fix: read docs/hub.md, and set require_signed: true in rules/hub.yaml. |
| `doctor.not-signing` | {me} doesn't sign commits. Fix: run pocketbrain hub init --name {me} --key <private key>. |
| `doctor.key-missing` | Signing key {key} is missing. Fix: run pocketbrain hub init --name {me} --key <private key>, with a key that exists. |
| `doctor.key-unlisted` | {me}'s key isn't in rules/hub.yaml. Fix: run pocketbrain hub add-replica {me} --pub "<public key>", on the hub. |
| `doctor.history` | {n} commit(s) don't check out: {problems}. Fix: read docs/hub.md, and don't promote this clone until they do. |
| `doctor.write-log` | log/writes.jsonl chain broken: {problems}. Fix: read docs/backup.md, and restore the last good backup if the lines were changed by hand. |
| `doctor.inbound` | Inbound from {names} not ingested yet (the server does it every {minutes} min). Fix: run pocketbrain hub sync. |
| `doctor.ops-waiting` | {n} op(s) not applied yet: {list}. Fix: run pocketbrain hub sync. |
| `doctor.ops-queued` | {n} write(s) queued for {hub}, oldest {age}h ago. Fix: run pocketbrain hub sync. |
| `doctor.hub-alerts` | {n} hub alert(s) this week, latest: {check}: {from}. Fix: open the dashboard's Settings page, and read Still open. |
| `doctor.replica-no-git` | {name} has no git address in rules/hub.yaml, so nobody can sync with it. Fix: read docs/hub.md, and add its git: line in rules/hub.yaml. |
| `doctor.replica-down` | {name} unreachable at {git}. Fix: check that {name} is on and online, then run pocketbrain hub sync. |
| `doctor.hub-down` | The hub {name} is unreachable at {git}; agents fall back to their snapshots and writes here queue. Fix: run pocketbrain hub promote <this machine>, if it stays down. |
| `doctor.behind` | {name} knows epoch {epoch} naming {hub}; this clone is behind. Fix: run pocketbrain hub sync. |
| `doctor.split-brain` | Split brain: {name} says {theirs} is hub at epoch {epoch}, this clone says {hub}. Fix: run pocketbrain hub promote <the machine that should be hub>, on that machine. |
| `doctor.origin-behind` | {n} commit(s) not on origin yet. Fix: run git push origin main, in the brain folder. |
| `doctor.backup-none` | No rules/backup.yaml: nothing leaves this machine encrypted. Fix: run pocketbrain backup --init. |
| `doctor.backup-config` | {message}. Fix: read docs/backup.md. |
| `doctor.backup-never` | No backup made yet. Fix: run pocketbrain backup. |
| `doctor.backup-stale` | Last backup {days} days ago and main has moved since: the hub is asleep or the job is broken. Fix: run pocketbrain backup. |
| `doctor.backup-gone` | {file} isn't in {dest} any more (deleted, or the sync moved it). Fix: run pocketbrain backup. |
| `doctor.setup-door` | No public door in rules/hub.yaml. Fix: run pocketbrain hub url https://brain.<your domain>, once a named Cloudflare tunnel answers there (docs/hub.md). |
| `doctor.setup-gardener` | The gardener's Anthropic side isn't recorded. Fix: run pocketbrain tend --managed, then run pocketbrain gardener setup --profile pocketbrain --lock ~/pocketbrain-agents/claude-lock.json. |
| `doctor.setup-vault` | {n} deployment file(s) still say YOUR_VAULT_ID. Fix: run pocketbrain gardener setup --vault <vault id>. |
| `doctor.setup-fga` | rules/fga.yaml has no model_id. Fix: run pocketbrain fga model, which writes the model and saves its id. |
| `doctor.server-down` | Nothing answers on 127.0.0.1:{port}. Fix: run pocketbrain menubar restart, or pocketbrain start on a machine without launchd. |
| `doctor.door-funnel` | {host} is a Tailscale Funnel address: fine as a stopgap, but it changes with the machine. Fix: run pocketbrain hub url https://brain.<your domain>, once a named Cloudflare tunnel answers there (docs/hub.md). |
| `doctor.door-quick` | {host} is a quick tunnel: a new address on every restart breaks every agent's config. Fix: run pocketbrain hub url https://brain.<your domain>, once a named Cloudflare tunnel answers there (docs/hub.md). |
| `doctor.door-vendor` | {host} is a vendor subdomain, so a hub move means changing every agent's config. Fix: run pocketbrain hub url https://brain.<your domain>, once a named Cloudflare tunnel answers there (docs/hub.md). |
| `doctor.door-local` | {host} is this machine only; agents can't reach it. Fix: run pocketbrain hub url https://brain.<your domain>, once a named Cloudflare tunnel answers there (docs/hub.md). |
| `doctor.door-down` | {url}/health doesn't answer{http}. Fix: run launchctl kickstart -k gui/$(id -u)/com.pocketbrain.tunnel, on {hub}. |
| `doctor.door-unset` | No public_url in rules/hub.yaml: agents have no address to hold. Fix: run pocketbrain hub url https://brain.<your domain>, once a named Cloudflare tunnel answers there (docs/hub.md). |
| `doctor.tunnel-dashboard` | {file} routes to the dashboard port {port}. Fix: run pocketbrain hub tunnel-config, and put what it prints in that file. |
| `doctor.tunnel-open` | {file} forwards every path, not only /mcp, /v1, /health and /openapi.json. Fix: run pocketbrain hub tunnel-config, and put what it prints in that file. |
| `doctor.tunnel-old-rule` | {file}'s agent rule is older than this version: it should forward {path}, which includes the browser door's /b. Fix: run pocketbrain hub tunnel-config, put what it prints in that file, then restart the tunnel. |
| `doctor.tunnel-no-404` | {file} doesn't end its ingress with "- service: http_status:404". Fix: run pocketbrain hub tunnel-config, and put what it prints in that file. |
| `doctor.tunnel-missing` | Tunnel config {file} not found on this machine. Fix: run pocketbrain hub tunnel-config, and put what it prints in that file. |
| `doctor.dashboard-exposed` | The dashboard port {port} answers on {addresses}; it must listen on 127.0.0.1 only. Fix: stop whatever forwards port {port} to the network, then run pocketbrain doctor, to check. |
| `doctor.tailnet-tunnel` | A tunnel rule forwards to {service}; the public tunnel must never reach the tailnet dashboard. Fix: run pocketbrain hub tunnel-config, and put what it prints in that file. |
| `doctor.tailnet-no-serve` | Your Tailscale login is set, but nothing serves https on 8443 to the dashboard, so the phone app and https links can't reach it (Serve must also be on for your tailnet). Fix: run tailscale serve --bg --https=8443 http://127.0.0.1:{port}. |
| `doctor.tailnet-funnel` | Tailscale funnel is on for {hosts}, which publishes the dashboard on the internet. Fix: run tailscale funnel --https={port} off. |
| `doctor.tailnet-serve-unread` | Couldn't read tailscale serve status, so a funnel on the dashboard can't be ruled out. Fix: run tailscale serve status, and make sure no funnel points at the dashboard. |
| `doctor.tailnet-login-off` | dashboard_tailnet_login is set but dashboard_tailnet is off, so the tailnet dashboard isn't serving. Fix: remove dashboard_tailnet_login from rules/, or turn it on with pocketbrain dashboard tailnet on --device <your phone's Tailscale address>, then read docs/dashboard-tailnet.md. |
| `doctor.tailnet-no-devices` | dashboard_tailnet is on but dashboard_tailnet_devices lists no device, so no device can open it. Fix: run pocketbrain dashboard tailnet on --device <your phone's Tailscale address>. |
| `doctor.snapshot-none` | {agent} has no snapshot to fall back on. Fix: run pocketbrain build --all, and paste it. |
| `doctor.snapshot-old` | {agent}: snapshot from {day} ({age} days old). Fix: run pocketbrain build --all, and paste it. |
| `doctor.token-old` | {agent}'s {role}token expires in {days} day(s). Fix: run pocketbrain token rotate {agent}{flag} (the old one keeps working for 24 h). |
| `doctor.token-expired` | {agent}'s {role}token expired on {day}, so it is refused. Fix: run pocketbrain token rotate {agent}{flag}, and paste the new token into {agent}. |
| `doctor.gardener-paused` | {agent} is paused{why}. Fix: click "Resume" on the Assistants page in the dashboard. |
| `doctor.gardener-no-token` | {agent} has no token yet. Fix: run pocketbrain gardener rotate. |
| `doctor.gardener-token-old` | {agent}'s token is {age} day(s) old. Fix: run pocketbrain gardener rotate. |
| `doctor.gardener-silent` | Last upkeep_run {at}Z, over {hours}h ago (night: managed; the hub steps in after {hours}h). Fix: read docs/gardener.md, and check the gardener's deployment in your Anthropic console. |
| `doctor.gardener-never` | No upkeep_run yet (night: managed; the hub runs the night itself until it does). Fix: read docs/gardener.md, and check the gardener's deployment in your Anthropic console. |
| `doctor.gardener-no-config` | No rules/gardener.yaml: session cleanup and token rotation never run for the managed gardener. Fix: run pocketbrain gardener setup --profile pocketbrain. |
| `doctor.ant-missing` | The ant CLI isn't installed; cleanup and rotation can't run. Fix: read docs/gardener.md, which says how to install it. |
| `doctor.ant-signed-out` | ant profile {profile} isn't signed in. Fix: run ant auth login --profile {profile}. |
| `doctor.cleanup-off` | Session cleanup is off: ended sessions keep a copy of what the gardener read. Fix: read docs/gardener.md, and set delete_sessions: true in rules/gardener.yaml. |
| `doctor.calls-missing` | In the last day {agents} read the brain with no line in log/calls.jsonl: a door skipped the call log, so refusal stats miss them. Fix: read docs/refusals.md, and tell the builder which door they use. |
| `doctor.cleanup-none` | No session cleanup in the last two days. Fix: run pocketbrain gardener cleanup. |
| `doctor.sources-none` | No sources in rules/sources.yaml, so the Gardener has nothing to check facts against. Fix: read docs/sources-pull.md ("Live Gmail, Calendar and Drive") for the steps. |
| `doctor.sources-consent` | Live sources stay off: {problem}. Fix: read docs/sources-pull.md, and add the consent: line to rules/sources.yaml. |
| `doctor.google-client-missing` | {keys} not in the keys folder, so no Google source can sign in. Fix: read docs/sources-pull.md (step 1, the Google client) and put each value in its own key file. |
| `doctor.source-not-connected` | {name} isn't signed in to Google yet. Fix: run pocketbrain sources connect {name}, on the hub machine. |
| `doctor.source-never-pulled` | {name} hasn't been pulled yet. Fix: run pocketbrain sources pull {name} --dry-run, to see what it would read, then let the hub's schedule pull it. |
| `doctor.source-refused` | {name}'s last pull ({at}Z) was refused: {why}. Fix: read docs/sources-pull.md, and fix what the reason names; the next scheduled pull tries again. |

## Installer (install.sh)

| Id | What you see |
|---|---|
| `install.os` | pocketBrain installs on macOS and Linux only. Fix: run wsl --install, and run this installer again inside WSL. |
| `install.git-mac` | git is missing. Fix: run xcode-select --install, and run this installer again. |
| `install.git` | git is missing. Fix: run sudo apt install git, or your package manager's equivalent, and run this installer again. |
| `install.curl` | curl is missing. Fix: run sudo apt install curl, and run this installer again. |
| `install.bun-download` | Couldn't download Bun (no internet?). Fix: check your connection, then run curl -fsSL https://bun.sh/install \| bash, and run this installer again. |
| `install.bun-failed` | Bun didn't install. Fix: run curl -fsSL https://bun.sh/install \| bash, to see why, and run this installer again. |
| `install.bun-path` | Bun installed but isn't on the PATH. Fix: open a new terminal window, then run bun --version, and if it answers, this installer again. |
| `install.package` | Couldn't install $PKG (no internet, or no such package). Fix: run bun add -g $PKG, to see why. |
| `install.no-run` | pocketbrain installed but doesn't run. Fix: run bun add -g $PKG, to reinstall it. |
| `install.dirty` | $SRC has changes of yours, so it isn't updated. Fix: run git -C $SRC stash, and run this installer again. |
| `install.fetch` | Couldn't fetch pocketBrain from $REPO (no internet?). Fix: check your connection, then run git ls-remote $REPO, to see why, and run this installer again. |
| `install.no-ref` | $REPO has no $REF. Fix: run git -C $SRC tag -l, to see the releases, and pass one as POCKETBRAIN_REF. |
| `install.libraries` | Couldn't install pocketBrain's libraries (no internet?). Fix: run cd $SRC && bun install --production, to see why. |
| `install.no-run-source` | pocketbrain installed but doesn't run. Fix: run bun $SRC/src/cli.ts help, to see why. |
