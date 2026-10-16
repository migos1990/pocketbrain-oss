# Quickstart: pocketBrain in 5 minutes

You'll end up with a brain on your own computer and one assistant connected to it. The assistant can read only the part you give it. You need a Mac or Linux computer (on Windows, use WSL) and its Terminal app. You don't need an account, an API key or Notion.

## 1. Install (1 minute)

You need git and [Bun](https://bun.sh) 1.4 (the runtime pocketBrain uses; `curl -fsSL https://bun.sh/install | bash` installs it). Paste this into Terminal and press Enter:

```sh
git clone <repository> pocketbrain && cd pocketbrain && bun install && bun link
```

`bun link` puts the `pocketbrain` command in `~/.bun/bin`. If Terminal says it can't find it, **open a new Terminal window**; if it still can't, your Bun didn't come from its own installer, so add `~/.bun/bin` to your PATH.

pocketBrain is not on npm or Homebrew yet. Once it is, a one-line installer will replace this step.

## 2. Create your brain (3 minutes)

```sh
pocketbrain init
```

It asks a few questions: your name, a short name for your assistant (type `claude` if that's the one you'll connect; the default is `assistant`), the people, projects and decisions you work with, and where you bank. Press Enter on an empty line to skip a question. Your answers stay on this computer, in a folder called `my-brain` in your home folder.

When it's done, it shows two things:

- **What your assistant will see.** It starts as a *trial* assistant. It sees your work notes and the names and roles of your contacts. It never sees your money or anything you marked private, and anything it writes waits for your approval.
- **The line to connect it**, with a token starting `pb_<that name>_` (for example `pb_claude_`). The token is shown once, so save it in your password manager.

## 3. Start it (10 seconds)

```sh
pocketbrain start
```

Leave this window open while you use your assistant. The brain listens only on your own computer. The start message includes a link to your dashboard, where you approve what your assistant proposes.

## 4. Connect your assistant (1 minute)

**Claude Code:** in another Terminal window, paste the `claude mcp add --scope user …` line that `init` printed (`--scope user` makes it work from any folder). Then `claude mcp list` should say `pocketbrain … ✔ Connected`.

**Claude on the web or desktop app, or any other assistant in the cloud:** it can't reach your computer directly, so follow [Connect an assistant in the cloud](#connect-an-assistant-in-the-cloud) below. It takes two more minutes.

Now ask your assistant: *"Use pocketbrain: what are my projects?"* It answers from your work notes. Ask it where you bank, and it tells you that money isn't shared with it.

To make it check the brain without being told, paste the short block that `init` printed as step 3 into the assistant's own custom instructions, once. (`pocketbrain connect claude` prints it again, along with a new token; the old one keeps working until you revoke it.) Claude Code: add it to `~/.claude/CLAUDE.md`. The blocks are in [agent-instructions.md](agent-instructions.md).

---

## Connect an assistant in the cloud

Your brain needs a public address for a cloud assistant to reach it. A free Cloudflare quick tunnel gives you one without an account:

```sh
brew install cloudflared          # on Linux, see developers.cloudflare.com/cloudflared
cloudflared tunnel --url http://127.0.0.1:8787
```

It prints an address like `https://something-random.trycloudflare.com`. In your assistant's settings, add a custom MCP connector with:

- **URL:** `https://something-random.trycloudflare.com/mcp`
- **Header:** `Authorization: Bearer pb_claude_…` (your token)

If there is no field for a header, use `https://something-random.trycloudflare.com/mcp/pb_claude_…` as the URL instead.

The address changes each time you restart the tunnel. For a fixed address on your own domain, and to keep everything running after a restart, see [hub.md](hub.md#a-fixed-address-on-your-domain).

## Start from a file instead of questions

Write what you know in a text file and run `pocketbrain init --name "Your name" --from-text notes.txt`:

```text
# About my work (work)
One or two sentences about what you do.

# People (work)
- Jane Roy: course coordinator at Northfield College, jane@example.edu

# People (personal)
- Lea Martin: neighbour

# Projects
- Course A: next step: grade the midterm [work]
- Garden shed: next step: order the lumber

# Money
- Main bank: Maple Trust Bank

# Money words
salary, Maple Trust
```

These are the rules for the file:

- `(work)` after a heading puts that whole section in your work area, and `[work]` at the end of a line does it for one line. Anything unmarked goes to your personal area.
- `[private]` keeps that line away from your trial assistant.
- Money items are always private.
- "Money words" are words that point at your money. If an assistant without money access writes one of them, that write comes to you instead of going into the brain.
- Any other heading becomes a note.
- Passwords and card numbers are removed, and `my-brain/import/INIT-REPORT.md` tells you where.

You can also start from a Google Takeout export. Add `--from-mbox "All mail.mbox"` or `--from-ics calendar.ics` to the same command. Only people you wrote to or met with are kept.

## Day to day

- `pocketbrain doctor` checks that everything is healthy.
- `init` remembers your first brain, so commands work from any folder. A later `init` (say, a demo brain) doesn't change that; use `--brain <folder>` or `PB_BRAIN` to work in the other one.
- Your assistant owns only the area it reads (work, or your first area). The others have no owner in `rules/policy.yaml`, so anything written there comes to you. Give one an owner (`health: { owner: claude }`) only once that assistant's slices include it.
- To add another assistant: `pocketbrain add <name> --slices area:work,contacts-basic`, then `--yes`. [add-an-agent.md](add-an-agent.md) says which door to pick and how to test it.
- If a token leaks, `pocketbrain token --revoke claude` cuts that assistant off at once.
- `pocketbrain help` lists the few commands you need. `pocketbrain help --all` lists all of them.
- Your brain is a plain folder of Markdown files under git. Back it up to a *private* place, or run `pocketbrain backup --init`.

## Leaving

`pocketbrain uninstall` lists every place pocketBrain put something on your Mac and changes
nothing. Read it, then run it again with `--yes`:

- each `com.pocketbrain.*` launchd job is stopped (`launchctl bootout`), then its file in
  `~/Library/LaunchAgents` and its logs in `~/Library/Logs` (the hub's log holds the dashboard's
  login link) are removed;
- `~/.cloudflared/config.yml` is removed only if `pocketbrain door install` wrote it, with the
  tunnel credentials it names inside `~/.cloudflared`; cloudflared's own sign-in (`cert.pem`) and
  a config you wrote stay;
- the menu-bar app (`~/Applications/PocketBrain.app`) and the keys folder with your settings
  (`~/.config/pocketbrain`) are removed; the settings folder stays if your brain or backups are
  inside it.

Your brain folder and your backups stay. `--remove-brain` (with `--yes`) also removes the brain
folder, and refuses a folder without `rules/policy.yaml` or one that is your home folder. Backups
are never touched: they are yours to keep or delete.

What lives in your accounts is listed, with the exact command, and never run for you: the sign-in
clients bound in `rules/oauth.yaml` (delete each in your sign-in provider's Applications page), the
tunnel and its DNS record (`cloudflared tunnel delete <id>`), and the gardener's deployments (an
`ant ... beta:deployments pause` per deployment, then delete them, its agents and vault in the
Console). The plan reads them from the brain, so run it before `--remove-brain`.
