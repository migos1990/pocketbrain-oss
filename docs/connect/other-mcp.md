# Connect any other MCP app

Any app on your computer that can start an MCP server as a command (stdio), or call one at an address with a header, can connect.

## The command

```sh
pocketbrain add myapp --kind mcp --yes
```

Use a short name for the app in place of `myapp`. It makes a **trial** assistant and prints the command for the app to start, `pocketbrain mcp --agent myapp` (with full paths, so an app started from a launcher finds it), and an instruction block for the app's custom instructions. The key stays in `~/.config/pocketbrain/agent-keys/myapp`, readable only by you, and the bridge only ever talks to this computer ([hosting.md](../hosting.md#keys-at-rest)).

**The app takes an address and a header instead?** Use `pocketbrain add myapp --slices area:work,contacts-basic --door mcp --yes`. It prints the address (`http://127.0.0.1:8787/mcp`) and a header, `Authorization: Bearer pb_myapp_…`, shown once. A key is only ever accepted in that header, never in the address.

**No MCP, but the app can call a web address with a header?** Use the same kind of key on `http://127.0.0.1:8787/v1/…`, described at `http://127.0.0.1:8787/openapi.json`.

**Only an address field, then a sign-in page?** That's the sign-in door, which needs a public address; see [claude-web.md](claude-web.md).

## Check it worked

The app lists the brain's tools (`orientation`, `context_pack`, `search`, `remember` and more). Ask it: *"Use pocketbrain: what are my projects?"*

## Undo

```sh
pocketbrain token --revoke myapp
```

That cuts it off at once and deletes its key file. Then remove the server from the app.
