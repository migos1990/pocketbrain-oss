# The act door: an agent asks to send a mail

The carve decides what an agent may **know**. The act door decides what it may **do**, for one action: sending a mail. The agent asks the brain to send it; the brain checks the request against that agent's limits, holds it for the owner, and sends it only after the owner approves it in the dashboard. Code: `src/act.ts`, with the screens in `src/needles.ts`. Tests: `test/act.test.ts`. `src/act.ts` is part of the access core: a change to it needs a `clear` slice audit at the merge gate, and its must-never rows (no send without the owner's approval, one approval sends once, a stopped agent can't ask, no withheld value in a mail, an offboarded coworker's mail is cancelled) are its contract suite, `test/contracts/act.contract.test.ts`. Evals: `evals/cases/act.ts` (`bun evals/run.ts --only rt-act`).

In this version the only transport is **fake**: a sent mail is one line in `actions/fake/sent.jsonl` in the brain folder, which the brain's git ignores. Nothing leaves the machine. A real mail transport is the owner's later call.

## Turning it on

An agent has no actions until the owner gives it an `act` block in `rules/policy.yaml`:

```yaml
act: { max_per_day: 10 }          # owner-wide: mails sent in 24 hours, all agents (default 10)
agents:
  town:
    act:
      send_mail:
        to:
          - { to: landlord@example.com, label: the landlord }
          - { to: "@plumber.example", label: the plumber, max_sensitivity: personal }
        max_per_day: 3            # this agent's mails in 24 hours (default 3)
        max_requests_per_day: 10  # every request, refused ones included (default 10)
```

- An entry is an exact address, or `@` plus a domain. A domain entry matches that domain only, never a subdomain (`x@mail.plumber.example` is refused).
- `label` is the name the owner's texts use ("Town wants to send a mail to the landlord"). Without one the text says "entry 2 on its list".
- `max_sensitivity` raises the outward screen's ceiling for that recipient (default `public`, see below).
- `loadRules` checks the block. A block that isn't a list of entries, an entry without its `@`, or a cap that isn't a positive whole number is dropped (no actions) and shown by `pocketbrain doctor`. A shared mail provider as a domain entry (`@gmail.com`, `@outlook.com`, `@icloud.com` and the like) stops the rules loading, with "list the exact address instead".
- `loadRules` also drops the block, whatever it says, for a collaborator, a co-owner's assistant (`docs/household.md`; the owner can loosen this later), the gardener (any `role`), the resolver, the agent that carries the owner's texts (`owner_channel`, by default the resolver), an `inside_wall` agent, and a paused or read-only agent.

## What the agent does

MCP `act` (or `POST /v1/act`) with `{ action: "send_mail", to, subject, body, why }`, then `act_status` (or `GET /v1/act/{request}`): waiting, approved, sent, declined, expired or cancelled. Both tools appear, and the orientation has a "Sending mail" section, only for an agent that has the block. The orientation gives the list's size, never its contents.

## The checks, in order

Every request from an agent with actions, refused or not, is a line in `actions/log.jsonl` and counts toward `max_requests_per_day` (an agent without actions is refused before that, with nothing logged).

1. **Allowed.** An active agent with the block, a token that isn't a reader token, on the hub (a replica refuses). Then the agent's `max_requests_per_day`.
2. **Latch.** After one tripwire refusal (check 6), the agent's requests are refused with a neutral reason until the owner clicks "Let it ask again" in the dashboard. A refusal is one guess at most.
3. **Shape.** `action` is `send_mail`; the subject one line, at most 120 characters; the body at most 4,000; `why` one line, at most 300. A mail holds only what the owner sees on the card, checked by allowlist: letters, numbers, punctuation and symbols in any script, up to two accents on a letter, one emoji presentation selector after a pictograph, space, no-break space (also the narrow one), the ideographic space, tab, and newlines (LF or CRLF) in the body. Anything Unicode marks as default-ignorable is refused even when it is a mark, and so are two characters that may draw as blank depending on the font (U+16FE4 KHITAN FILLER, U+1D159 MUSICAL SYMBOL NULL NOTEHEAD, re-audit S1 and S2), which covers the Mongolian free variation selectors and Khmer inherent vowels. Anything else is refused, never stripped, so the owner approves the bytes that would be sent: control and direction characters, zero-width and other format characters, tag characters and variation selectors (both can spell out text that draws as nothing), private-use and unassigned code points, line and paragraph separators, and the letters that draw as blank space (Hangul fillers, the blank Braille cell, the combining grapheme joiner) (G210, reopened and closed after the re-audit). Accepted cost: emoji joined with a zero-width joiner, keycaps and the Persian zero-width non-joiner are refused too.
4. **One at a time.** One waiting mail per agent, checked before the content, so with it filled every request gets the same answer whatever it holds (G211).
5. **Recipient.** The raw `to` must match `^[a-z0-9._-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$` (no display name, no `+`, no capitals, no look-alike letters, no line breaks, no `xn--` label, no trailing dot) and an entry. A refusal says only "not on your list (N entries)". Three in 24 hours alert the owner. Under a domain entry, a local part with more than 3 digits, or one holding a word the outward screen flags from a value the agent can see, is refused the same way. A word from a value the agent can't see is the tripwire (check 6), latch included, so a local part is one guess at most (G211).
6. **Tripwire.** A canary, or any value the agent can't see, in the address, subject or body refuses the request, alerts the owner (`act_tripwire`) and latches the agent. The values are `hiddenNeedles`: the union of the relay's set and the write tripwire's set (hidden notes at any level, hidden facts, object fields, aliases), matched by the shared matcher (spacing, case, zero-width and look-alike letters, base64, hex and URL encoding, reformatted amounts, a distinctive two-word part).
7. **Secrets.** `findSecret` over the subject, the body and `why` after `unhide`, plus card numbers with dots or slashes between the groups, and a bare private-key header (`-----BEGIN ... PRIVATE KEY-----`), which findSecret alone lets through. `why` is logged and shown, and a secret in the log would make the backup leave the whole log out (G212).
8. **Caps.** The agent's `max_per_day` (mails it queued in 24 hours); the owner-wide `max_per_day`, which counts only sent mail, so one agent's refused or waiting requests can't block another's.

Two more things are recorded but never refuse:

- **Outward screen** (`outwardScreen`): the subject, body and address against everything above the recipient's ceiling, each match with its note. A hit marks the item "carries values from …" and the matches are marked on the dashboard. The owner may well want to send his address to his landlord; he decides with the matches in front of him.
- **Flags**: a `why`, subject or body that claims the owner approved, or reads like instructions (`findInjection`), and one capitalised word of 6+ letters from a hidden value the agent can't see (one word of a name is often an everyday word too).

## Approval: the dashboard only

The item shows the hub's facts first (the agent, the list entry it matched, the checked address, today's counts, what it carries, the flags), then the agent's words, escaped and quoted: subject, body, why. **Send this mail** posts the action id and the hash the page showed. The server sends only if that hash is still the stored mail's hash: `sha256(JSON.stringify({v:1, id, agent, action, to, subject, body}))`. The same text under another id, or from another agent, needs its own approval.

Approve and send each re-run every check against the current rules and brain. A paused, read-only, revoked or role-changed agent, a coworker whose account the sign-in service reports blocked or deleted (docs/oauth.md offboarding; when the hub can't tell, nothing is sent or cancelled until it can), a recipient taken off the list, a cap reached, a new tripwire hit, or something new for the outward screen cancels the action with its reason. Revoke, pause, read-only (dashboard and `pocketbrain agent`), `token --revoke` and `share end` also cancel the agent's waiting mail at once.

A text never approves. The owner's text says only "Town wants to send a mail to the landlord (code 123456). Approve it in the dashboard": the agent's label, the entry's label and a random code, never the subject, the `why`, the body or the address, so nothing the agent wrote reaches the agent that carries the owner's texts. Both labels are free text, so the whole line gets the same instruction-and-secret check as proposal lines; if it fires, the text drops both and says "An assistant wants to send a mail (code 123456)". Any reply, from the owner's phone or relayed, may `reject` or `later` it, but only by its code: `reject 123456`, `later 123456`, and the text's hint says so. Replies on SMS and iMessage carry no thread, so a reply binds to the newest text; a bare or letter-only `reject` or `later` that lands on a mail may have been meant for an older text, so it does nothing to the mail and the hub answers once "Which mail? Reply reject <code>". A code that matches no waiting mail gets "no waiting mail with that code" and never falls back to a letter (G146). `approve`, `ok`, `yes`, with or without the code, answer "a mail is approved in the dashboard only".

## Once, and in time

`approved → sending → sent` runs under a lock file (`actions/lock`) and is chained in `actions/log.jsonl` before the transport is called; the transport keys on the action id. A second click or a second process never sends twice, and a restore that lost `actions/fake/sent.jsonl` doesn't resend, since the log says sent. Losing all of `actions/` loses the record too, and with it every approval: nothing can be sent without a new request and a new approval. A waiting mail expires after 24 hours; an approval not sent within 10 minutes expires and needs a new request.

## The log

`actions/log.jsonl`, hash-chained like the read log: requested (the only line with the body), refused (check and reason, never the text), approved, sending, sent, declined, expired, cancelled, failed, latched, unlatched. No agent route reads it: not `read_log`, not `search_logs`, not cells. It lives in `actions/`, hub state with a `.gitignore` of `*` (like `actions/fake/sent.jsonl`), so no mail body ever reaches the brain's git: not the relay's `git add log`, not the write path, not an owner commit. Encrypted backups carry it, like the other untracked state; no secret can get into it (check 7), and `pocketbrain drill` fails with LOST if a backup ever leaves it out.

## What it does NOT catch

The tripwire is a matcher, so:

- a paraphrase of a hidden value ("the big holding company");
- a value reversed, ROT13, leetspeak, one word per line, base64 split over lines or applied twice;
- digits spelled out ("four one two five hundred"), an amount written `412.500,00`, `$412.5k` or `0.4125M`;
- an address spelled out ("jdoe dot private at maple dot example");
- until the gaps thread's matcher fixes land (G113 to G115): a text with one malformed `%zz` escape anywhere (it switches off URL decoding for the whole text), HTML numeric entities, Greek capital and dotless-i look-alikes;
- the first word of a two-word hidden value alone (flagged, not refused);
- bits carried by choices that draw the same on the card: a no-break space instead of a space, or a Cyrillic look-alike instead of a Latin letter (about 42 bits in a 230-character paragraph). The card doesn't mark them yet (re-audit S3, a recorded limit).

That is one reason every mail waits for the owner, who reads the whole mail before it goes. The outward screen has the same limits for the values the agent may see. The rows are in `test/ceilings.test.ts`.

Accepted, by design: an agent can fill its own one waiting slot; a relayed text that quotes a mail's code can decline (never approve) it.
