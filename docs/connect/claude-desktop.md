# Connect Claude Desktop

**You need:** Claude Desktop, and your brain running (`pocketbrain start`).

Claude Desktop's **Connectors** settings reach servers on the internet with a sign-in, like Claude on the web ([claude-web.md](claude-web.md)). The config file used here is the other way in: it starts a program on your computer, and that program is pocketBrain's bridge to your brain.

_The config format was checked against Claude Desktop's own documentation on 2026-11-01, and pocketBrain's side is tested. Claude Desktop itself hasn't been run against it end to end yet._

## The command

```sh
pocketbrain add claude-desktop --kind claude-desktop --write --yes
```

It makes `claude-desktop` a **trial** assistant: it sees your work notes and the names and roles of your contacts, never your money or anything private, and what it saves waits for your OK. Then it puts a `pocketbrain` entry into `claude_desktop_config.json` (on a Mac in `~/Library/Application Support/Claude/`; **Settings → Developer → Edit Config** opens it), after a copy of the file as it was (`….pocketbrain-backup-<time>` beside it). Only that entry changes, and a file it can't read is left alone.

The entry starts `pocketbrain mcp --agent claude-desktop`, a small bridge to the brain on this computer. The entry holds no key. The key stays in its own file, `~/.config/pocketbrain/agent-keys/claude-desktop`, readable only by you, and the bridge only ever talks to this computer ([hosting.md](../hosting.md#keys-at-rest)).

Rather edit the file yourself? Leave out `--write`: it prints the entry to paste instead.

If Claude Desktop was your first assistant, `pocketbrain init --kind claude-desktop --write` does the same when it creates your brain.

Quit Claude Desktop and open it again. Then paste the instruction block the command printed into **Settings → Profile**, the box for personal preferences, so it checks the brain without being asked.

## Check it worked

The tools menu in a new chat lists `pocketbrain`. Ask it: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
pocketbrain token --revoke claude-desktop
```

That cuts claude-desktop off at once and deletes its key file. Then remove the `pocketbrain` entry from `claude_desktop_config.json` and the preferences you pasted.
