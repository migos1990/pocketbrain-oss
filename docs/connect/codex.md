# Connect Codex CLI

**You need:** Codex CLI, and your brain running (`pocketbrain start`).

_The config format was checked against Codex CLI's own documentation on 2026-11-01, and pocketBrain's side is tested. Codex CLI itself hasn't been run against it end to end yet._

## The command

```sh
pocketbrain add codex --kind codex --write --yes
```

It makes `codex` a **trial** assistant: it sees your work notes and the names and roles of your contacts, never your money or anything private, and what it saves waits for your OK. Then it puts a `pocketbrain` entry into `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`), as one `[mcp_servers.pocketbrain]` table, after a copy of the file as it was (`….pocketbrain-backup-<time>` beside it). Only that entry changes, and a file it can't read is left alone.

The entry starts `pocketbrain mcp --agent codex`, a small bridge to the brain on this computer. The entry holds no key. The key stays in its own file, `~/.config/pocketbrain/agent-keys/codex`, readable only by you, and the bridge only ever talks to this computer ([hosting.md](../hosting.md#keys-at-rest)).

Rather edit the file yourself? Leave out `--write`: it prints the entry to paste instead.

If Codex CLI was your first assistant, `pocketbrain init --kind codex --write` does the same when it creates your brain.

Quit Codex CLI and open it again. Then paste the instruction block the command printed into `~/.codex/AGENTS.md`, which Codex reads in every folder, so it checks the brain without being asked.

## Check it worked

In Codex, `/mcp` lists `pocketbrain` and its tools. Ask it: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
pocketbrain token --revoke codex
```

That cuts codex off at once and deletes its key file. Then remove the `[mcp_servers.pocketbrain]` table from `~/.codex/config.toml` and the instruction you pasted.
