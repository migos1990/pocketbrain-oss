# Connect Cursor

**You need:** Cursor, and your brain running (`pocketbrain start`).

_Config format checked against Cursor's documentation on 2026-11-01. The pocketBrain side (address and key) is tested; the Cursor side hasn't been run end to end here yet._

## The command

```sh
pocketbrain add cursor --slices area:work,contacts-basic --door mcp --yes
```

It prints a key starting `pb_cursor_` and an instruction block.

## Put it into Cursor

Open (or create) `~/.cursor/mcp.json`, the file for all your projects, so the key never lands in a project folder, and add:

```json
{
  "mcpServers": {
    "pocketbrain": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer pb_cursor_…" }
    }
  }
}
```

If the file already has an `mcpServers` list, add the `pocketbrain` entry to it. Restart Cursor. Then paste the instruction block into **Cursor Settings → Rules → User Rules**.

The key sits in that file as plain text, readable by programs running as you. Don't commit it or sync that file anywhere.

## Check it worked

**Cursor Settings → MCP** lists `pocketbrain` with a green dot and its tools. Ask the agent: *"Use pocketbrain: what are my projects?"*

## Undo

Remove the `pocketbrain` entry from `~/.cursor/mcp.json` and the rule you pasted, then `pocketbrain token --revoke cursor`.
