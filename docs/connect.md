# Connect your assistant

pocketBrain is one memory that all your assistants share. Each assistant gets its own name, its own key and its own slice of the brain, so you can cut one off without touching the others.

Pick the app you use. Apps that run on your own computer connect in about two minutes and need nothing else. Assistants that run in the cloud (Claude on the web or phone, ChatGPT) have to reach your brain over the internet, which takes more setup today.

| Your assistant | Where it runs | Time | Page |
|---|---|---|---|
| Claude Code | your computer | 1 minute | [claude-code.md](connect/claude-code.md) |
| Cursor | your computer | 2 minutes | [cursor.md](connect/cursor.md) |
| VS Code (Copilot chat) | your computer | 2 minutes | [vscode.md](connect/vscode.md) |
| Codex CLI | your computer | 2 minutes | [codex.md](connect/codex.md) |
| Gemini CLI | your computer | 2 minutes | [gemini-cli.md](connect/gemini-cli.md) |
| Claude Desktop | your computer | 2 minutes | [claude-desktop.md](connect/claude-desktop.md) |
| Any other MCP app | your computer | 2 minutes | [other-mcp.md](connect/other-mcp.md) |
| Claude on the web or phone | the cloud | an evening, see the page | [claude-web.md](connect/claude-web.md) |
| ChatGPT | the cloud | not yet, see the page | [chatgpt.md](connect/chatgpt.md) |

Every page has the same four parts: what you need, the command, how to check it worked, and how to undo it.

## One command for every app on your computer

1. Your brain is running: `pocketbrain start` in a terminal window you leave open ([quickstart.md](quickstart.md)).
2. Connect the app:

   ```sh
   pocketbrain add cursor --kind cursor --write --yes
   ```

   Use your app's kind in place of `cursor`: `cursor`, `vscode`, `codex`, `gemini`, `claude-desktop`, `claude-code`, or `mcp` for any other. The app starts as a **trial** assistant: it sees your work notes and the names and roles of your contacts, never your money or anything private, and what it saves is a proposal that files only when you let it in ([Try it](#try-it)). `--write` puts a `pocketbrain` entry into the app's own config file, after a backup of that file, changing nothing else in it; without `--write` it prints the entry for you to paste.
3. Restart the app, and paste the instruction block the command printed where its page says, so it checks the brain without being asked.

The app's config holds a command, `pocketbrain mcp --agent cursor`, and never a key. The key stays in a file of its own, readable only by you ([hosting.md](hosting.md#keys-at-rest)). The bridge sends it only to the hub on this computer and never follows a redirect. `pocketbrain token rotate cursor --yes` puts a new key in that file, never on screen; quit the app and open it again. If `--write` can't write the app's config, only the key it just made is taken back: a key the app already had keeps working.

Done with an app, or think its key leaked? One command cuts it off at once and deletes its key file:

```sh
pocketbrain token --revoke cursor
```

## Try it

Ask the app: *"Remember that I prefer short answers."* It saves that with its source. While the app is on trial, what it saves is a proposal, and no screen asks you to approve it: you're asked only about conflicts ([filing.md](filing.md)). The dashboard's Settings lists it under **Still open** with what happens to it (an unanswered one expires after two weeks). To let this one in, run `pocketbrain inbox --accept <file>` with the `inbox/…yaml` file the app was told it went to; to let the app's saves in from now on, `pocketbrain agent tier <app> core`. Then ask a **second** app *"What do you know about how I like answers?"* It knows. That's the point: what one assistant learns, the others know next time.

## When your computer sleeps

Apps on the same computer don't care: they sleep and wake with it. The nightly tidy pass runs when the computer next wakes. A cloud assistant can't reach a sleeping laptop, which is one more reason the cloud pages say what they need. [hosting.md](hosting.md) covers keeping the brain up somewhere else.

More detail on doors, slices and widening an assistant later: [add-an-agent.md](add-an-agent.md).
