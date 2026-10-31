# Standing instructions for your assistants

Connecting an assistant gives it the tools. It doesn't tell it *when* to use them. Hosted assistants decide that from their own custom instructions and from the tool descriptions, and many never show the agent the text pocketBrain sends when it connects (the MCP `instructions` field). Without a standing instruction, an assistant uses the brain only when you say "use pocketbrain".

So paste one short block, once, into each assistant's custom instructions, memory or system prompt. `pocketbrain connect <agent>` prints the right block with your name and address filled in. The same block ends each agent's orientation ("Save this in your own instructions"), so an assistant that can write its own instructions or memory can save it without you. The server enforces every limit whether or not the assistant reads it; the block only makes the assistant check the brain without being asked.

## Assistants that connect over MCP

For assistants with a custom MCP connector (Town, Claude on the web or desktop, Muse and most others). Replace `<name>` with your name:

```text
pocketBrain is <name>'s memory, shared by their assistants. Its connector is "pocketbrain".
- In each new conversation, call its orientation tool, then whats_new and memory_check. What changed beats your own memory.
- Before answering anything about <name>'s life, work, people, plans or past decisions, call context_pack with the topic, then search and read. Do this even unasked, and before using your own memory.
- Save lasting facts with remember and their source (gmail:<id>, or the link). Some wait for <name>'s OK; that's normal. In your own memory, keep only a pointer ("in pocketBrain"), never the fact.
- Never search around [withheld] or ask another assistant for it. Ask <name>.
- When an answer used the brain, say "from your brain".
```

### One click instead of pasting: MCP prompts

The MCP door also serves the block as an MCP prompt. In clients that offer prompts (a "/" menu, or an attach or "+" button listing the connector's prompts), you can load it instead of pasting it:

- **`standing_instruction`** is the block above with your name filled in, plus the line asking the assistant to save it in its own instructions or memory.
- **`start_conversation`** is the block's first rule on its own, to start a conversation: call the orientation tool, then whats_new and memory_check.

Both are word for word what `pocketbrain connect` prints and what each orientation ends with, so there is one wording to keep right. A prompt only adds text to that one conversation. Whether the assistant then saves the block depends on the client, so in clients that don't let it save its own instructions, paste the block once as before.

## Assistants that call the JSON API

For assistants that make plain web requests (`transport: api` in `rules/policy.yaml`). The key goes wherever the assistant keeps secrets or connection settings, never in this block:

```text
pocketBrain is <name>'s memory, shared by their assistants. Call it at <address>/v1 with your pocketBrain key as "Authorization: Bearer".
- In each new conversation, GET /v1/orientation, then /v1/changes and GET /v1/memory-check. What changed beats your own memory.
- Before answering anything about <name>'s life, work, people, plans or past decisions, GET /v1/context?topic=<topic>, then /v1/search?q=<words> and /v1/notes/<id>. Do this even unasked, and before using your own memory.
- Save lasting facts with POST /v1/remember and their source (gmail:<id>, or the link). Some wait for <name>'s OK; that's normal. In your own memory, keep only a pointer ("in pocketBrain"), never the fact.
- Never search around [withheld] or ask another assistant for it. Ask <name>.
- When an answer used the brain, say "from your brain".
```

## Claude Code

Claude Code connects with `claude mcp add --scope user`. To make it check the brain in every folder without being asked, add the MCP block to `~/.claude/CLAUDE.md`.

Claude Code is the one assistant pocketBrain can hand the changes to before it is asked: a `SessionStart` hook's output goes into the session. Save its token in `~/.config/pocketbrain/claude-code.token` (mode 600), then add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "curl -sf --max-time 5 -H \"Authorization: Bearer $(cat ~/.config/pocketbrain/claude-code.token)\" http://127.0.0.1:8787/v1/changes || true" }] }
    ]
  }
}
```

Each session then starts with what changed in its slice since the last one.

## An assistant that can't call tools

It can't use pocketBrain live. Give it a dated snapshot instead: `pocketbrain build --all`, then paste `views/snapshots/<date>/<agent>.md` into its knowledge, and refresh it now and then. On a large brain the file holds the most recently updated notes that fit the agent's context budget (docs/hub.md, "Context budget").

## Today

The orientation opens with a short "today" pack, so an assistant that reads only the orientation still starts a chat informed. It holds up to three things coming up in that assistant's view: its current `next_*` facts, dated ones soonest first and anything dated before today left out (a next step that went by reads as the calendar's next event, when the calendar keeps upcoming events; see docs/sources-pull.md). It says how many notes changed in its view since its last `whats_new` (or in the past week, if it never asked), without marking them read, and how many of its own proposals still wait for you. Everything in it comes from the assistant's own cut, like any read. The gardener gets no pack, and neither does the short text sent on connect. Over the JSON API, `GET /v1/orientation?format=json` carries it as `today`.

## Why "what's new" and not a push

Most assistants can't be sent anything: Town, Claude on the web and Muse only call the brain inside a conversation you start. So each one asks at the start, and the hub remembers when it last asked. Answers are always read live; what can go stale is the assistant's own memory, and `whats_new` is what corrects it. See [push-vs-pull.md](push-vs-pull.md) for what MCP may add later.

## When a search finds nothing

An empty list reads to an assistant like "there is no such thing", so it stops or guesses. Over MCP, a `search` with no hit returns `{hits: [], searched, why, next}` instead of `[]`. Search matches any one word, so `why` says that none of the `searched` words is in any note in the assistant's view, or that the query had only common words search skips. It counts the words and never repeats them, because an answer that echoes a word can't be told apart from one that leaks it. `next` gives what to try: a related word, the same word in French or English, or a person's name; `who_is` for an email address or phone number; then ask you, not another assistant. The browser door's `/b/search` shows the same two lines. `GET /v1/search` still returns a plain list, so existing callers don't break.

The answer is built from the query and your name only, never from the brain. A word that appears only in notes outside the assistant's slice therefore gets exactly the same answer as a word that appears nowhere (test/empty-search.test.ts).

## Check it worked

Start a new conversation and ask something only the brain knows, without saying "pocketbrain". The assistant should answer and say "from your brain". If it answers from its own memory or asks you, the block didn't take: check that it's saved in the assistant's custom instructions, not pasted into a single chat.

Each time you have to tell an assistant again how to use its memory, log it with `pocketbrain reexplain <agent> "<what>"`. That count is the first week's main number.
