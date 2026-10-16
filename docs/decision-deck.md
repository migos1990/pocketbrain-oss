# The decision deck

Everything that needs the owner, as cards he swipes through on his phone. When he doesn't answer, the hub decides the low-stakes ones itself, logs it, and one tap undoes it.

Why: your minutes are the scarcest thing in the system. An inbox you have to read is a chore; a deck you can clear in the queue at the café is not.

## Using it

Open `/deck` in the dashboard (`pocketbrain dashboard`, then the Decide tab, or straight to `http://127.0.0.1:8788/deck`).

- One card at a time. Swipe right for the first answer, left for the second, up for Later. Every answer is also a button, and the arrow keys work on a computer.
- Each card shows the evidence underneath the question: both sides of a conflict with their sources and dates, the value and source of a proposed fact, the last time a fact was checked.
- Later hides a card for `snooze_hours` (4 by default). It never moves the hub's deadline, and it doesn't count as an answer.
- Private and money cards show no values; open the fact's page for them.
- After an answer, a one-line confirmation, with Undo where the action can be undone.
- The header counts what is left, what you cleared today and how long it took, and how many days in a row you opened the deck and found it empty.

### What the cards are

| Card | Right | Left | Hub decides if you don't? |
|---|---|---|---|
| Conflict | Keep what the brain had | Keep the challenger | Never: the hub can check that a cited message exists, not that it says what the side claims, so any pick would rest on the assistants' own word |
| New fact (proposal) | Keep it | Drop it | Lets it expire `proposal_days` (14) after it was filed and the hub first saw it, only for an outside assistant's proposal (not paused or read-only), not private, money, health or legal, and not citing your own word. The assistant can propose it again. Your own captures and imports never expire |
| Still true? (a fact past its shelf life; never a private, money, health or legal one) | Still true | Change it (opens the fact) | Never: it just stays marked as old |
| Held mail | Send it | Drop it | Never |
| Held capture | Let it in | Throw it away | Never |
| Your answer? (a relayed answer on a private fact) | Yes, that's my answer | No | Never |
| Alert, rules changed, account, upkeep | Look | | Never |

Private and money cards never get a deadline. Only an outside assistant's proposal can ever expire. The rule lives in code (`src/deck.ts` `verdict`), not in a prompt or a rules file.

## When the hub decides

The text channel's tick inside `pocketbrain start` (every 5 minutes) reads your replies first, then runs `runAuto` on the server's write queue, one write at a time with everything else the hub writes, and under the decide lock below. Anything you answered in that tick is skipped, even a reply that couldn't apply, so a text of yours is never overruled a moment later. A tick run on its own (`textline watch` or cron `textline once` beside the server) never decides for you. The hub decides only one kind of card:

- **An outside assistant's proposal** whose `proposal_days` have passed is rejected (moved to `inbox/decided/`), by `auto-decide`. Rejecting only leaves the brain as it was; the assistant can propose it again.
- It never expires a proposal that is private or money, reads like health, legal or money (English or French, on any note), cites your own word (your message, your texts, your notes, or one waiting on `owner_message_registered`), came from your own material (captures, imports, the Gardener), or whose assistant is paused, read-only or no longer in the policy. The card says why in one line.
- **Conflicts always wait for you.** What makes a side look stronger (verified, its date, which message it cites) is written by the assistants themselves, and the hub can check that a cited message exists but not that it says what the side claims. So it never picks.

Every decision is a line in `log/auto-decisions.jsonl`, a line in the next digest, and a row in the deck's "Decided for you" list with an Undo button. Undo reverts the hub's commit as you, which touches only the inbox, so it works whatever changed on the note since. The card comes back and the hub never decides that item again.

A deadline never starts before the hub first saw the item (`log/deck-seen.json`), so a proposal older than this feature still gets its full `proposal_days`. While a card can't be decided (deciding is off, its assistant is paused) that clock is cleared, so once it can be it gets the full notice again. No assistant may be named `auto-decide`: the policy won't load and `pocketbrain add` refuses it, because that name marks the hub's own commits.

`pocketbrain deck auto` runs the same step by hand, only when the hub isn't running on this machine (it refuses if the health URL answers); `pocketbrain deck` prints the cards. Every process that decides, the hub's tick or `deck auto`, first takes one lock file (`.git/pocketbrain-decide.lock`, `src/filelock.ts`), so two never settle the same item at once: while one holds it, another decides nothing that round (`deck auto` says another process is deciding). A lock left by a process that died, or older than 10 minutes, is taken over.

### The morning swipe

Each fact a source pull or a capture proposed is its own card, tagged with where it came from ("From granola", "From gmail"): the fact, its source, and the exact words it came from. Swipe right to keep it, left to drop it, Fix it to open the fact's page and set it yourself, up for Later. A private or money fact shows neither value nor quote. The seconds you spend on these cards are logged (`log/deck.jsonl`), and `pocketbrain fill` grades them against the 2-minutes-a-day target. These proposals never expire on their own: they come from your own material.

### Settings (rules/escalation.yaml, owner only)

```yaml
auto_decide:
  off: false          # true: the hub never decides; every card waits for you (conflicts always do)
  proposal_days: 14   # an unanswered proposal expires after this; at least 3
```

`auto_decide` must be a map. Anything else (`auto_decide: off`, `false`, a list) means off.

## On the phone

The dashboard stays loopback-only in this change. Reaching it from the phone over Tailscale is a separate change with its own audit (a tailnet listener for the dashboard). Until it lands, the deck works on the Mac, and texts carry no link to it. The link comes back with that change, which must refuse a public Tailscale Funnel host and the hub's own public door.

Why Tailscale and not a signed link in the text: a link in a text is a bearer key that sits in a message history and in Instinct's context, and anyone holding it could release held mail. Tailscale admits only your own signed-in devices and adds no door to the internet.

## How it looks

The page is `src/dashboard/html-deck.ts`, in the hub's "Message" direction: one column of at most 680px, the system sans at 17/28, warm greys, the accent only on links, text buttons and focus. The contract it renders is `src/dashboard/deck-types.ts`.

- One card at a time, a flat surface with a 1px hairline border and a small radius; the next one peeks behind as a line. The header shows how many are left, a grey bar that fills across the day, cleared today with the minutes it took, and the streak.
- The card's label ("Conflict", "From granola") is muted 15px text above the question; a quoted source line sits behind a 2px left hairline, muted, clamped to three lines, with no quote marks added.
- The evidence scrolls inside the card. A vertical drag on the evidence scrolls; on the question it is the up swipe.
- Every choice is a real form, so the page works without script. All choices are equal: accent text at least 44px tall, none filled, none primary. Fix it, which opens the fact's page and is bound to no swipe, is a plain link after the others.
- Colour means state only: the drag cue (the choice the swipe will take) shows in good, bad or neutral at the card's top edge while the finger is down, an error line is red, and nothing else is coloured at rest. Pink is for the logo.
- The card follows the finger with at most 6° of rotation and flies out in 180 ms ease-out; with reduced motion it neither rotates nor flies.
- Dark mode follows the system, or `data-theme` on the root, with the same tokens as the hub.
