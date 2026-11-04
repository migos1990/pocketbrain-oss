// SPDX-License-Identifier: AGPL-3.0-only
// Every error the owner can hit, in one place: dashboard error pages, CLI failures, doctor
// findings, failed consent and the installer. Each says what happened and the one command or
// click that fixes it; a fix is data (run, click, go, reload, read), so a test can check that the
// command exists, the page exists and the doc exists. docs/owner-errors.md is this catalog
// rendered, and test/owner-errors.test.ts fails when they differ (PB_ERRORS_UPDATE=1 rewrites it).
// Agent-facing refusals are a different voice and live elsewhere (backlog row 254).

// first: a step before the fix ("say more about what it does"); then: what follows it.
type Steps = { first?: string; then?: string };
export type Fix = Steps & (
  | { run: string }                    // a command to type
  | { click: string; on: string }      // a button on a dashboard page
  | { go: string; path: string }       // a dashboard page, by its tab name
  | { reload: true }                   // the page the owner is on
  | { read: string }                   // a doc in this repo
);
export type Where = "dashboard" | "cli" | "doctor" | "consent" | "install";
export interface OwnerError { where: Where; status?: number; what: string; fix: Fix }

const RESTART = "pocketbrain menubar restart";
const SIGN_IN = { run: "pocketbrain menubar open-dashboard" } as const;
const DOOR = { run: "pocketbrain hub url https://brain.<your domain>", then: "once a named Cloudflare tunnel answers there (docs/hub.md)" } as const;
const PHONE_LINK = { run: "pocketbrain dashboard phone-link", first: "on the Mac" } as const;
const TUNNEL = { run: "pocketbrain hub tunnel-config", then: "and put what it prints in that file" } as const;

export const OWNER_ERRORS = {
  // ---- dashboard (src/dashboard/server.ts) ----
  "dash.host": { where: "dashboard", status: 421, what: "This dashboard only answers on this computer's own address (127.0.0.1 or localhost)", fix: SIGN_IN },
  "dash.login-key": { where: "dashboard", status: 403, what: "That login link is old or cut short: the dashboard makes a new one each time it starts", fix: SIGN_IN },
  "dash.sign-in-again": { where: "dashboard", status: 403, what: "This page can show private values, so it opens only within 10 minutes of signing in", fix: { click: "Sign in again", on: "this page", then: "and open the new link" } },
  "dash.phone-link-used": { where: "dashboard", status: 403, what: "This sign-in link was already used, or it's more than a day old", fix: { click: "Text me a sign-in link", on: "this page", then: "and open the new link" } },
  "dash.signed-out": { where: "dashboard", status: 401, what: "You're not signed in here: a sign-in lasts 30 days, on this browser only", fix: SIGN_IN },
  "dash.link-cap": { where: "dashboard", status: 429, what: "Three sign-in links were sent to your phone in the last hour", fix: { ...PHONE_LINK, first: "use the newest one, or on the Mac" } },
  "dash.link-no-channel": { where: "dashboard", status: 409, what: "No text channel can send a sign-in link ({reason})", fix: PHONE_LINK },
  "dash.link-relayed": { where: "dashboard", status: 409, what: "Your text channel goes through an assistant, so a sign-in link never travels on it", fix: PHONE_LINK },
  "dash.link-busy": { where: "dashboard", status: 409, what: "Another sign-in link was being made or used at that moment", fix: { reload: true, then: "and press the button again" } },
  "dash.link-not-sent": { where: "dashboard", status: 502, what: "The text with your sign-in link didn't go out ({reason})", fix: PHONE_LINK },
  "dash.app-not-paired": { where: "dashboard", status: 401, what: "This phone isn't paired with your brain any more, or it was removed", fix: { ...PHONE_LINK, then: "and open the link in the pocketBrain app" } },
  "dash.app-signed-out": { where: "dashboard", status: 401, what: "This phone's 30-day sign-in has ended, and Face ID only makes a live sign-in fresh", fix: { ...PHONE_LINK, then: "and open the link in the pocketBrain app" } },
  "dash.app-nonce": { where: "dashboard", status: 403, what: "That Face ID sign-in was old or already used, so nothing was done", fix: { reload: true, then: "and try Face ID again" } },
  "dash.app-phone-cap": { where: "dashboard", status: 429, what: "This phone made a sign-in fresh too many times in the last hour, so Face ID waits", fix: PHONE_LINK },
  "dash.app-cap": { where: "dashboard", status: 429, what: "Too many phone keys this hub didn't know in the last hour, so the app's Face ID sign-in waits an hour", fix: PHONE_LINK },
  "dash.cross-origin": { where: "dashboard", status: 403, what: "Another site's page tried to press a dashboard button, so nothing was done", fix: { ...SIGN_IN, then: "and press the button there" } },
  "dash.bad-form": { where: "dashboard", status: 400, what: "That wasn't one of the dashboard's own forms, so nothing was done", fix: { reload: true, then: "and press the button again" } },
  "dash.csrf": { where: "dashboard", status: 403, what: "This page is from before your latest sign-in, so nothing was done", fix: { reload: true, then: "and press the button again" } },
  "dash.no-button": { where: "dashboard", status: 404, what: "That button isn't in this version of the dashboard, so nothing was done", fix: { reload: true } },
  "dash.method": { where: "dashboard", status: 405, what: "This address only takes the dashboard's own page loads and buttons", fix: { go: "Home", path: "/" } },
  "dash.connection-gone": { where: "dashboard", status: 404, what: "That connection isn't waiting any more: an assistant's sign-in waits a day, then lapses", fix: { first: "ask the assistant to connect again", go: "Assistants", path: "/agents", then: "where it shows up" } },
  "dash.cant-add": { where: "dashboard", status: 400, what: "Can't add it: {reason}", fix: { go: "Assistants", path: "/agents" } },
  "dash.note": { where: "dashboard", status: 404, what: "{reason}", fix: { go: "Brain", path: "/brain", then: "and search for the note" } },
  "dash.no-note": { where: "dashboard", status: 404, what: "No note {id} (it may have been forgotten or renamed)", fix: { go: "Brain", path: "/brain", then: "and search for it" } },
  "dash.no-day": { where: "dashboard", status: 404, what: "The brain has no saved version from {day}", fix: { go: "Brain", path: "/brain", then: "and pick a day from a note's history" } },
  "dash.no-version": { where: "dashboard", status: 404, what: "The note has no saved version from then", fix: { go: "Brain", path: "/brain", then: "and pick a save from the note's history" } },
  "dash.consent-gone": { where: "dashboard", status: 404, what: "That proposal is gone: proposals are kept until the dashboard restarts", fix: { first: "type the sentence again", click: "Propose", on: "the assistant's page" } },
  "dash.proposal-gone": { where: "dashboard", status: 404, what: "That proposal is gone: proposals are kept until the dashboard restarts", fix: { go: "Brain", path: "/brain", then: "and ask for the change again" } },
  "dash.no-agent": { where: "dashboard", status: 404, what: "No assistant called {name}", fix: { go: "Assistants", path: "/agents" } },
  "dash.not-found": { where: "dashboard", status: 404, what: "There's no page at this address", fix: { go: "Home", path: "/" } },
  "dash.tailnet-owner-only": { where: "dashboard", status: 403, what: "This dashboard only answers its owner, on their own tailnet (never through a funnel or the public door)", fix: { first: "open it from one of your devices signed in to your Tailscale account", read: "docs/dashboard-tailnet.md" } },
  "dash.tailnet-device": { where: "dashboard", status: 403, what: "This device isn't one of the devices you listed for the dashboard on your tailnet", fix: { run: "pocketbrain dashboard tailnet on --device <its Tailscale address>", then: "on the hub machine, then restart the hub" } },
  "dash.internal": { where: "dashboard", status: 500, what: "Something broke inside the dashboard; the details are in the hub's log", fix: { reload: true, then: "and if it happens again, run pocketbrain doctor" } },

  // ---- CLI (src/cli.ts) ----
  "cli.no-brain": { where: "cli", what: "No brain here: {dir} has no rules/policy.yaml, and no brain is remembered", fix: { run: "pocketbrain init", then: "or point at yours with --brain <folder>" } },
  "cli.unknown": { where: "cli", what: "There's no command {cmd}", fix: { run: "pocketbrain help" } },
  "cli.crash": { where: "cli", what: "pocketbrain {cmd} stopped on an error it didn't expect: {message}", fix: { run: "pocketbrain doctor", then: "and run the command again with PB_DEBUG=1 for the full trace if it finds nothing" } },

  // ---- failed consent (src/consent.ts; the dashboard's "What is it for?" box and pocketbrain consent) ----
  "consent.no-slice": { where: "consent", status: 400, what: "The proposal picked no slice", fix: { first: "say more about what the assistant does", click: "Propose", on: "the assistant's page" } },
  "consent.all": { where: "consent", status: 400, what: "The proposal asked for everything, and the whole brain is never granted from a sentence", fix: { first: "name the part of your life it handles", click: "Propose", on: "the assistant's page" } },
  "consent.unknown-slice": { where: "consent", status: 400, what: "The proposal named slice(s) the brain doesn't have: {names}", fix: { first: "say it with the names of your areas", click: "Propose", on: "the assistant's page" } },
  "consent.unknown-kind": { where: "consent", status: 400, what: "The proposal named kind(s) the brain doesn't have: {names}", fix: { first: "say it with the kinds of notes your brain has", click: "Propose", on: "the assistant's page" } },
  "consent.not-proposal": { where: "consent", status: 400, what: "The model's answer wasn't a proposal", fix: { click: "Propose", on: "the assistant's page", then: "once more" } },
  "consent.empty": { where: "consent", status: 400, what: "There's no sentence to read", fix: { first: "say in one sentence what the assistant is for", click: "Propose", on: "the assistant's page" } },
  "consent.too-long": { where: "consent", status: 400, what: "That's more than one sentence (300 characters at most)", fix: { first: "shorten it", click: "Propose", on: "the assistant's page" } },
  "consent.bad-name": { where: "consent", status: 400, what: "{agent} can't be an assistant's name: 2 to 31 lowercase letters, digits and dashes, starting with a letter", fix: { run: "pocketbrain consent my-assistant \"what it is for\"", then: "with a name like that" } },
  "consent.reserved-name": { where: "consent", status: 400, what: "{agent} is the hub's own name", fix: { run: "pocketbrain consent my-assistant \"what it is for\"", then: "with another name" } },
  "consent.inside": { where: "consent", status: 400, what: "{agent} keeps the brain in order and sees it all by design; its slice isn't set from a sentence", fix: { read: "docs/gardener.md" } },
  "consent.not-in-policy": { where: "consent", status: 400, what: "{agent} isn't in policy.yaml yet", fix: { run: "pocketbrain add {agent} --slices <a,b>" } },
  "consent.widens": { where: "consent", status: 403, what: "This shows {agent} more than it sees today ({more}); showing more needs your login", fix: { first: "type the same sentence under \"What is it for?\"", click: "Propose", on: "{agent}'s page", then: "and then \"Apply\"" } },

  // ---- pocketbrain doctor (src/doctor.ts, src/backup.ts, src/ownerset.ts) ----
  "doctor.git-lock": { where: "doctor", what: ".git/index.lock is {minutes} min old, left by a git command that was killed; nothing can commit until it's gone", fix: { run: "pocketbrain doctor --fix --yes" } },
  "doctor.act": { where: "doctor", what: "{problem}; no actions until it is fixed in rules/policy.yaml", fix: { read: "docs/act.md" } },
  "doctor.hub-unnamed": { where: "doctor", what: "This clone has no replica name, so it can't commit (the hub is {hub})", fix: { run: "pocketbrain hub init --name <machine>" } },
  "doctor.no-keygen": { where: "doctor", what: "ssh-keygen isn't installed, so commits can't be signed or verified", fix: { run: "sudo apt install openssh-client" } },
  "doctor.signing-optional": { where: "doctor", what: "rules/hub.yaml doesn't require signed commits, so a promoted hub can't tell forged history from real", fix: { read: "docs/hub.md", then: "and set require_signed: true in rules/hub.yaml" } },
  "doctor.not-signing": { where: "doctor", what: "{me} doesn't sign commits", fix: { run: "pocketbrain hub init --name {me} --key <private key>" } },
  "doctor.key-missing": { where: "doctor", what: "Signing key {key} is missing", fix: { run: "pocketbrain hub init --name {me} --key <private key>", then: "with a key that exists" } },
  "doctor.key-unlisted": { where: "doctor", what: "{me}'s key isn't in rules/hub.yaml", fix: { run: "pocketbrain hub add-replica {me} --pub \"<public key>\"", then: "on the hub" } },
  "doctor.history": { where: "doctor", what: "{n} commit(s) don't check out: {problems}", fix: { read: "docs/hub.md", then: "and don't promote this clone until they do" } },
  "doctor.write-log": { where: "doctor", what: "log/writes.jsonl chain broken: {problems}", fix: { read: "docs/backup.md", then: "and restore the last good backup if the lines were changed by hand" } },
  "doctor.inbound": { where: "doctor", what: "Inbound from {names} not ingested yet (the server does it every {minutes} min)", fix: { run: "pocketbrain hub sync" } },
  "doctor.ops-waiting": { where: "doctor", what: "{n} op(s) not applied yet: {list}", fix: { run: "pocketbrain hub sync" } },
  "doctor.ops-queued": { where: "doctor", what: "{n} write(s) queued for {hub}, oldest {age}h ago", fix: { run: "pocketbrain hub sync" } },
  "doctor.hub-alerts": { where: "doctor", what: "{n} hub alert(s) this week, latest: {check}: {from}", fix: { go: "Settings", path: "/overview", then: "and read Still open" } },
  "doctor.replica-no-git": { where: "doctor", what: "{name} has no git address in rules/hub.yaml, so nobody can sync with it", fix: { read: "docs/hub.md", then: "and add its git: line in rules/hub.yaml" } },
  "doctor.replica-down": { where: "doctor", what: "{name} unreachable at {git}", fix: { first: "check that {name} is on and online", run: "pocketbrain hub sync" } },
  "doctor.hub-down": { where: "doctor", what: "The hub {name} is unreachable at {git}; agents fall back to their snapshots and writes here queue", fix: { run: "pocketbrain hub promote <this machine>", then: "if it stays down" } },
  "doctor.behind": { where: "doctor", what: "{name} knows epoch {epoch} naming {hub}; this clone is behind", fix: { run: "pocketbrain hub sync" } },
  "doctor.split-brain": { where: "doctor", what: "Split brain: {name} says {theirs} is hub at epoch {epoch}, this clone says {hub}", fix: { run: "pocketbrain hub promote <the machine that should be hub>", then: "on that machine" } },
  "doctor.origin-behind": { where: "doctor", what: "{n} commit(s) not on origin yet", fix: { run: "git push origin main", then: "in the brain folder" } },
  "doctor.backup-none": { where: "doctor", what: "No rules/backup.yaml: nothing leaves this machine encrypted", fix: { run: "pocketbrain backup --init" } },
  "doctor.backup-config": { where: "doctor", what: "{message}", fix: { read: "docs/backup.md" } },
  "doctor.backup-never": { where: "doctor", what: "No backup made yet", fix: { run: "pocketbrain backup" } },
  "doctor.backup-stale": { where: "doctor", what: "Last backup {days} days ago and main has moved since: the hub is asleep or the job is broken", fix: { run: "pocketbrain backup" } },
  "doctor.backup-gone": { where: "doctor", what: "{file} isn't in {dest} any more (deleted, or the sync moved it)", fix: { run: "pocketbrain backup" } },
  "doctor.setup-door": { where: "doctor", what: "No public door in rules/hub.yaml", fix: DOOR },
  "doctor.setup-gardener": { where: "doctor", what: "The gardener's Anthropic side isn't recorded", fix: { first: "run pocketbrain tend --managed", run: "pocketbrain gardener setup --profile pocketbrain --lock ~/pocketbrain-agents/claude-lock.json" } },
  "doctor.setup-vault": { where: "doctor", what: "{n} deployment file(s) still say YOUR_VAULT_ID", fix: { run: "pocketbrain gardener setup --vault <vault id>" } },
  "doctor.setup-fga": { where: "doctor", what: "rules/fga.yaml has no model_id", fix: { run: "pocketbrain fga model", then: "which writes the model and saves its id" } },
  "doctor.server-down": { where: "doctor", what: "Nothing answers on 127.0.0.1:{port}", fix: { run: RESTART, then: "or pocketbrain start on a machine without launchd" } },
  "doctor.door-funnel": { where: "doctor", what: "{host} is a Tailscale Funnel address: fine as a stopgap, but it changes with the machine", fix: DOOR },
  "doctor.door-quick": { where: "doctor", what: "{host} is a quick tunnel: a new address on every restart breaks every agent's config", fix: DOOR },
  "doctor.door-vendor": { where: "doctor", what: "{host} is a vendor subdomain, so a hub move means changing every agent's config", fix: DOOR },
  "doctor.door-local": { where: "doctor", what: "{host} is this machine only; agents can't reach it", fix: DOOR },
  "doctor.door-down": { where: "doctor", what: "{url}/health doesn't answer{http}", fix: { run: "launchctl kickstart -k gui/$(id -u)/com.pocketbrain.tunnel", then: "on {hub}" } },
  "doctor.door-unset": { where: "doctor", what: "No public_url in rules/hub.yaml: agents have no address to hold", fix: DOOR },
  "doctor.tunnel-dashboard": { where: "doctor", what: "{file} routes to the dashboard port {port}", fix: TUNNEL },
  "doctor.tunnel-open": { where: "doctor", what: "{file} forwards every path, not only /mcp, /v1, /health and /openapi.json", fix: TUNNEL },
  "doctor.tunnel-old-rule": { where: "doctor", what: "{file}'s agent rule is older than this version: it should forward {path}, which includes the browser door's /b", fix: { run: "pocketbrain hub tunnel-config", then: "put what it prints in that file, then restart the tunnel" } },
  "doctor.tunnel-no-404": { where: "doctor", what: "{file} doesn't end its ingress with \"- service: http_status:404\"", fix: TUNNEL },
  "doctor.tunnel-missing": { where: "doctor", what: "Tunnel config {file} not found on this machine", fix: TUNNEL },
  "doctor.dashboard-exposed": { where: "doctor", what: "The dashboard port {port} answers on {addresses}; it must listen on 127.0.0.1 only", fix: { first: "stop whatever forwards port {port} to the network", run: "pocketbrain doctor", then: "to check" } },
  "doctor.tailnet-tunnel": { where: "doctor", what: "A tunnel rule forwards to {service}; the public tunnel must never reach the tailnet dashboard", fix: { ...TUNNEL } },
  "doctor.tailnet-no-serve": { where: "doctor", what: "Your Tailscale login is set, but nothing serves https on 8443 to the dashboard, so the phone app and https links can't reach it (Serve must also be on for your tailnet)", fix: { run: "tailscale serve --bg --https=8443 http://127.0.0.1:{port}" } },
  "doctor.tailnet-funnel": { where: "doctor", what: "Tailscale funnel is on for {hosts}, which publishes the dashboard on the internet", fix: { run: "tailscale funnel --https={port} off" } },
  "doctor.tailnet-serve-unread": { where: "doctor", what: "Couldn't read tailscale serve status, so a funnel on the dashboard can't be ruled out", fix: { run: "tailscale serve status", then: "and make sure no funnel points at the dashboard" } },
  "doctor.tailnet-login-off": { where: "doctor", what: "dashboard_tailnet_login is set but dashboard_tailnet is off, so the tailnet dashboard isn't serving", fix: { first: "remove dashboard_tailnet_login from rules/, or turn it on with pocketbrain dashboard tailnet on --device <your phone's Tailscale address>", read: "docs/dashboard-tailnet.md" } },
  "doctor.tailnet-no-devices": { where: "doctor", what: "dashboard_tailnet is on but dashboard_tailnet_devices lists no device, so no device can open it", fix: { run: "pocketbrain dashboard tailnet on --device <your phone's Tailscale address>" } },
  "doctor.snapshot-none": { where: "doctor", what: "{agent} has no snapshot to fall back on", fix: { run: "pocketbrain build --all", then: "and paste it" } },
  "doctor.snapshot-old": { where: "doctor", what: "{agent}: snapshot from {day} ({age} days old)", fix: { run: "pocketbrain build --all", then: "and paste it" } },
  "doctor.token-old": { where: "doctor", what: "{agent}'s {role}token expires in {days} day(s)", fix: { run: "pocketbrain token rotate {agent}{flag}", then: "(the old one keeps working for 24 h)" } },
  "doctor.token-expired": { where: "doctor", what: "{agent}'s {role}token expired on {day}, so it is refused", fix: { run: "pocketbrain token rotate {agent}{flag}", then: "and paste the new token into {agent}" } },
  "doctor.gardener-paused": { where: "doctor", what: "{agent} is paused{why}", fix: { click: "Resume", on: "the Assistants page" } },
  "doctor.gardener-no-token": { where: "doctor", what: "{agent} has no token yet", fix: { run: "pocketbrain gardener rotate" } },
  "doctor.gardener-token-old": { where: "doctor", what: "{agent}'s token is {age} day(s) old", fix: { run: "pocketbrain gardener rotate" } },
  "doctor.gardener-silent": { where: "doctor", what: "Last upkeep_run {at}Z, over {hours}h ago (night: managed; the hub steps in after {hours}h)", fix: { read: "docs/gardener.md", then: "and check the gardener's deployment in your Anthropic console" } },
  "doctor.gardener-never": { where: "doctor", what: "No upkeep_run yet (night: managed; the hub runs the night itself until it does)", fix: { read: "docs/gardener.md", then: "and check the gardener's deployment in your Anthropic console" } },
  "doctor.gardener-no-config": { where: "doctor", what: "No rules/gardener.yaml: session cleanup and token rotation never run for the managed gardener", fix: { run: "pocketbrain gardener setup --profile pocketbrain" } },
  "doctor.ant-missing": { where: "doctor", what: "The ant CLI isn't installed; cleanup and rotation can't run", fix: { read: "docs/gardener.md", then: "which says how to install it" } },
  "doctor.ant-signed-out": { where: "doctor", what: "ant profile {profile} isn't signed in", fix: { run: "ant auth login --profile {profile}" } },
  "doctor.cleanup-off": { where: "doctor", what: "Session cleanup is off: ended sessions keep a copy of what the gardener read", fix: { read: "docs/gardener.md", then: "and set delete_sessions: true in rules/gardener.yaml" } },
  "doctor.calls-missing": { where: "doctor", what: "In the last day {agents} read the brain with no line in log/calls.jsonl: a door skipped the call log, so refusal stats miss them", fix: { read: "docs/refusals.md", then: "and tell the builder which door they use" } },
  "doctor.cleanup-none": { where: "doctor", what: "No session cleanup in the last two days", fix: { run: "pocketbrain gardener cleanup" } },
  "doctor.sources-none": { where: "doctor", what: "No sources in rules/sources.yaml, so the Gardener has nothing to check facts against", fix: { read: "docs/sources-pull.md", then: "(\"Live Gmail, Calendar and Drive\") for the steps" } },
  "doctor.sources-consent": { where: "doctor", what: "Live sources stay off: {problem}", fix: { read: "docs/sources-pull.md", then: "and add the consent: line to rules/sources.yaml" } },
  "doctor.google-client-missing": { where: "doctor", what: "{keys} not in the keys folder, so no Google source can sign in", fix: { read: "docs/sources-pull.md", then: "(step 1, the Google client) and put each value in its own key file" } },
  "doctor.source-not-connected": { where: "doctor", what: "{name} isn't signed in to Google yet", fix: { run: "pocketbrain sources connect {name}", then: "on the hub machine" } },
  "doctor.source-never-pulled": { where: "doctor", what: "{name} hasn't been pulled yet", fix: { run: "pocketbrain sources pull {name} --dry-run", then: "to see what it would read, then let the hub's schedule pull it" } },
  "doctor.source-refused": { where: "doctor", what: "{name}'s last pull ({at}Z) was refused: {why}", fix: { read: "docs/sources-pull.md", then: "and fix what the reason names; the next scheduled pull tries again" } },

  // ---- install.sh (shell, so the test checks its fail lines against these) ----
  "install.os": { where: "install", what: "pocketBrain installs on macOS and Linux only", fix: { run: "wsl --install", then: "and run this installer again inside WSL" } },
  "install.git-mac": { where: "install", what: "git is missing", fix: { run: "xcode-select --install", then: "and run this installer again" } },
  "install.git": { where: "install", what: "git is missing", fix: { run: "sudo apt install git", then: "or your package manager's equivalent, and run this installer again" } },
  "install.curl": { where: "install", what: "curl is missing", fix: { run: "sudo apt install curl", then: "and run this installer again" } },
  "install.bun-download": { where: "install", what: "Couldn't download Bun (no internet?)", fix: { first: "check your connection", run: "curl -fsSL https://bun.sh/install | bash", then: "and run this installer again" } },
  "install.bun-failed": { where: "install", what: "Bun didn't install", fix: { run: "curl -fsSL https://bun.sh/install | bash", then: "to see why, and run this installer again" } },
  "install.bun-path": { where: "install", what: "Bun installed but isn't on the PATH", fix: { first: "open a new terminal window", run: "bun --version", then: "and if it answers, this installer again" } },
  "install.package": { where: "install", what: "Couldn't install $PKG (no internet, or no such package)", fix: { run: "bun add -g $PKG", then: "to see why" } },
  "install.no-run": { where: "install", what: "pocketbrain installed but doesn't run", fix: { run: "bun add -g $PKG", then: "to reinstall it" } },
  "install.dirty": { where: "install", what: "$SRC has changes of yours, so it isn't updated", fix: { run: "git -C $SRC stash", then: "and run this installer again" } },
  "install.fetch": { where: "install", what: "Couldn't fetch pocketBrain from $REPO (no internet?)", fix: { first: "check your connection", run: "git ls-remote $REPO", then: "to see why, and run this installer again" } },
  "install.no-ref": { where: "install", what: "$REPO has no $REF", fix: { run: "git -C $SRC tag -l", then: "to see the releases, and pass one as POCKETBRAIN_REF" } },
  "install.libraries": { where: "install", what: "Couldn't install pocketBrain's libraries (no internet?)", fix: { run: "cd $SRC && bun install --production", then: "to see why" } },
  "install.no-run-source": { where: "install", what: "pocketbrain installed but doesn't run", fix: { run: "bun $SRC/src/cli.ts help", then: "to see why" } },
} satisfies Record<string, OwnerError>;

export type OwnerErrorId = keyof typeof OWNER_ERRORS;
export type Vars = Record<string, string | number>;

const fill = (s: string, vars: Vars) => s.replace(/\{(\w+)\}/g, (_, k: string) => {
  if (!(k in vars)) throw new Error(`owner error copy: missing {${k}}`);
  return String(vars[k]);
});

// The fix as words: "run pocketbrain hub sync", "click "Resume" on the Assistants page in the dashboard".
export function fixText(f: Fix, vars: Vars = {}): string {
  const core = "run" in f ? `run ${f.run}`
    : "click" in f ? `click "${f.click}" on ${f.on} in the dashboard`
    : "go" in f ? `open the dashboard's ${f.go} page`
    : "reload" in f ? "reload the page"
    : `read ${f.read}`;
  return fill(`${f.first ? `${f.first}, then ` : ""}${core}${f.then ? `${f.then.startsWith("(") ? " " : ", "}${f.then}` : ""}`, vars);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// One line: what happened, then the fix. "Nothing answers on 127.0.0.1:8787. Fix: run …."
// Each what starts as it should read (some start with a command or a file name), so no capitals are added.
export function ownerError(id: OwnerErrorId, vars: Vars = {}): string {
  const e: OwnerError = OWNER_ERRORS[id];
  const what = fill(e.what, vars);
  return `${what}${/[.!?]$/.test(what) ? "" : "."} Fix: ${fixText(e.fix, vars)}.`;
}

export function ownerStatus(id: OwnerErrorId): number {
  return (OWNER_ERRORS[id] as OwnerError).status ?? 400;
}

// The dashboard's error page body: what happened as the heading, the fix under it, linked when it
// is a dashboard page. Text in vars is escaped by the caller's esc.
export function ownerErrorHtml(id: OwnerErrorId, vars: Vars, esc: (s: string) => string): string {
  const e: OwnerError = OWNER_ERRORS[id];
  const safe = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, esc(String(v))]));
  const fix = cap(fixText(e.fix, safe));
  const linked = "go" in e.fix ? fix.replace(`the dashboard's ${e.fix.go} page`, `the dashboard's <a href="${e.fix.path}">${e.fix.go}</a> page`) : fix;
  return `<h1>${fill(esc(e.what), safe)}</h1><p>${linked}.</p>`;
}

// docs/owner-errors.md: every entry, grouped by where it shows, placeholders left in.
export function renderCatalog(): string {
  const head: Record<Where, string> = { dashboard: "Dashboard pages", cli: "Command line", consent: "Consent (\"What is it for?\" and pocketbrain consent)", doctor: "pocketbrain doctor", install: "Installer (install.sh)" };
  const L = ["# Errors you can hit, and their fix", "", "Every error page and command-line failure the owner can meet, written by `src/owner-errors.ts`. `{name}` is filled in when it shows. `test/owner-errors.test.ts` fails when this file and the code differ; rewrite it with `PB_ERRORS_UPDATE=1 bun test test/owner-errors.test.ts`.", ""];
  for (const w of Object.keys(head) as Where[]) {
    L.push(`## ${head[w]}`, "", "| Id | What you see |", "|---|---|");
    for (const [id, e] of Object.entries(OWNER_ERRORS) as [OwnerErrorId, OwnerError][]) {
      if (e.where !== w) continue;
      const what = e.what;
      const line = `${what}${/[.!?]$/.test(what) ? "" : "."} Fix: ${fixText(e.fix, new Proxy({}, { has: () => true, get: (_, k) => `{${String(k)}}` }))}.`;
      L.push(`| \`${id}\`${e.status ? ` (${e.status})` : ""} | ${line.replace(/\|/g, "\\|")} |`);
    }
    L.push("");
  }
  return L.join("\n");
}

// ---------- What the owner's text box answers (src/owner-say.ts, phone UI spec §3-4) ----------
// One fixed sentence per outcome, in the owner's words: "Noted:" only when something was written,
// and no stock opener on the rest (G623). test/owner-copy.test.ts holds these to the forbidden words.
export const OWNER_SAY = {
  "say.empty": "Ask or tell me anything.",
  "say.lookup": "{what}",
  "say.no-match": "Nothing on that yet. Tell me, and I'll keep it.",
  "say.noted": "Noted: {what}. Seen by {audience}.",
  "say.already": "I already have that. Nothing changed.",
  "say.settled": "Settled: {name}'s {attr} is {value}. That answers the question that was waiting; the other answers are under Earlier values.",
  "say.earlier": "Noted as earlier: {name}'s {attr} was {value}. It's {now} now; the earlier one is under Earlier values.",
  "say.disputed": "That's different from what {name} had for {attr} ({was}). I kept both; pick one under Waiting on you.",
  "say.later": "I'll check that against your mail tonight and show you tomorrow.",
  "say.refused": "Nothing saved. {why}",
  "say.why-secret": "That looks like a password or a number to keep secret; I don't keep those.",
  "say.why-instruction": "That reads like an instruction to an assistant, so I didn't keep it.",
  "say.why-other": "I couldn't keep that as it is; try saying it another way.",
  "say.didnt-catch": "I didn't catch who or what that's about. Try 'Ana works at Bay Institute'.",
  "say.unknown-name": "I don't know {name} yet, so I kept nothing. Pages start from your mail and your assistants.",
  "say.near-name": "I don't know {name}. Did you mean {near}?",
  "say.guessed-date": "I guessed around {day} from '{phrase}'; tap to fix.",
  "say.forget-confirm": "I'll forget {name} and {n} facts about them. Say yes, forget.",
  "say.confirm-role": "Did you mean to note a role? {name}: role is {value}.",
  "say.confirm-role-chip": "Yes, note the role",
  "say.hearsay": "That's {who}'s word, not yours, so I didn't note it. If you know it's so, say it as yours.",
  "say.hearsay-chip": "I know it's so",
  "say.negated": "Nothing saved. Tell me what it is, not what it isn't.",
  "say.forget-signin": "To forget {name}, sign in again first, so a borrowed phone can't.",
  "say.settle-signin": "To settle that, sign in again first: its answers show only right after you sign in, so a borrowed phone can't.",
  "say.private-signin": "That's private, so sign in again first to note it, so a borrowed phone can't.",
  "say.forgotten": "Forgotten: {name}. Your assistants no longer see it.",
  "say.new-page": "I don't know {name} yet. Start a page? Pick where it lives; that decides which assistants see it.",
  "say.act": "I don't send or book things myself; ask one of your assistants.",
  "say.answer": "{name}'s {attr} is {value}.",
  "say.answer-verb": "{name} {attr} {value}.",
  "say.answer-none": "Nothing on {name}'s {attr} yet. Tell me, and I'll keep it.",
  "say.answer-waiting": "Two answers for {name}'s {attr}; pick one under Waiting on you.",
  "say.answer-signin": "That shows only right after you sign in, so a borrowed phone can't see it.",
  "say.answer-many": "Your {role}: {names}.",
  "say.ask-nothing": "I have nothing on that. Ask me about someone or something in your memory.",
  "say.new-page-made": "New page for {name} in {area}; Undo takes it back.",
  "say.only-you": "only you see this",
  "say.left-out": "I left out “{what}”; say it on its own to keep it.",
} as const;
export type SayId = keyof typeof OWNER_SAY;
export const say = (id: SayId, vars: Vars = {}): string => fill(OWNER_SAY[id], vars);
