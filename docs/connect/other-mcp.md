# Connect any other MCP app

Any app that runs on your computer and lets you add an MCP server with an address **and** a header (or "API key", or "bearer token") field can connect.

## The command

```sh
pocketbrain add myapp --slices area:work,contacts-basic --door mcp --yes
```

Use a short name for the app in place of `myapp`. It prints:

- **Address:** `http://127.0.0.1:8787/mcp` (the streamable HTTP transport)
- **Header:** `Authorization: Bearer pb_myapp_…`
- an instruction block for the app's custom instructions.

A key is only ever accepted in that header, never in the address.

**No MCP, but the app can call a web address with a header?** Use the same key on `http://127.0.0.1:8787/v1/…`. The description is at `http://127.0.0.1:8787/openapi.json`.

**Only an address field, then a sign-in page?** That's the sign-in door, which needs a public address; see [claude-web.md](claude-web.md).

## Check it worked

The app lists the brain's tools (`orientation`, `context_pack`, `search`, `remember` and more). Ask it: *"Use pocketbrain: what are my projects?"*

## Undo

Remove the server from the app, then `pocketbrain token --revoke myapp`.
