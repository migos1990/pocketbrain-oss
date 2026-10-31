# Prove the loop

pocketBrain is worth it only if this works every day: one assistant learns a fact, the brain keeps it with its source, and a different assistant, on a different door, answers with it. Two checks prove that. Both run with every eval run (`bun evals/run.ts --only e2e-loop`), on the synthetic brain, with no model calls.

## The loop

`e2e-loop-town-writes-instinct-reads` (evals/cases/loop.ts) sets up two assistants the way a real owner runs them: Town on MCP, and Instinct on the browser door only (docs/browser-door.md).

1. Town reads an email saying TECH 101 moves to Hall C305 from session 7. It calls `remember` on `projects/course-a`, attribute `room`, with the email as its source (`gmail:<id>`).
2. The work area belongs to another assistant, so the write waits in the owner's inbox. The owner accepts it.
3. Instinct signs in on `/b` and reads its change list, the note and a context pack for "TECH 101 room". All three show Hall C305 as the current room, with the email it came from. Hall B210 is history.
4. Town reads the note back and sees the same value.

If any step breaks (the write is lost, the owner's accept doesn't land, a door shows the old room or drops the source), the case fails and names the step.

## The golden set

`e2e-loop-golden-1` to `-5` are the owner's weekly questions. Each one names the topic an assistant would ask the brain and what a right answer must say. A case passes when Town's context pack for that topic holds the right note and the answer.

The five in `GOLDEN` are samples on the synthetic brain. The owner's own five live in the brain, never in this repository: `$PB_BRAIN/evals/weekly.yaml` (or the file `PB_GOLDEN` names):

```yaml
questions:
  - { id: w01, theme: <a word>, as: instinct, q: "<the question as the owner asks it>", want: [<note id>], expect: <fact key, or body> }
```

`pocketbrain golden [agent] [--file f] [--json]` (src/golden.ts) scores that file. For each assistant in `as` (or the one named), it asks the question through that assistant's view: one of the `want` notes must be in its top 5 search hits, and that note must show the `expect` fact (or have text, for `body`). An optional `answer` must appear in the fact. Each row is one grade:

- **pass**: found, shown, current.
- **watch**: found and shown, but due for a recheck.
- **fail**: not in the top 5, outside the view, not shown, the wrong answer, or stale or disputed.

A stale or due row also says why, and that nothing asks you about it, for example `next_step is stale: the agent would serve an old answer; its date passed 9 days ago; it waits under Needs a look, nothing asks`. The causes are: its date passed, its review date passed, last checked N days ago against its shelf life, no date in it ends it, it names a date but its attribute doesn't end on one (only `next_step`, `due` and `deadline` do), or it was confirmed since its date.

The output names ids, ranks and freshness only, never a question, an answer or a value. Asking doesn't count as the assistant's reads, so its read counts and brain-first stay its own. The sample brain (`examples/brain/evals/weekly.yaml`) carries five synthetic questions. With `PB_BRAIN` set, the eval run checks the owner's file the same way, on a copy of the brain, as `e2e-loop-golden-owner-<id>`.

## Stale answers

A fact with an end date stops being the answer once that date has passed, however recently it was written. `next_step`, `due` and `deadline`, and any attribute with `shelf_life: until_date` in `rules/checks.yaml`, read the dates in their value: ISO (`2026-10-15`), `Oct 14` or `14 octobre`, with or without a year. A date without a year is in the year the fact was written, or the next one if that would put it more than 60 days earlier. Once the latest date is before today, the fact is **stale**: every door labels it so, the agent is told to check it before stating it, the owner gets a "Still the plan?" card for a project's next step (docs/decision-deck.md), and the golden set fails it. `e2e-loop-stale-plan-not-current` checks this.

## Demo script

The same loop, live, in about two minutes:

1. Show the dashboard: the two assistants and what each one holds.
2. In Town, forward or paste the email about the room change and say "remember this".
3. On the dashboard, accept the change from the inbox. Point at the source line.
4. In Instinct, ask "which room is TECH 101 in now?". It answers Hall C305 "from your brain".
5. Ask one golden question in each assistant and show that both give the same answer.
