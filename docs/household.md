# Household brain: a second owner for shared areas

A partner's assistant should know the kids' pickup time the owner changed this morning, and the owner's assistants should know what the partner changed, while the partner's assistant never sees the owner's work, money or health notes. A co-owner is a second owner for named areas of the same brain: their word counts like the owner's there, and nowhere else. Code: `checkCoOwners` and `coOwnerOf` in `src/rules.ts`, the write path in `src/write.ts`.

## Setting it up (owner only)

Only the owner edits `rules/`, so only the owner names a co-owner, in `rules/policy.yaml`:

```yaml
areas:
  household: { owner: steward }
agents:
  sam-assistant: { tier: core, slices: [area:household] }
co_owners:
  sam: { name: Sam Roy, areas: [household], agents: [sam-assistant] }
```

Her assistant connects the usual way (`pocketbrain invite sam-assistant`, or the sign-in door).

## What always holds

Whatever else `policy.yaml` says, `loadRules` enforces for a co-owner's assistant:

- **Only her areas.** Its slices are cut to `area:<her areas>`; anything else (`all`, other areas) is dropped. A note outside them answers like a missing one.
- **Personal at most, never money.** Private and secret notes and facts are carved out.
- **None of the owner's roles.** Not the resolver, not the owner's channel or editor, not the agent that takes the owner's captures (the owner's channel, else the resolver, else `instinct`), not inside the wall, no gardener role, and no area owned outside her areas. Each co-owner area must exist; an agent belongs to one co-owner, can't be named after an area outside hers, and can't also be a collaborator (a guest, `docs/share.md`). A policy that breaks this doesn't load.
- **No actions.** Her assistant never keeps an `act` block (`docs/act.md`), so it can't ask the hub to send mail, even though every mail would wait for the owner. A conservative default the owner can loosen later.
- **Her slice can't be redefined.** `rules/slices.yaml` may not define `area:<a co-owner area>`, so a slice entry can't widen hers to other areas.
- **Ask to see stays inside her limits.** When `ask_to_see` is on, her assistant can only be offered notes in her areas, personal at most, never money, and an approved read is checked against those limits again when it is handed over.

## Her word

Her assistant reports what she said the way any assistant reports the owner's word: `verification: confirmed-by-owner`, citing an owner ref (`owner:<date>/<channel>`). In her areas, from her own assistant, the write path records that as her word:

- `verification: confirmed-by-co-owner`, `co_owner: <her id>`, and the source becomes `agent:<her assistant>`. No owner ref is stored and nothing enters the owner's message registry, because other code reads owner refs as the owner's own word.
- Her assistant writes directly in her areas, without area-owner routing (a trial assistant's writes are proposed, as for any trial agent). Outside them its writes are refused (`co_owner_area`), never proposed, even when her assistant is on trial. So is asking to move a note to an area outside hers.
- A fact on a shared note that her assistant can't see (a private fact of the owner's, say) is never touched by her word, as for any assistant: a retract answers like a missing fact, and any other write waits in the owner's inbox with one fixed reply (invariant 3).
- When her assistant confirms a value another assistant wrote, the record keeps `confirmed_by: <her assistant>`, so it counts as her word.
- When the owner accepts a trial assistant's proposal, that accept is his word; her message still never enters his registry.
- The nightly pass puts her old word up for review, like the owner's, instead of forgetting it.
- No agent can write the `confirmed-by-co-owner` label itself: it isn't a verification an agent may send.

## Two owners, one fact

On a fact in a shared area:

| What happens | Result |
|---|---|
| One owner's word, then the other's with a newer `as_of` | The newer word holds (step 4); the old value goes to history with who replaced it. Either way round. |
| The two owners say different things as of the same day | A dispute, never a winner. |
| An assistant (hers included) retracting either owner's word without an owner's word | Proposed to the owner's inbox (`owner_word_retract`); the word stays. Either owner's word can take back the other's. |
| An assistant's value against either owner's word | A dispute, held for the owners (step 6); it never replaces their word. Two exceptions for now, being fixed for every owner's word (gap G163): a more precise date (`2026-11-05` against `2026-11`) replaces it, and so does a newer value of a `merge: max` or `min` attribute (such as `last_contact`). The resolver can't settle it against her word with its own evidence; only an owner can. |
| The owner confirming the value she set | The record becomes his word (`confirmed-by-owner`, his ref), so it stays his word if the note leaves her areas or she stops being a co-owner. |
| A `confirmed-by-co-owner` label written by hand, by an agent that isn't hers, or outside her areas | Worth no more than its sources (rank 2 at most). |

Standing (`docs/standing.md`) is separate: being a co-owner gives her word rank in her areas only, and standing still grants nothing.

## Not built yet

- Her own dashboard, kill switches and text channel; disputes in her areas reach the owner's digest only.
- Two hubs, or a household shared across two owners' separate brains.
