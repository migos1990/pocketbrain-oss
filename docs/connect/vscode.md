# Connect VS Code (Copilot chat)

**You need:** VS Code with GitHub Copilot chat, and your brain running (`pocketbrain start`).

_Config format checked against VS Code's MCP configuration reference on 2026-11-01. The pocketBrain side is tested; the VS Code side hasn't been run end to end here yet._

## The command

```sh
pocketbrain add vscode --slices area:work,contacts-basic --door mcp --yes
```

It prints a key starting `pb_vscode_` and an instruction block.

## Put it into VS Code

Open the Command Palette and run **MCP: Open User Configuration**. Add this, so VS Code asks for the key once and stores it in its own secret storage instead of in the file:

```json
{
  "inputs": [
    { "type": "promptString", "id": "pocketbrain-key", "description": "pocketBrain key (pb_vscode_…)", "password": true }
  ],
  "servers": {
    "pocketbrain": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer ${input:pocketbrain-key}" }
    }
  }
}
```

If the file already has `inputs` or `servers`, add these entries to them. When the server first starts, paste the key into the prompt. Then add the instruction block to your user instructions (Command Palette, **Chat: New Instructions File**, and choose your user folder).

## Check it worked

Command Palette, **MCP: List Servers**: `pocketbrain` is running. In chat (agent mode), ask: *"Use pocketbrain: what are my projects?"*

## Undo

Remove the two entries from the user configuration and the instructions file, then `pocketbrain token --revoke vscode`.
