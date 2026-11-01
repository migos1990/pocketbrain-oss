# Connect Claude Desktop

**You need:** the Claude Desktop app, [Node.js](https://nodejs.org) (for `npx`), and your brain running (`pocketbrain start`).

Claude Desktop's **Connectors** settings reach servers on the internet with a sign-in, like Claude on the web ([claude-web.md](claude-web.md)). To reach the brain on your own computer instead, its config file starts a small bridge, `mcp-remote`, that forwards to the local address with your key.

_Config format checked against the mcp-remote documentation on 2026-11-01. The pocketBrain side is tested; the Claude Desktop side hasn't been run end to end here yet._

## The command

```sh
pocketbrain add claude-desktop --slices area:work,contacts-basic --door mcp --yes
```

It prints a key starting `pb_claude-desktop_` and an instruction block.

## Put it into Claude Desktop

**Settings → Developer → Edit Config** opens `claude_desktop_config.json`. Add:

```json
{
  "mcpServers": {
    "pocketbrain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8787/mcp", "--allow-http", "--header", "Authorization:${POCKETBRAIN_AUTH}"],
      "env": { "POCKETBRAIN_AUTH": "Bearer pb_claude-desktop_…" }
    }
  }
}
```

Write `Authorization:${POCKETBRAIN_AUTH}` with no space after the colon (some versions of the app break arguments at spaces), and keep the space inside `POCKETBRAIN_AUTH`. `--allow-http` is fine here because the address never leaves your computer. Quit and reopen the app. Paste the instruction block into **Settings → Profile**, in the box for personal preferences.

## Check it worked

The tools menu in a new chat lists `pocketbrain`. Ask: *"Use pocketbrain: what are my projects?"*

## Undo

Remove the `pocketbrain` entry from the config and the pasted preferences, then `pocketbrain token --revoke claude-desktop`.
