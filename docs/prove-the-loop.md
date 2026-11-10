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

A stale or due row also says why, and that nothing asks you about it, for example `next_step is stale: the agent would serve an old answer; its date passed 9 days ago; it waits under the Brain's To recheck, nothing asks`. The causes are: its date passed, its review date passed, last checked N days ago against its shelf life, no date in it ends it, it names a date but its attribute doesn't end on one (only `next_step`, `due` and `deadline` do), or it was confirmed since its date.

The output names ids, ranks and freshness only, never a question, an answer or a value. Asking doesn't count as the assistant's reads, so its read counts and brain-first stay its own. The sample brain (`examples/brain/evals/weekly.yaml`) carries five synthetic questions. With `PB_BRAIN` set, the eval run checks the owner's file the same way, on a copy of the brain, as `e2e-loop-golden-owner-<id>`.

## Usefulness

One number every change has to move (plans/next-level.md, move 1): how many questions each assistant can answer from what it gets back, in how many tokens, and how much of that is noise. `pocketbrain usefulness [agent] [--counts] [--json]` (src/usefulness.ts) asks each question through each assistant's view, by three doors, because assistants use all three. The door assistants use most comes first, and its line is the number to steer by (CEO review, 2026-11-09: on the owner's brain, 335 `memory_check` calls and 203 reads against 25 context packs in 14 days). The number is printed only, never a merge block:

- **memory_check, then read 3**: the change feed the assistant's next `memory_check` would hand it (built without logging or opening a feed, `previewFeed` in src/memsync.ts), then up to three of the notes it points to, those sharing the most words with the question. The feed doesn't depend on the question, so this door says how often what assistants already read answers what they get asked; before an assistant's first `memory_check` it gives nothing.
- **context pack**: one `context_pack` with the question as its topic;
- **search, then read 3**: the `search` hits, then the top three notes read by id.

A question is **answered** when everything it needs is in what came back: each named fact's live value (a list, every live item; a fact two sources contest, by a dispute on the fact or by a `contested:` key on its live record, must not be served as current), each phrase, and each note as a note (its own `### Title` block, whole or as its facts; a golden `want` note with its `expect` fact in that block). A note only named, on a link, a `Connected:` line or the pack's also line, is a **pointer**: the counts say how many more questions only pointed to what they needed, apart from the answered ones (G768). **Tokens** are characters / 4, as the context budget counts them. **Noise** is the share of those tokens in notes that hold nothing the answer needs (the pack's head counts as noise too).

The questions come from four places:

- `$PB_BRAIN/evals/usefulness.yaml` (or the file `PB_USEFULNESS` names), written by the owner: `{ id, q, facts: [<note id>#<attribute>], says: [<words>], notes: [<note id>], as: [<agent>] }`, any of facts, says and notes;
- the brain's golden files, `$PB_BRAIN/evals/weekly.yaml` (above) and `$PB_BRAIN/evals/retrieval.yaml`: one of `want` must come back, showing `expect`, and `answer` must be in it;
- what assistants really asked: up to ten topics from the reads log (`log/reads.jsonl`), each with the notes the assistant then read by id within ten minutes (what it went to get), else the first note the pack gave it. The sample is drawn by the month: the same all month, another the next.

Nothing it asks is logged as the assistant's read, and nothing is written. `--counts` prints counts, tokens and noise only, never a question, a note or a value. `bun scripts/usefulness.ts` runs the twenty-five synthetic questions of `evals/fixtures/usefulness-demo.yaml` on the demo brain, where each assistant made its first `memory_check` before the week, so the memory_check door has the week's changes to score; `--compare evals/baselines/usefulness.json` prints the change from the saved run, and the merge gate prints both, so a branch says which way it moves the number. `bun scripts/usefulness.ts --brain <path>` measures a real brain on a clone in a temporary folder (with its reads log and memory-sync log), counts only, and adds which tools assistants called in the 14 days up to the last one logged. `--shapes` adds the context pack in four shapes side by side for each assistant, answered, pointed to and median tokens: eight whole notes (the pack before G768), three whole and five named on a line, today's shape, and today's without a fourth to sixth note that matched more weakly than the first (G776, open), so a change to the pack's shape picks the leanest one that loses no answer; `--lost` adds each question eight whole notes answer and today's pack doesn't, as the assistant, the set, its place in the set, and where its note was and is now (whole, facts only, named on a line, absent), never the question. Two lessons from choosing the shape (2026-11-09): the demo brain's pages are short, so every shape answered the same there while the owner's brain lost eight answers with three whole notes; a shape is chosen on a real brain's run. And the strict count is the one to steer by: on the owner's brain it restated the starting point lower than the first, generous count.

## Stale answers

A fact with an end date stops being the answer once that date has passed, however recently it was written. `next_step`, `due` and `deadline`, and any attribute with `shelf_life: until_date` in `rules/checks.yaml`, read the dates in their value: ISO (`2026-10-15`), `Oct 14` or `14 octobre`, with or without a year. A date without a year is in the year the fact was written, or the next one if that would put it more than 60 days earlier. Once the latest date is before today, the fact is **stale**: every door labels it so, the agent is told to check it before stating it, the owner gets a "Still the plan?" card for a project's next step (docs/decision-deck.md), and the golden set fails it. `e2e-loop-stale-plan-not-current` checks this.

## Demo script

The same loop, live, in about two minutes:

1. Show the dashboard: the two assistants and what each one holds.
2. In Town, forward or paste the email about the room change and say "remember this".
3. On the dashboard, accept the change from the inbox. Point at the source line.
4. In Instinct, ask "which room is TECH 101 in now?". It answers Hall C305 "from your brain".
5. Ask one golden question in each assistant and show that both give the same answer.
