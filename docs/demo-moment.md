# The demo moment

The whole product in one minute (outside review, 2026-10-29): ask Claude about someone, get an answer that is right and shows it came from your brain; tell the brain one new thing on your phone, and Claude knows it a minute later. If this moment doesn't impress, no dashboard will.

## The script

Use a person the brain knows well. The examples below use Jane Roy from the sample brain; on your own brain, use someone with a page and a next step.

1. **Ask Claude**, in Claude Code or claude.ai with pocketBrain connected, without saying "pocketBrain":

   > What's next with Jane?

   Claude calls `context_pack` (its standing instruction says to, even unasked) and answers with what the brain holds, ending each fact with where it came from:

   > Your next step on TECH 101 is to grade the midterm by Oct 14, and Jane Roy is its coordinator (from your brain: TECH 101 fall 2026, Email 2026-10-01; Jane Roy, Email 2026-09-01).

2. **Ask about someone the brain doesn't hold**:

   > What's next with Zoe?

   The answer says Zoe isn't in your brain. It never answers from notes that only share the word "next".

3. **Tell the brain one thing on your phone**. Open the home page, and in the box type:

   > Jane Roy's next step is send the syllabus by Friday

   The box says "Noted" with Undo.

4. **Ask Claude again**, in the same chat or a new one:

   > What's next with Jane?

   > Send Jane Roy the syllabus by Friday (from your brain: Jane Roy, Your note 2026-10-29).

5. **Compare without the brain.** Ask the same question in a chat with pocketBrain disconnected. Claude doesn't know who Jane is.

## What makes it work

- **Every note in the answer has a Cite line.** `context_pack` adds `Cite as: (from your brain: <page>; <fact>: <source> <date>; …)` to each note, ready to paste into an answer. It names each fact's source in words ("Email", "Calendar", "Your note", "An assistant's memory") with its date, newest first, at most five. It never shows a raw id. The line itself is the instruction, so the pack's head is unchanged and still fits small context budgets. It is built from the facts the assistant can already see, so it tells it nothing new (`citeLine` in `src/core.ts`).
- **A name is checked before anything else** (G503). When the topic names someone (a capitalized word after the first, such as "Jane" in "what's next with Jane"), the pack keeps only notes that hold the name and the notes linked to or from them. The note the name is the title or an alias of comes first. A name no note in the assistant's view holds gets the line `No note about "Zoe" in your view.`, and no other notes. A hidden note answers exactly like a missing one, because only the view is checked (`namesIn` in `src/retrieve.ts`).
- **Told to known is one commit.** The box writes the owner's word at once (`write(…, { owner: true })`), and the next read rebuilds the assistant's cell because the brain's commit changed (`freshCell` in `src/cell.ts`). Nothing waits for the minute tick.

## Measured

| What | Command | Result (2026-10-29, synthetic brain) |
|---|---|---|
| Told on the box to known over MCP, cells on | `bun scripts/demo-moment.ts` | 230 to 370 ms, cited as "Your note" |
| Same, on a copy of a real brain, as an eval (no model needed) | `PB_BRAIN=<brain> EVAL_DEMO_ASK="what's next with <name>" EVAL_DEMO_TELL="<Full Name>'s next step is <something>" bun evals/run.ts --only demo-moment-real` | the same one JSON line of counts and milliseconds; n/a without the three variables |
| Same, on a copy of a real brain | `bun scripts/demo-moment.ts --brain <brain repo> --ask "what's next with <name>" --tell "<Full Name>'s next step is <something>"` | prints counts and milliseconds only, never a value; `--show` prints the Cite lines |
| With and without the brain, same questions | `bun evals/run.ts --llm --only demo-side --k 3` | Sonnet 5.5 and Haiku 5.5, 3 runs each: with the brain 4/4 right and 3/3 cited every run; without, 0/3 right |

On a copy of the real brain (2026-10-30, on the Mac, `demo-moment-real`): told to known in 765 ms, cited as "Your note", the absent name said, 0 commits to the real brain. On that Mac the eval run then exited 134 after printing its summary. That is most likely the ONNX Runtime abort at exit on macOS that `src/semantic-setup.ts` works around, and the result line printed before it stands.

The free checks (`bun evals/run.ts --only demo`) run in CI: the round trip under a minute with its Cite line, and the absent name. The side by side needs a model (`--llm`, cents). It grades by fixed words, not a judge: right means the expected words are in the answer (for an absent name, that it says so and names nothing else), and cited means the answer says it came from the brain ("from your brain", "her pocketBrain page") and names the page. Test: `test/demo-moment.test.ts`.
