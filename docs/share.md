# Sharing a slice with a person

A collaborator, a co-teacher or a partner on one project, can have their own assistant read one
slice of your brain, live, until a date. Code: `src/share.ts`; the limits are enforced in
`loadRules` (`src/rules.ts`), so a hand edit to `rules/policy.yaml` can't loosen them.

## Share, extend, end

```
pocketbrain share add alice --name "Alice Roy" --slices area:work --days 30
```

That prints what Alice's assistant would see, from the same carve the server applies, and writes
nothing. Run it again with `--yes` to share. The yes is one owner commit (`Kind: share`), so git
is the record of what you shared, with whom, and until when.

Her assistant then connects the usual way: a one-time code (`pocketbrain invite alice --url
https://brain.example` for a share of one area; a wider share's code comes from **One-time code** on
alice's dashboard page, and `share add` says which), or, with the sign-in door, her own account
(`pocketbrain oauth coworker add <subject> --name "Alice Roy" --agent alice`, see `docs/oauth.md`).

- `pocketbrain share list`: who you share with, which slices, until when.
- `pocketbrain share extend alice --days 14`: push the date (from the later of today and the old date).
- `pocketbrain share end alice`: ends it now. Her keys are revoked, her sign-ins unbound, the agent
  paused. The entry stays in `policy.yaml` with the day it ended. The share is ended, the agent
  paused and her sign-in let go before the keys are revoked, so if the keys can't be revoked yet
  (another one-time code is being redeemed; the command says so and exits 1) the share is still
  over; run it again to revoke the keys (G352).

The morning digest lists active shares and those that ended in the last week, under Numbers.

## What always holds

Whatever `policy.yaml` says for an agent with a `collaborator:` entry:

- **Read-only.** Every write (`remember`, `retire`, captures, logs) is refused. Unpausing it in the
  dashboard brings it back to read-only, not active.
- **Paused past its date**, and once ended: no reads at all. Nobody has to remember to turn it off.
- **Personal at most.** Private and secret notes and facts are carved out, even in a slice it holds.
- **No money**, and never the `all` slice (it is dropped).
- **Not the resolver, not an area owner, not inside the wall, not the owner's text channel, and not
  named after an area.** Loading the rules fails until fixed.
- **A date that isn't YYYY-MM-DD** (a hand edit) counts as past: the share is paused.
- **No memory sync, and not your assistant.** It isn't quizzed (by the weekly pass, the belief radar's Fix everywhere or any other path), sent a change feed, or asked for a memory dump; its memory is the person's. It isn't in the belief radar or under Your assistants on the home (`ownAssistant` in `src/rules.ts`, G529). Any
  read-only agent's memory dump keeps nothing.
- **No ask to see.** It can't ask you for notes outside its slice; its slice is the whole deal.

`share add` and `share extend` take 1 to 180 days per step; extend if the work goes on. A date you edit by hand is honoured as written if it is a valid date that hasn't passed.

The red-team cases `rt-collaborator-oversharing` and `rt-collaborator-hand-edits`
(`evals/cases/redteam.ts`) hand-widen a share to core, secret and `all`, and try the hand edits
above, checking each against the leak oracle and the brain's git log.
