# Connect Gemini CLI

**You need:** Gemini CLI, and your brain running (`pocketbrain start`).

_The config format was checked against Gemini CLI's own documentation on 2026-11-01, and pocketBrain's side is tested. Gemini CLI itself hasn't been run against it end to end yet._

## The command

```sh
pocketbrain add gemini --kind gemini --write --yes
```

It makes `gemini` a **trial** assistant: it sees your work notes and the names and roles of your contacts, never your money or anything private, and what it saves waits for your OK. Then it puts a `pocketbrain` entry into `~/.gemini/settings.json`, after a copy of the file as it was (`….pocketbrain-backup-<time>` beside it). Only that entry changes, and a file it can't read is left alone.

The entry starts `pocketbrain mcp --agent gemini`, a small bridge to the brain on this computer. The entry holds no key. The key stays in its own file, `~/.config/pocketbrain/agent-keys/gemini`, readable only by you, and the bridge only ever talks to this computer ([hosting.md](../hosting.md#keys-at-rest)).

Rather edit the file yourself? Leave out `--write`: it prints the entry to paste instead.

If Gemini CLI was your first assistant, `pocketbrain init --kind gemini --write` does the same when it creates your brain.

Quit Gemini CLI and open it again. Then paste the instruction block the command printed into `~/.gemini/GEMINI.md`, so it checks the brain without being asked.

## Check it worked

In Gemini, `/mcp` lists `pocketbrain` and its tools. Ask it: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
pocketbrain token --revoke gemini
```

That cuts gemini off at once and deletes its key file. Then remove the `pocketbrain` entry from `~/.gemini/settings.json` and the instruction you pasted.
