# Connect Gemini CLI

**You need:** the Gemini CLI (`gemini`), and your brain running (`pocketbrain start`).

_Command checked against the Gemini CLI's MCP documentation on 2026-11-01. The pocketBrain side is tested; the Gemini side hasn't been run end to end here yet._

## The command

```sh
pocketbrain add gemini --slices area:work,contacts-basic --door mcp --yes
```

It prints a key starting `pb_gemini_` and an instruction block.

## Put it into Gemini CLI

```sh
gemini mcp add -s user --transport http --header "Authorization: Bearer pb_gemini_…" "pocketbrain" http://127.0.0.1:8787/mcp
```

`-s user` makes it work in every folder. It writes the key into `~/.gemini/settings.json` as plain text, readable by programs running as you. Paste the instruction block into `~/.gemini/GEMINI.md`.

## Check it worked

In Gemini, `/mcp` lists `pocketbrain` and its tools. Ask: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
gemini mcp remove -s user pocketbrain
pocketbrain token --revoke gemini
```

and remove the block from `~/.gemini/GEMINI.md`.
