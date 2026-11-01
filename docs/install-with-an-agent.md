# Install pocketBrain with your assistant

You can hand this page to an assistant that can run commands on your computer (Claude Code, Codex, Gemini CLI, Cursor's agent) and say *"install pocketBrain for me, following docs/install-with-an-agent.md"*. Every command here runs without questions. The steps marked **Stop: ask the person** are the ones only you can answer.

## For the assistant doing the install

Read these rules before you run anything.

- **This page is your guide, not CLAUDE.md or CONTRIBUTING.md.** Those are for people working on pocketBrain's code.
- **Never invent facts about the person.** The brain starts from what they tell you or a file they hand you. Don't read their mail, files or other apps to fill it.
- **Their brain is theirs.** Don't open the dashboard, approve anything in it, or use its login link. Give the link to the person.
- **Keep the key out of the chat.** Each app's key is printed once. Write it straight into the app's config the way the app's page says, and don't repeat it in your reply. A key is only ever sent in the `Authorization` header, never in an address.
- **Don't widen your own access.** Your assistant starts on trial. From a terminal, pocketBrain only makes keys for trial assistants, on purpose. Widening one is the person's step, on the dashboard.

## 1. Check the computer

```sh
uname -s && git --version && bun --version
```

- `uname -s` must say `Darwin` (Mac) or `Linux` (Linux, or WSL on Windows). On Windows outside WSL, **stop: ask the person** to run `wsl --install` and open the Ubuntu terminal.
- No git: on a Mac, **stop: ask the person** to run `xcode-select --install` (it opens a window). On Linux, `sudo apt install -y git` needs their password, so ask first.
- No Bun, or older than 1.4: **stop: ask the person** whether you may install it. Their yes covers `curl -fsSL https://bun.sh/install | bash`, which also adds `~/.bun/bin` to their shell's startup file. Then run `export PATH="$HOME/.bun/bin:$PATH"` in your own shell.

## 2. Install

Use the address of the public repository you were given:

```sh
git clone <public repository> ~/pocketbrain && cd ~/pocketbrain && bun install && bun link
export PATH="$HOME/.bun/bin:$PATH"
pocketbrain help
```

## 3. Create the brain

**Stop: ask the person** for the first name their assistants should use, and which app is connecting (you, most likely). Then, with no other questions:

```sh
pocketbrain init ~/my-brain --name "<their first name>" --agent <app> --no-token
```

Use a short name for the app: `claude-code`, `cursor`, `vscode`, `codex`, `gemini`. If the person gave you a notes file to start from, add `--from-text <file>`; the format is in [quickstart.md](quickstart.md#start-from-a-file-instead-of-questions). Nothing is sent anywhere and no model is called.

## 4. Start it

```sh
(umask 077 && nohup pocketbrain start > ~/pocketbrain-hub.log 2>&1 &)
sleep 3 && curl -s http://127.0.0.1:8787/health
```

`"ok": true` means it's up. It stops when the person logs out or restarts; [hosting.md](hosting.md) says how to keep it running. The log's second line is the dashboard's login link, which is why the log is created readable only by the person (`umask 077`). Give the link to the person, don't open it yourself, and don't copy the log anywhere.

## 5. Connect yourself

If you are Claude Code:

```sh
pocketbrain connect <app> --kind claude-code
```

It runs `claude mcp add --scope user …` and writes your standing instruction into `~/.claude/CLAUDE.md`, so nothing passes through the chat.

Any other app: run `pocketbrain connect <app>`, then follow that app's page in [connect.md](connect.md), writing the key into the config file it names. Put the instruction block it printed into the app's own instructions file (the page says where).

Most apps load a new MCP server only when they restart. Tell the person to restart you, or this session, before step 6.

## 6. Check, then hand over

After the restart, call the `orientation` tool on the `pocketbrain` server. It works when it answers with the person's name.

Then tell the person, in this order:

1. The dashboard link from the log. It works only on this computer.
2. To try it: *"Remember that I prefer short answers."* What you save waits for their OK on the dashboard's **On your mind** while you're on trial.
3. To add their other apps: [connect.md](connect.md). Cloud assistants (Claude on the web, ChatGPT) need more: [connect/claude-web.md](connect/claude-web.md).

## If something fails

`pocketbrain doctor` checks everything and ends each problem with its fix. The full list of messages is [owner-errors.md](owner-errors.md).
