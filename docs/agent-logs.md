# Agent logs: an archive of what each assistant did

Status: built on branch `claude/agent-logs` (2026-10-08). Code: `src/logs.ts`, `src/import/logs.ts`, tests in `test/logs.test.ts`.

Each assistant can send its conversation or activity logs to the hub, where they land in **its own journal**, readable by the owner and by that assistant only. The owner can also forward a vendor's export. The archive is searchable by the owner with the same BM25 scorer as notes. Nothing in it reaches another agent's view.

## 1. How a log gets in

| Path | Who | Call |
|---|---|---|
| MCP tool `log_session` | Town, Muse, Claude | `{log_id, date, kind, channel, title, turns: [{role, at, text}]}` or `text` |
| `POST /v1/logs` | Instinct, anything that only makes HTTPS calls | same JSON body |
| `pocketbrain logs import --as <agent> --file <export>` | The owner, forwarding an export | Claude Code `.jsonl`, claude.ai or ChatGPT `conversations.json`, our JSON, plain text |

The author always comes from the token (or the owner's `--as`), never from the body.

## 2. What happens to it (all in code)

1. **Kill switches**: a paused or read-only agent can't send logs. `logs: false` on an agent in `policy.yaml` refuses its logs.
2. **Shape**: `date` is YYYY-MM-DD and not in the future, `kind` is `conversation` or `activity`, there are turns or text, and there are no control characters.
3. **Secrets are blanked**, not refused: card numbers, account numbers, passwords, PINs, door and alarm codes, booking codes, API keys, private keys and access tokens become `[removed: secret-shaped]` before anything touches disk. Refusing would lose the whole log over one booking code.
4. **Limits** (`policy.yaml`, the owner only): defaults `logs: { max_bytes: 262144, max_per_day: 48, retention_days: 60 }`, overridable per agent (`agents.town.logs: {...}`). Imports by the owner are not rate-limited.
5. **Stable id**: `hid = sha256(agent + log_id)[:12]`, or of agent, date and text when there's no `log_id`. Re-sending the same log is a no-op. A longer version replaces a shorter one (a conversation that grew during the day). A shorter or equal one is a no-op. A log past retention can't be re-sent under the same id.
6. **Always-on checks hold the log for the owner** instead of refusing it: injection shapes (the same list as the write path), and words of a category the agent isn't given (`rules/checks.yaml categories`, e.g. money words for Town). A held log sits in `inbox/logs/` with an alert in `log/alerts.jsonl`, which the digest shows. The author can't read it back and consolidation never sees it. `pocketbrain logs held`, then `logs --release <file>` or `--drop <file>`.
7. **Commit**: one git commit per log, authored by the agent (or `louis` for an import), with a line in the hash-chained `log/writes.jsonl` and in `log/logs.jsonl`.

## 3. Who sees it

| Reader | Sees |
|---|---|
| The owner | everything: `pocketbrain logs search "<words>"` (all agents, held and archived marked), `logs read <id>` |
| The author | its own released logs from the last 60 days: `search_logs` and `read_log` (MCP), `GET /v1/logs/search?q=`, `GET /v1/logs/<id>` |
| Any other agent | nothing. Another agent's log id answers exactly like a missing one. `journal/` is not a content folder, so views, cells, `context_pack` and note search never load it |

Reads are logged in `log/reads.jsonl` as `log_search` and `log_read`.

## 4. The format (for the consolidation pass)

One Markdown file per log at `journal/<agent>/logs/<YYYY-MM>/<date>-<hid>.md`. Months past retention move whole to `archive/journal/<agent>/logs/<YYYY-MM>/` in upkeep (rule `journal-archive`, undoable like the others).

```yaml
---
id: journal/town/logs/2026-10/2026-10-08-e0024157e592
type: log
agent: town
hid: e0024157e592            # stable across re-sends
log_id: sms-2026-10-08       # the sender's own id, when given
kind: conversation           # or activity
channel: sms                 # sms, chat, email, routine:<name>, claude-code, claude.ai, chatgpt…
title: Evening texts
date: 2026-10-08             # the day the log is about
received: 2026-10-08T21:58:02.114Z
first_received: …            # only on an updated log
fidelity: self-reported      # the agent's own account; "export" when Louis forwarded a vendor export
via: mcp                     # mcp | api | import
turns: 2
bytes: 131
sha256: …
redacted: [a booking code]   # only when something was blanked
released: { by: louis, at: 2026-10-09, was: [...] }   # only when it was held first
---
**louis** · 20:01
Remind me to grade the security labs tomorrow

**town** · 20:02
Added a reminder for 9:00.
```

Body: an optional `## <title>`, then one block per turn, `**<role>** · <HH:MM>` on its own line followed by the text. A plain-text log is just the text. Turn roles are whatever the sender used (`louis`, `user`, `human`, `assistant`, the agent's name).

Rules for whoever consolidates logs into facts:
- Read only `journal/<agent>/logs/`, never `inbox/logs/` (held) and never `archive/`.
- A fact drawn from a log is the author's observation: `source_type: agent_observation`, a source ref of `agent-log:<agent>/<hid>` (a known scheme, ranked as the agent's own memory), verification `self-reported`, unless the turn quotes the owner and the log's `fidelity` is `export`. Even then, the owner's words in an export are not an owner message id; they need the owner's confirmation to become `confirmed-by-louis`.
- A promoted fact goes through the normal write path, into an area the author owns, so carving and the leak tripwire still apply. A log never shares anything by itself.

## 5. How each assistant's logs can actually get here

Checked 2026-10-08 against what the project knows and public docs. No vendor was tested live.

| Assistant | Can it export its transcripts? | Can it post its own log? | Route |
|---|---|---|---|
| **Instinct** | No export or developer API found (invite-only texting agent). | Yes, per the owner it can make plain API calls. | A daily "send your log" instruction posting to `/v1/logs`. Self-reported. The verbatim copy is the SMS thread on the owner's phone; reading it from the Mac's Messages database is a possible later importer (not built). |
| **Town** | Not found in its docs. | Yes. Its docs show custom MCP servers enabled per routine, and routines run on a schedule. | A Town routine, "End of day: archive today's conversations", with pocketBrain's MCP enabled, calling `log_session` once per conversation. Self-reported. |
| **Muse** | Unknown: the product couldn't be identified from here. | Probably, since it takes custom MCP. | The same end-of-day instruction if it can schedule; otherwise the owner asks it, or forwards an export if one exists. |
| **Claude** | Yes. claude.ai data export (conversations.json) and Claude Code session files (`~/.claude/projects/*/*.jsonl`). | Yes, over MCP. | `logs import` for both formats (built and tested). A Claude Code SessionEnd hook could post each session automatically (not built). |

The honest limit: **a log an agent writes about itself is its own account.** It can summarize, leave things out, or be steered by an injection, and nothing in the hub can check it against the real conversation. That's why every self-sent log is `fidelity: self-reported` and ranks as an agent observation. Verbatim history exists only where a copy lives outside the agent: a vendor export, the owner's own SMS thread, and pocketBrain's own `log/reads.jsonl` and `log/writes.jsonl`, which record every brain call.

## 6. Instruction block (add to each agent's instructions)

> At the end of each day, archive your conversations with the owner and anything you did on your own: call `log_session` (or POST `/v1/logs`) once per conversation or run, with a stable `log_id` (the same id if you send it again), the `date`, `kind` (`conversation` or `activity`), `channel`, a short `title`, and the turns as `{role, at, text}`. Send what was said, not a summary. Only you and the owner can read it. Don't put card numbers, codes or passwords in it; they'll be blanked anyway. Writing to your log is not writing to the brain: facts still go through `remember` with a source.

## 7. Not built, on purpose

- **One agent reading another's logs.** A raw log carries everything its author saw, including values carved out of the reader's slice, so a slice that names another agent's logs would bypass carving. Facts from logs are shared through consolidation and the write path instead. **Decided by the owner, 2026-10-08: no.** Logs stay readable by their author and the owner only.
- **The leak tripwire on logs.** Agents read Gmail, so their logs will contain values outside their views (architecture 0.1: views don't hide Gmail). Since logs aren't shared, it would only make noise.
- **Automatic verbatim capture** (Messages database, Claude Code hook): listed above as next steps.
