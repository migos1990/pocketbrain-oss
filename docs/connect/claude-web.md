# Connect Claude on the web or phone

**Honest status: this takes an evening today, not minutes.** Claude on the web, on your phone, and the **Connectors** in Claude Desktop all run in the cloud. To use your brain they need:

1. **A fixed public https address** for it that doesn't change when you restart. A quick tunnel's address changes every time, which breaks the sign-in. See [hosting.md](../hosting.md) for the ways to get one.
2. **A sign-in service.** Claude's custom connectors have no field for a key; they sign in with OAuth. pocketBrain checks the sign-in but doesn't run one itself: you set up a free Auth0 tenant once ([oauth.md](../oauth.md), "Which authorization server", six steps in Auth0's settings).
3. **Your brain up whenever you use Claude.** A cloud assistant can't reach a laptop that's asleep or closed.

Making this one guided command is planned. Until then, if you use Claude on your own computer too, [Claude Code](claude-code.md) or [Claude Desktop](claude-desktop.md) through the local bridge connect in minutes and share the same brain.

## Once you have the address and the sign-in

```sh
pocketbrain oauth setup --issuer https://<tenant>.us.auth0.com/ --resource https://<your address>/mcp/oauth --owner-subject '<your user id>'
pocketbrain add claude --kind claude-ai --url https://<your address> --yes
```

The second command opens a 10-minute window in which your own next sign-in becomes this assistant, and prints what's left:

1. In Claude, **Settings → Connectors → Add custom connector**, address `https://<your address>/mcp/oauth`. Sign in with your own account.
2. Paste the instruction block it printed into **Settings → Profile**, personal preferences.

## Check it worked

`pocketbrain oauth status` lists the connection as bound to `claude`. Ask Claude: *"Use pocketbrain: what are my projects?"*

## Undo

Remove the connector in Claude's settings, then `pocketbrain token --revoke claude` (it cuts sign-in connections too).
