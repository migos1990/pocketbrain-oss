# The relay: agent-to-agent messages, checked

A message that reaches the relay (mail to `relay+<agent>@…`, or a bridge calling `relay --check`) is checked against the **recipient's** slice in code, then delivered or held for the owner, and recorded in `comms/<date>/`. The check doesn't depend on an agent following instructions. Agents that talk some other way, in their own apps, are not checked. The relay is off until `AGENTMAIL_RELAY_KEY` is set.

## What it checks

In order, on the subject and text (after undoing spacing tricks, look-alike letters and encodings):

1. **Canaries** from `rules/relay.yaml`: proof of a leak, with an alert.
2. **Values the recipient can't see**, including reformatted amounts and distinctive fragments: held, with an alert.
3. **Categories withheld from either side** ("bank" when money is withheld), and money questions with no category word: held.
4. **Secrets**: held, with an alert, whoever the recipient.
5. **Text that tries to instruct the recipient**: held, with an alert.

A paused agent sends and receives nothing; a read-only agent receives but can't send.

## By mail (AgentMail)

Give each agent its own AgentMail inbox and block the inboxes from each other: `pocketbrain relay --block-plan` prints the lists, which you apply with the admin key. Until you do, agents can mail each other directly. The AgentMail path has not run against a live account yet. Agents write to `relay+<agent>@…`; `pocketbrain start` runs a pass every minute when `AGENTMAIL_RELAY_KEY` (a key scoped to the relay inbox only) is set. `pocketbrain relay` runs one pass by hand, with the file transport (`relay/incoming/*.json`) unless `--agentmail` is given.

## From another channel: `relay --check`

A bridge that carries agent messages some other way (a group chat, a webhook) asks the relay before delivering:

```sh
echo "I booked the table for Friday at 7" | pocketbrain relay --check --from town --to instinct --via group-chat
{"id":"hook-…","deliver":true,"reason":"delivered"}
```

- Both agents are named as in `rules/policy.yaml`; neither needs an AgentMail address.
- It prints the verdict as one JSON line and exits 0 to deliver, 1 to hold (2 on a usage error). **The caller delivers or drops**; the relay sends nothing itself.
- A held message prints only `"reason":"held for the owner"`, with no alert flag. The real reasons name the hidden value and its note, so they stay in `comms/` for the owner.
- Delivered-or-held is itself an answer a sender could probe with guesses. So once a sender's message is held **with an alert**, every later hook message from it is held too until you release or drop that one. A handoff held with an alert counts the same, and the other way round (docs/handoffs.md). A guessing agent gets at most one hit, and you are alerted on that hit.
- Text from or to an unknown or inside-the-wall agent is refused and not kept.
- `--from` is whatever the bridge says. Anyone who can run `pocketbrain` on the hub's machine can already read the brain folder, so the bridge is trusted like the owner; keep it on that machine. A bridge that runs as a separate, less-trusted process needs its own key first (gap G31).
- Every message is recorded in `comms/` with `via: hook:<label>`. A held one shows in the digest like held mail, and one with an alert (canary, hidden value, secret, injection) raises the same alert. A hold without an alert sends the owner nothing on the spot: there is no mail to send it to, so it waits in the digest.
- Paused agents, and read-only senders, are held.
- `pocketbrain relay --release <id>` or `--drop <id>` records the owner's decision on a held hook message, but can't deliver it: the bridge has to resend it.
- Rate limits (such as a cap on agent-to-agent hops an hour) belong to the bridge.

## Held messages

Held mail waits in `comms/` with its reasons. The digest lists it under "Needs you"; the owner releases or drops it from the dashboard or with `pocketbrain relay --release <id>` / `--drop <id>`.
