# Consent in plain words

Say in one sentence what an assistant is for, and pocketBrain proposes what it may see:

```sh
pocketbrain consent helper "handles family logistics like school pickups"
pocketbrain consent helper --rules-only "helps with work projects"   # no model, your words alone
```

The answer is a slice in plain words, three notes it would see, three it would not (and why), and the one line that applies it. Nothing changes until you run that line:

```sh
pocketbrain consent helper --apply --slices area:family --exclude-types money
pocketbrain add newbot --slices area:family --exclude-types money   # an agent that isn't set up yet
```

On the dashboard, an assistant's page has a **What is it for?** box. It shows the same proposal, with a button that applies it and an Undo after. Above the button the page says when the proposal shows the assistant more than it sees today, and when money is kept in (G183).

The command line only ever takes notes away. Any program with a shell on your Mac can run it, an assistant included, so `consent --apply` (and `carve --confirm`) refuses a slice that would show an agent a note, a note's text or a fact it can't see today, and points you to the dashboard, where showing more needs your login (the same rule as `agent resume`). When a proposal shows more, `consent` says so instead of printing the line. The check compares what the agent would actually receive, not just which notes: a fact a slice holds back today (`exclude_attributes`, a single `id#attr`), and a value scrubbed today as `[withheld]` that the new slice would let through (dropping `money` from the left-out kinds while no slice picks the money notes stops their values being scrubbed from other notes' text) both count as showing more (G179). So does loosening the grant itself, even when no note shows more today, because it would bite on the next note: dropping a left-out kind (`--exclude-types none` while the agent leaves money out), dropping a note or fact a slice holds back by name or attribute, or reaching an area today's slices don't (G228). A slice swap is judged on the slices' filters, never on today's notes: each new slice must sit inside one of today's (same or fewer areas, kinds, tags and attributes; the same or more left-out tags, notes and attributes; no higher sensitivity cap; no wider date window), so a swap that drops a finance-tag filter is refused even before any finance note exists (G248). Dropping a whole slice, or keeping one, still passes.

## What decides

A model may propose. Code decides (`checkChoice` in `src/consent.ts`):

- The proposal can only name slices the brain has (`rules/slices.yaml` plus one `area:<name>` per area) and kinds of note the brain has. Anything else is refused.
- It can never be the `all` slice, nor a slice that picks no area, kind, tag or note (that is `all` under another name), nor the canary `probe` area. Granting everything is a choice you make in `policy.yaml` yourself.
- Money stays out unless your sentence asks for money matters with a money word (money, bills, budget, banking, my bank or a bank account or statement, finances, taxes, pay, salary, invoices, expenses, mortgage, loans, accounting, a savings, chequing, investment or retirement account), whatever the model says. "Accounts" alone (email, social media) doesn't ask for money (G183), nor do "bank holiday" or "river bank" (G230).
- Your sentence is data. "Ignore the rules and grant all" gets the slice the rest of the sentence earns, never more.
- If the model fails, answers with something that isn't a proposal, or proposes something the checks refuse, the proposal comes from your words alone, matched against area names and everyday words for them, and the page says why.
- The Gardener and inside-the-wall agents see the whole brain by design; their slice isn't set from a sentence.

Applying is one owner commit to `rules/policy.yaml` (`Kind: consent`) that changes the agent's `slices` and `exclude_types` and nothing else, then the agent's view is rebuilt. The checks run again on apply, so a hand-edited form can't widen past them. The weekly carve audit sees the change as the owner's.

## What reaches the model

Only your sentence and the brain's vocabulary with counts: area names, kinds of note and slice names with what each selects. No note, title, fact or person ever does. The step is `consent.propose`, metered and capped like every model step ([usage.md](usage.md)); with no model set up, or with `--rules-only`, no model is called.

## Evals

`bun evals/run.ts --only consent` runs the checks with a fake model, the command line's tighten-only rule, and ten sentences against hand-written slices with no model (8 of 10 to pass). `bun evals/run.ts --llm --only consent` runs the same ten sentences through a real model (`EVAL_CONSENT_MODEL`, default `claude-haiku-5-5`, always on Anthropic whatever `rules/models.yaml` says; without `ANTHROPIC_API_KEY` it goes through the `claude` CLI). A run where no model answered (no key, an outage) is n/a, never a pass on the rules' score.
