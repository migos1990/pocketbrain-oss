# Quickstart: pocketBrain in 5 minutes

You'll end up with a brain on your own computer, one memory of you that every assistant you connect will share, and a first assistant connected to it. Each assistant reads only the part you give it. You need a Mac or Linux computer (on Windows, use WSL) and its Terminal app. You don't need an account, an API key or Notion.

## 1. Install (1 minute)

You need git (on a Mac, `xcode-select --install` adds it) and [Bun](https://bun.sh) 1.4 (`curl -fsSL https://bun.sh/install | bash`). The public source is linked from pocketbrain.dev ("Source on GitHub"). Paste this into Terminal, with that address in place of `<public repository>`, and press Enter:

```sh
git clone <public repository> ~/pocketbrain && cd ~/pocketbrain && bun install && bun link
```

It puts the `pocketbrain` command in `~/.bun/bin`. To update later: `cd ~/pocketbrain && git pull && bun install`. If Terminal then says it can't find `pocketbrain`, **open a new Terminal window**; if it still can't, your Bun didn't come from its own installer, so add `~/.bun/bin` to your PATH.

A one-line installer, `curl -fsSL https://pocketbrain.dev/install.sh | sh`, is written (`install.sh`: it adds Bun if it's missing and installs the newest release into `~/.pocketbrain/app`), but the site doesn't serve it yet.

## 2. Create your brain (3 minutes)

```sh
pocketbrain init
```

It asks a few questions: your name, which assistant will use the brain first (`claude-code`, `claude-ai`, `town` or `browser`; Enter takes Claude Code when it's installed), a short name for it (Enter names it after that kind, like `claude`), the people, projects and decisions you work with, and where you bank. Press Enter on an empty line to skip a question. Your answers stay on this computer, in a folder called `my-brain` in your home folder.

When it's done, it shows two things:

- **What your assistant will see.** It starts as a *trial* assistant. It sees your work notes and the names and roles of your contacts. It never sees your money or anything you marked private, and anything it writes waits for your approval.
- **How to connect it.** For Claude Code on this computer, `init` does it then and there (step 4). For an assistant in the cloud (`claude-ai`, `town`, `browser`), it prints the one `pocketbrain connect <name> --kind <kind> --url …` command to run once your brain has a public address. Otherwise, **the line to connect it**, with a token starting `pb_<that name>_` (for example `pb_claude_`). The token is shown once, so save it in your password manager.

## 3. Start it (10 seconds)

```sh
pocketbrain start
```

Leave this window open while you use your assistant. The brain listens only on your own computer. The start message includes a link to your dashboard, where you approve what your assistant proposes.

## 4. Connect your assistant (1 minute)

**Claude Code:** if you picked it and it's installed, `init` already connected it: it ran `claude mcp add --scope user …` and wrote the standing instruction, and printed nothing left to paste. Otherwise run the `pocketbrain connect <agent> --kind claude-code` line that `init` printed. It runs `claude mcp add --scope user …` for you (`--scope user` makes it work from any folder) and writes the standing instruction into `~/.claude/CLAUDE.md`, so you can skip the paste below. Without Claude Code installed, `init` prints the `claude mcp add` line to paste instead. Then `claude mcp list` should say `pocketbrain … ✔ Connected`.

**Claude on the web or desktop app, or any other assistant in the cloud:** it can't reach your computer directly, so follow [Connect an assistant in the cloud](#connect-an-assistant-in-the-cloud) below. It takes two more minutes.

Now ask your assistant: *"Use pocketbrain: what are my projects?"* It answers from your work notes. Ask it where you bank, and it tells you that money isn't shared with it.

To make it check the brain without being told, paste the short block that `init` printed as step 3 into the assistant's own custom instructions, once. (`pocketbrain connect claude` prints it again, along with a new token; the old one keeps working until you revoke it. That works from the terminal while `claude` is the trial agent `init` made. Once you make it core, a new token needs your yes: press **One-time code** on its dashboard page, then `pocketbrain connect claude --code <code>`. Every token made from a terminal shows in the digest.) Claude Code: add it to `~/.claude/CLAUDE.md`. The blocks are in [agent-instructions.md](agent-instructions.md).

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

If there is no field for a header, connect it through the OAuth door instead ([oauth.md](oauth.md)): a token in the URL is refused. A token stops working after 90 days; `pocketbrain doctor` says when to rotate it.

The address changes each time you restart the tunnel. For a fixed address on your own domain, and to keep everything running after a restart, see [hub.md](hub.md#a-fixed-address-on-your-domain). Keeping the hub running after a restart is built for a Mac (launchd); on Linux, run `pocketbrain start` under your own service manager (a systemd user unit, for example).

## Start from a file instead of questions

Write what you know in a text file and run `pocketbrain init --name "Your name" --from-text notes.txt`:

```text
# About my work (work)
One or two sentences about what you do.

# People (work)
- Jane Roy: course coordinator at Northfield College, jane@northfield.example

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
- Every per-day rule (the nightly pass and the digest, the request-budget alert, the handoff and source-check caps, and the dates the brain writes) counts your day in `owner.timezone` in `rules/policy.yaml` (default America/Toronto; for example `owner: { timezone: Europe/Paris }`), so a late evening is still today. The dashboard shows its dates and times in that zone too (stored times stay UTC; the full stamp is on hover where a page shows one).
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

Two things it doesn't do: remove the `pocketbrain` command itself (in the cloned folder run
`bun unlink`, then delete the folder; a copy from the one-line installer goes with
`rm ~/.bun/bin/pocketbrain && rm -rf ~/.pocketbrain/app`), and remove the connection on each assistant's side (for Claude
Code, `claude mcp remove --scope user pocketbrain`). On Linux there are no launchd jobs; stop the
hub however you started it.
