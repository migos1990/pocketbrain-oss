# Connect VS Code (Copilot chat)

**You need:** VS Code, and your brain running (`pocketbrain start`).

_The config format was checked against VS Code's own documentation on 2026-11-01, and pocketBrain's side is tested. VS Code itself hasn't been run against it end to end yet._

## The command

```sh
pocketbrain add vscode --kind vscode --write --yes
```

It makes `vscode` a **trial** assistant: it sees your work notes and the names and roles of your contacts, never your money or anything private, and what it saves waits for your OK. Then it puts a `pocketbrain` entry into your VS Code user `mcp.json` (on a Mac `~/Library/Application Support/Code/User/mcp.json`, on Linux and WSL `~/.config/Code/User/mcp.json`; **MCP: Open User Configuration** opens it), after a copy of the file as it was (`….pocketbrain-backup-<time>` beside it). Only that entry changes, and a file it can't read is left alone.

The entry starts `pocketbrain mcp --agent vscode`, a small bridge to the brain on this computer. The entry holds no key. The key stays in its own file, `~/.config/pocketbrain/agent-keys/vscode`, readable only by you, and the bridge only ever talks to this computer ([hosting.md](../hosting.md#keys-at-rest)).

Rather edit the file yourself? Leave out `--write`: it prints the entry to paste instead.

If VS Code was your first assistant, `pocketbrain init --kind vscode --write` does the same when it creates your brain.

Quit VS Code and open it again. Then paste the instruction block the command printed into a user instructions file (Command Palette, **Chat: New Instructions File**, then your user folder), so it checks the brain without being asked.

## Check it worked

Command Palette, **MCP: List Servers**: `pocketbrain` is running. Ask it: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
pocketbrain token --revoke vscode
```

That cuts vscode off at once and deletes its key file. Then remove the `pocketbrain` entry under `servers` in your user `mcp.json` (**MCP: Open User Configuration**) and the instructions file.
