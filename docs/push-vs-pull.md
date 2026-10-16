# Push vs pull: how agents learn the brain changed

Most assistants have no webhook: nothing outside can tell them the brain changed. pocketBrain works on pull. This note says where that matters, who can be pushed to, and what the door does about it.

## Where the gap actually is

Answers are not the problem. `context_pack`, `search` and `read` read the live brain on every call, so an agent that checks the brain before answering (rule 1 of the contract) never answers from a stale copy of *pocketBrain*. Pull at the moment of use is the correct model for answers.

The gap is in three narrower places:

1. **The agent's own memory.** Town, claude.ai and Instinct keep their own memories. If the address in the brain changes, the old one can still sit in the assistant's memory and win when the agent doesn't check.
2. **An open conversation.** A change made mid-conversation is invisible until the agent calls again.
3. **Acting on a change.** "a parent's appointment moved" should make *someone* do something, even when nobody is chatting. That needs a wake-up, and only the host can wake its assistant.

## Who can be pushed to today

| Agent | Can something outside wake it? | Through what |
|---|---|---|
| Claude Code | At session start, yes | A `SessionStart` hook runs a command and its output goes into the session's context. It can fetch "what changed" before the first turn. |
| Instinct | Yes, near real time | Its routine already pulls `/v1/louis/outbox` every 5 minutes. It can pull changes on the same tick and text the owner. |
| Gardener | On its schedule | Already has `changes_since` and `last_run`. |
| Any agent with a mailbox | When it reads mail | The AgentMail relay already delivers agent-to-agent mail, checked against the recipient's slice. |
| Town | No | Custom MCP connector, called only inside a conversation the owner starts. |
| claude.ai | No | Same. Connectors are called within a conversation and never start one. |
| Muse | No | Same (paused). |

## What MCP offers

- **Today (spec 2025-06-18 and earlier):** `resources/subscribe` with `notifications/resources/updated`, plus `list_changed` notifications. They reach a client only while it holds an open session with a server-to-client stream, and hosted chat clients don't turn them into a model turn. pocketBrain's `/mcp` is stateless JSON over POST, so it doesn't offer them, and adding them would change nothing for Town or claude.ai.
- **2026-07-28 spec:** `subscriptions/listen`, a long-lived stream that replaces the old GET listening stream. Same limit: it only helps a client that is connected and listening.
- **Coming:** the MCP Triggers and Events working group is drafting server-initiated callbacks (webhook style) so a server can tell a host "new data". ChatGPT already ships experimental webhook delivery ("MCP Events", needs protocol 2026-07-28 and an `events` capability). This is the real fix for Town and claude.ai, and it depends on each host adopting it. (As of October 2026.)

## What pocketBrain does

1. **One door tool for every agent: `whats_new`** (MCP) and `GET /v1/changes` (JSON). It returns what changed in the caller's slice since that agent last asked: each note with the facts that changed and the note as it reads now. The hub keeps the cursor (each `whats_new` records the brain's head commit in `log/reads.jsonl`), so the agent needs no state. It shows only facts the agent may see, says only "owner" or "an assistant" for who wrote, and skips the agent's own writes and notes where only hidden facts changed, so it tells the agent nothing a read wouldn't. 
2. **Put it second in the standing instructions:** after orientation, call `whats_new`; what it shows beats the assistant's own memory. That closes gap 1 at the start of every conversation, for every agent, including Town and claude.ai.
3. **Claude Code:** a `SessionStart` hook that curls `/v1/changes`, so it gets the changes without having to remember to ask (docs/agent-instructions.md).
4. **Instinct:** optionally pull `/v1/changes` on its existing 5-minute tick. It is the one agent that can act between conversations and text the owner. Off until the owner wants Instinct to be proactive.
5. **No separate per-agent inbox.** `whats_new` with a hub-held cursor *is* the inbox: anything meant for an agent is a fact in its slice, and agent-to-agent mail already has the relay. A second queue would be a second path to keep in sync with the carve.
6. **When a host ships MCP triggers, add them on the door.** `whats_new` is already the feed; a trigger would just say "call whats_new".

## What it costs

- One extra tool call per conversation: a short "nothing new" when nothing changed, at most 15 notes when something did.
- One line per call in `log/reads.jsonl` (also the cursor).
- The owner re-pastes the standing block into Town, claude.ai and Instinct once (`pocketbrain connect <agent>` prints it).
- It works only as well as the agent follows its instructions. Town needed the pasted block to call orientation at all.

## What stays unsolved

- Nothing can wake Town, claude.ai or Muse between conversations. A change can't make them act until the owner talks to them. That is the hosts' boundary, not pocketBrain's, until they adopt MCP triggers.
- A change made during an open conversation is seen only if the agent calls again.
- An assistant's private memory can still hold an old fact until its next conversation, and the hub can't edit or see it.
- Calling `whats_new` is a habit asked for in words, not enforced in code.
