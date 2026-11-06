# Connect Claude Code

**You need:** Claude Code installed (`claude` works in a terminal) and your brain running (`pocketbrain start`).

## If Claude Code was your first assistant

When you picked Claude Code in `pocketbrain init`, it's already connected: init ran `claude mcp add --scope user …` and wrote the standing instruction into `~/.claude/CLAUDE.md` between `<!-- pocketbrain -->` lines. Nothing to paste.

## Otherwise

```sh
pocketbrain add claude-code --kind claude-code --yes
```

It makes the trial assistant, saves its key in `~/.config/pocketbrain/agent-keys/claude-code` (readable only by you), runs `claude mcp add --scope user pocketbrain -- … pocketbrain mcp --agent claude-code` for you (`--scope user` makes it work from any folder), and writes the standing instruction into `~/.claude/CLAUDE.md`. Claude Code starts the same stdio bridge as every app on this computer ([hosting.md](../hosting.md#keys-at-rest)), so the key is never on `claude`'s command line or in its config. If the `claude` command isn't installed yet, it prints that one line, with no key in it, for you to run later.

## Check it worked

```sh
claude mcp list
```

should say `pocketbrain … ✔ Connected`. Then, in Claude Code: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
claude mcp remove --scope user pocketbrain
pocketbrain token --revoke claude-code
```

and delete the lines between the two `<!-- pocketbrain -->` markers in `~/.claude/CLAUDE.md`.
