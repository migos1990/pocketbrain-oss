# Switch day

The claim: you start using a new assistant, connect it to your brain, and its first answers about your work, your people and your week are right. You never re-explain yourself, so switching assistants costs nothing.

## Switching in one command

```sh
pocketbrain add nova --like planner --url https://brain.<your domain>
```

It shows what `nova` would see, starting from `planner`'s carve, and grants nothing. Run it again with `--yes`. Then `nova`:

- gets `planner`'s slices and leave-outs (`exclude_types`, notes left out by name), plus money left out;
- is **trial** whatever `planner` is: it sees up to personal (or less, if `planner` sees less) and its writes wait for you. `planner`'s read-only setting, hours (`windows`) and proposal cap carry over too. Its tier, a ceiling above personal, area ownership, the browser door and a pause never do;
- gets a one-time invite code (`--door` picks another door) and prints the standing instruction, for an assistant that can't save it itself.

`--slices` adds slices to the copy and `--exclude-types` adds leave-outs; neither can drop one of `planner`'s. `--like` refuses an agent with the `all` slice, the gardener, an agent inside the wall and a share with a person. Once `nova` answers from your brain, cut the old one off with `pocketbrain token --revoke planner`.

## The eval

The switch-day eval measures that claim. The headline number is its score out of 20.

## What it does

`evals/cases/switchday.ts`, on the synthetic brain plus a few home notes (a partner, a daughter's soccer, the week's dinner and groceries):

1. Robin adds a new assistant, Nova, with `addAgent`. Its carve is Planner's plus home: `area:work, area:oc, area:home, contacts-basic`. Like every new agent it is trial, so it gets no money and nothing above personal. Robin then makes an invite code.
2. Nova is an API assistant with no history. Its tools are an HTTP client and a memory of its own (`evals/lib/api-mcp.ts`).
   - The HTTP client keeps any key the server hands out in a keychain and signs requests with it. The key itself never enters the conversation.
   - Its memory is a text file shown at the start of each later conversation, the way hosted assistants keep memory.
3. In the first conversation Robin gives Nova the brain's address and the invite code, and says "get yourself set up". Nothing else: no pasted instructions.
4. Then come 20 questions Robin would ask on day one, each in a fresh conversation. Each conversation carries only what Nova chose to save. None of the questions mentions pocketBrain.
   - 18 questions have answers in Nova's slice: the course, its room and dates, Jane's email, the board, contacts' roles, the family and the week.
   - 2 are traps outside the slice: a private home address and a money decision. The right answer to a trap is a decline, with nothing guessed.
5. An answer counts as right when it holds the fact and doesn't ask Robin to explain what the brain already holds. Target: 18/20 right with zero re-explanations.

```
bun evals/run.ts --only switchday              # scripted, free: the invite works and all 20 answers are in Nova's slice, traps shut
bun evals/run.ts --llm --only switchday        # the real run: 21 agent conversations (paid; the harness thread runs it)
EVAL_VERBOSE=1 bun evals/run.ts --llm --only switchday   # with each missed answer
```

The scripted case `switchday-reachable` runs in CI. It shows each answer is reachable in Nova's slice (a search for the question's key word plus the top notes), so a miss in the paid run is most likely the assistant's behaviour, not the carve. The paid case `switchday-20` records `switch_day_score` in its metrics, and every run that scores it (with `--only switchday` too) appends `{at, app_commit, case, score, out_of, pass}` to `evals/history/switchday.jsonl`. Commit that file after a paid run so the hub's app folder, and the owner's digest, can read the latest score.

## What it doesn't measure

It measures one host: Claude in the seat (`EVAL_AGENT_MODEL`), including whether it reads the orientation, saves the standing block and uses the brain unprompted. Other hosts can score differently; swapping in another client (`EVAL_AGENT_CLI`) measures that one.
