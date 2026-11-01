# Connect Cursor

**You need:** Cursor, and your brain running (`pocketbrain start`).

_The config format was checked against Cursor's own documentation on 2026-11-01, and pocketBrain's side is tested. Cursor itself hasn't been run against it end to end yet._

## The command

```sh
pocketbrain add cursor --kind cursor --write --yes
```

It makes `cursor` a **trial** assistant: it sees your work notes and the names and roles of your contacts, never your money or anything private, and what it saves waits for your OK. Then it puts a `pocketbrain` entry into `~/.cursor/mcp.json`, after a copy of the file as it was (`….pocketbrain-backup-<time>` beside it). Only that entry changes, and a file it can't read is left alone.

The entry starts `pocketbrain mcp --agent cursor`, a small bridge to the brain on this computer. The entry holds no key. The key stays in its own file, `~/.config/pocketbrain/agent-keys/cursor`, readable only by you, and the bridge only ever talks to this computer ([hosting.md](../hosting.md#keys-at-rest)).

Rather edit the file yourself? Leave out `--write`: it prints the entry to paste instead.

If Cursor was your first assistant, `pocketbrain init --kind cursor --write` does the same when it creates your brain.

Quit Cursor and open it again. Then paste the instruction block the command printed into **Cursor Settings → Rules → User Rules**, so it checks the brain without being asked.

## Check it worked

**Cursor Settings → MCP** lists `pocketbrain` with a green dot and its tools. Ask it: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
pocketbrain token --revoke cursor
```

That cuts cursor off at once and deletes its key file. Then remove the `pocketbrain` entry from `~/.cursor/mcp.json` and the instruction you pasted.
