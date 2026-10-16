# Handoffs

One assistant starts a task, another finishes it: Town starts planning a weekend trip on the laptop, and Instinct picks it up by text on the road, from where Town left it.

Code: `src/handoff.ts`. Tests: `test/handoff.test.ts`.

## For an assistant

- **Hand off:** `hand_off` (MCP) or `POST /v1/handoffs` with `to` (the other agent's name), `task` (what's done and what's left, up to 2,000 characters) and `next_step` (one step, up to 500). Each is kept as one line: line breaks of every kind (control characters, NEL, Unicode line and paragraph separators) become spaces, so a handoff can't fake a second entry.
- **Pick up:** `whats_new` (or `GET /v1/changes`, field `handoffs`) shows handoffs to you first, under "Handed to you", until you close them.
- **Close:** `handoff_done` (or `POST /v1/handoffs/done`) with the handoff id. No note is kept.

On the browser door, What changed shows handoffs first, each with a Done button.

Hosts can't be woken, so the second assistant sees a handoff the next time you talk to it and it calls `whats_new`.

## What the hub checks

- **Relay checks.** A handoff goes through the same checks as relay mail against the recipient's slice: canaries, values it can't see, withheld categories, secrets, instructions aimed at the recipient. A handoff that fails is **held** for you, with an alert when the relay would alert.
- **Checked again when read.** A delivered handoff is checked again each time the recipient reads it, under the token it reads with (a reader token sees nothing above personal) and its slice as it is that day. Narrow an agent's slice and a handoff it may no longer see disappears from its `whats_new`. One you released yourself isn't checked against the slice again, but a reader token still sees it only if it passes the checks.
- **Secrecy.** A handoff that asks the recipient to keep something from you ("don't tell the owner", "without telling Sam" when the owner is Sam, "keep the owner out of the loop", "delete this handoff") is held. This is a word check, so it catches the plain ways of asking, not every one.
- **Request check.** With `relay: { classify: true }` in policy.yaml, a handoff between agents where either side has a withheld category is also read by the relay's request-check model (`relay.flag`), like relay mail. A hit holds it, and so does an answer the model can't give. The sender's reply doesn't wait for the model: the handoff is kept as "checking" (the recipient doesn't see it yet) until the check ends, so the reply's timing says nothing about the result. A handoff a hub restart left "checking" is settled when the hub starts again and in the night pass: checked again when the model is keyed, else held for you with "the request check didn't finish". With no model key the check is skipped, as it is for relay mail. Off by default (gap G26).
- **One hit, then held.** Whether a handoff arrived is something a colluding recipient can see, so once a sender has a handoff or a relay-hook message held with an alert, all its later handoffs and hook messages are held until you decide on that one: one hit across both channels. A sender gets at most 20 handoffs a day; the rest are held.
- **Trial agents.** A trial agent's handoffs are always held for you first.
- **Who can hand off.** A paused or read-only agent can't hand off, or mark a handoff done (that commits as the agent). Nobody can hand off to the gardener, to an agent inside the wall, or to itself.
- **Same answer either way.** The sender gets the same reply whether its handoff was delivered or held, so it can't use handoffs to test what the recipient may see.
- **No sender name.** The recipient sees "an assistant", like in `whats_new`.
- **Never in a view.** Handoffs are kept in `handoffs/<date>/<id>.md` in the brain's git. That is not a content folder, so no view, search, cell or context pack ever includes one. Only the recipient reads it, through the handoff tools.

## For you

```sh
pocketbrain handoff list           # held ones first (with why), then open ones
pocketbrain handoff release <id>   # the recipient sees it in whats_new
pocketbrain handoff drop <id>      # it stays out
```

The daily digest lists held handoffs.
