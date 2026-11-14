# The relay: agent-to-agent messages, checked

A message that reaches the relay (mail to `relay+<agent>@…`, or a bridge calling `relay --check`) is checked against the **recipient's** slice in code, then delivered or held for the owner, and recorded in `comms/<date>/`. The check doesn't depend on an agent following instructions. Agents that talk some other way, in their own apps, are not checked. The relay is off until `AGENTMAIL_RELAY_KEY` is set.

## What it checks

In order, on the subject and text (after undoing spacing tricks, look-alike letters and encodings):

1. **Canaries** from `rules/relay.yaml`: proof of a leak, with an alert.
2. **Values the recipient can't see**, including reformatted amounts and distinctive fragments, each field of a value made of parts (a split's amount and who it's with) and the other names of a page it can't see: held, with an alert. The list is `hiddenNeedles` in `src/needles.ts`, the one the act door uses (G656). A value counts only when its note was left out on purpose (a type not shared, excluded by name or tag, above a sensitivity limit) or the fact is hidden; a note merely outside the recipient's areas doesn't count. `carve()` marks this with a `purposeful` flag, never by reading the reason text.
   **A page the recipient may not see, named** by its id, its title or the last part of its id: held, with an alert (`hiddenNames` and `findNamed` in `src/needles.ts`, G254). Only a page carved out on purpose counts, as for values; a page merely outside the recipient's slices doesn't. A name is matched as whole words in order, in any case, with spaces, dashes, slashes or nothing between them, so a page titled "Main bank" doesn't hold "remain bankrupt". A one-word title, or a longer one run together as one word, counts only where the text writes it with a capital and the recipient isn't shown that word anyway: a page titled Compensation doesn't hold "executive compensation committees". Never a name under six letters, a date, or a part of a title. Emphasis marks, a tag or a zero-width character inside the name don't hide it. A name spelled out letter by letter, broken by a comma, brackets or another word, or written with look-alike digits gets through, where a value would not: a false hold stops all of a sender's later handoffs until you look, so a name is held on less than a value (rows in `test/contracts/relay.contract.test.ts`).
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

Every record in `comms/` is committed to the brain's git, so what the sender wrote (subject, text, addresses) is redacted with the write path's secret shapes before it is written: a secret becomes `[removed: secret-shaped]`. The message id is not: it is kept exactly as sent (G313), so a soft shape in it, such as a card-number-shaped run, is committed as sent (G338); that can't stop a backup, which refuses hard secrets only, and an id carrying part of a hard secret is hashed (below). The checks run on the raw message first, so a message carrying a secret is still held with an alert. The reasons are redacted too, since some quote the sender (a money ask quotes a few of its words, G280), and so is every alert, in `alert()` itself. Then the whole record is scanned, because a private key or another hard secret split across fields (the BEGIN line in the subject, the body in the text) passes each field alone. It is cleared in steps, stopping at the first that leaves no hard secret: the message id, when it carries part of a hard secret, is replaced by `id-` and a hash of it (only the id; an id is otherwise kept exactly as sent, never run through the broader shapes, so two ids never share a record, G313); then the subject, text and an unresolved sender address are blanked; then the reasons. `from` and `to`, when they are agents the relay resolved, are never blanked, so a held one can still be released (G284). When redaction changed a held message, the sender's original subject and text wait outside git in `.git/pb-held/` (mode 600), and releasing it forwards the original (G243). Release or drop deletes it, and each relay pass sweeps originals whose record is no longer held (G285). Originals are not in backups: after a restore or a hub promote, releasing forwards the redacted text. (G201: one secret-shaped string from any sender used to stop every backup.)

Held mail waits in `comms/` with its reasons. The digest lists it under "Needs you"; the owner answers it on the home (its settle screen, `/settle/m-<id>`, docs/owner-home.md) or with `pocketbrain relay --release <id>` / `--drop <id>`.
