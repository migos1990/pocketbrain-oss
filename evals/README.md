# pocketBrain evals

A runnable suite with a scorecard. It drives the prototype's code paths (view compiler, write path, conflict steps, relay, upkeep) and checks the result against a known right answer. It works on throwaway copies of a brain and never touches the real one.

```sh
bun evals/run.ts                      # deterministic suite, writes evals/out/scorecard.md
PB_BRAIN=/path/to/brain bun evals/run.ts   # adds the real-brain cases (copied, never modified)
bun evals/run.ts --ci                 # exits 1 on a regression; known gaps don't fail it
bun evals/run.ts --trend              # scorecard per commit, from evals/history/scorecard.jsonl
bun evals/run.ts --backfill           # run the suite on every past commit (git worktrees)
bun evals/run.ts --only relay         # one dimension or case prefix
bun evals/run.ts --compare det        # pair this run with a saved baseline; exits 1 on a regression
```

## Baselines and paired compare

A prompt edit can turn one case from pass to fail while the totals hold. So runs are saved as baselines and each case is paired with itself by id.

```sh
bun evals/run.ts --save-baseline det          # deterministic suite -> evals/baselines/det.json (committed)
bun evals/run.ts --compare det                # run, pair with det: flips, new and missing cases, verdict
bun evals/run.ts --llm --only agents --k 3 --save-baseline agents   # once, paid: real agents, 3 runs each
bun evals/run.ts --llm --only agents --k 3 --compare agents         # on every prompt or orientation change
bun evals/run.ts --llm --only agents-first-hour                     # a new assistant's first hour, six tasks scored (docs/add-an-agent.md)
bun evals/run.ts --compare-files evals/baselines/agents.json evals/out/results.json   # pair saved files, run nothing
```

- A baseline holds, per case: id, pass, open gap, detail, metrics and, with `--k` > 1, the pass count of the k runs. Plus the app commit, driver, models, date and `prompt_hash`: a hash of every agent's orientation (MCP contract and full guide) and the standing instruction, built for the synthetic eval brain. The compare says whether the prompt changed since the baseline. `results.json` carries the same hash, so `--compare-files` accepts either shape on either side.
- **Regression rule:** a pass -> fail of a case that is not an open gap. An open gap failing is listed, never counted; n/a never flips; new and missing cases are listed. `--compare` and `--compare-files` exit 1 on any regression.
- **Flaky llm cases:** `--k <n>` runs each llm case n times (it passes only if every run does). With k >= 3 on both sides, a case counts as a regression only when its pass count drops by 2 or more of k (a drop of 1 is listed as flaky), and the paired per-case pass-rate change is printed.
- `--compare` with `--only` pairs only the baseline cases under that prefix, and llm cases only with `--llm`.
- Re-save a baseline (and commit it) when a change is meant to move a case, never to hide a regression.

**Model routing compare.** The model steps run on the model `rules/models.yaml` routes them to (executors cheap, a step's own line under `steps:` for anything else; `pocketbrain models`). To check a routing change, pin the old model for a baseline, then run the routed one against it:

```sh
EVAL_STEP_MODEL=claude-sonnet-5-5 bun evals/run.ts --llm --only steps --k 3 --save-baseline steps-sonnet
bun evals/run.ts --llm --only steps --k 3 --compare steps-sonnet
EVAL_STEP_MODEL=claude-sonnet-5-5 bun evals/run.ts --llm --only judge --k 3 --save-baseline judge-sonnet
bun evals/run.ts --llm --only judge --k 3 --compare judge-sonnet
```

The duplicates judge moved from Opus to Haiku with this compare (backlog 212): pin `claude-opus-5-5` for the baseline, then run the routed one against it. `bun scripts/usage-day.ts --grow 31` prices a scripted day of every step at its routed model and on Haiku (numbers from the script, not typed).

## Capture precision

A self-filling brain is trusted only if what it proposes is right (big bet 2). `evals/fixtures/fill/items.yaml` holds 40 synthetic items in the shapes the pulls bring in (mail, calendar, Discord, Granola), each with its facts labelled by hand, plus wrong answers planted the way models get them wrong.

```sh
bun evals/run.ts --only fill          # fill-checks: a fake model answers the labels plus the planted errors; free, every run
bun evals/run.ts --llm --only fill    # fill-model: the routed capture.extract model; paid, through the harness thread
```

- **precision**: proposals that are a labelled fact (or a listed optional one) over all proposals. Target 0.9; fill-model fails below it.
- **recall**: labelled facts proposed or already in the brain over all labelled facts.
- **grounding**: proposals whose quote alone carries the value (the date, or most of its words). The checks hold a value to the whole item; this holds it to the line it cites.
- fill-checks fails when a planted error the code can see (a quote, number, date or attribute not in the text) becomes a proposal, or a labelled fact is dropped. Planted errors the code can't see (right words, wrong fact) are what keeps its precision under 1; the model run is the number that counts.
- fill-model's result data lists every unlabelled proposal (`not_labelled`) and every miss (`missed`), not only the first four the summary line shows. History: Haiku on 5bffc5c scored precision 0.656 and 0.712 (recall 0.875), mostly filler such as "sender of the email" and an organisation's kind restated from its name; the checks were tightened after it; 47c15ac, which also sharpened the prompt, scored 0.783 and 0.76, so the prompt change was left out and the model's precision is open gap G321. Its third run's full list also showed right facts the labels refused because they sat under another fair attribute (a moved room as a decision's `outcome`, a meeting date as `due`); those labels now list both (`attribute: schedule_changes|outcome`). Items labelled with no facts (a bare dentist appointment, a "let's sync" note) stay that way.

## Layout

```
run.ts                 runner, scoring, scorecard, trend, backfill
gaps.ts                known gaps, each with the finding and a proposed fix
baselines/             saved runs for --compare (det: deterministic suite; agents: the paid real-agent run)
cases/components.ts    carving, write quality, conflicts, idempotency, relay, upkeep (synthetic brain)
cases/real.ts          the same properties on a copy of Robin's brain
cases/e2e.ts           episodes through the live server (MCP and the JSON API, per-agent tokens)
cases/judge.ts         model-judged duplicates through judgeDuplicates itself, on the routed review model (--llm; EVAL_REPEATS for pass^k)
cases/fill.ts          capture precision: 40 synthetic source items (fixtures/fill/items.yaml) through the extraction path, scored for precision, recall and grounding
cases/steps.ts         the executor steps (capture.extract, sleep.consolidate) on their routed model, against known answers (--llm)
cases/dashboard.ts     browser episodes on the owner dashboard (Playwright; n/a without it)
cases/agents.ts        real agents in their seat: `claude -p` over MCP to the live server, judged on state (--llm)
cases/handoff.ts       two real agents hand one task across (hand_off, whats_new, handoff_done), judged on the call record and the handoff files (--llm)
cases/switchday.ts     switch day: a fresh API assistant gets only an invite, then 20 day-one questions (docs/switch-day.md)
lib/api-mcp.ts         the switch-day assistant's tools: HTTP client with a keychain, and its own memory
lib/oracle.ts          leak oracle: what each agent must never receive, from rules/ alone
lib/sandbox.ts         throwaway brain copies, fixed date (PB_TODAY, default 2026-10-08)
lib/pb.ts              loads the prototype from PB_SRC, so any commit can be tested
lib/compare.ts         baselines and the paired compare (regression rule, flaky rule)
lib/grade.ts           text checks the agent episodes share (tested in test/eval-grade.test.ts)
lib/stepmodel.ts       the model a step case runs on: routed like the product, or pinned with EVAL_STEP_MODEL
lib/llm.ts             model driver and usage meter for --llm runs
lib/hygiene.ts         contamination check: no case input reuses a prompt's example (test/eval-hygiene.test.ts)
fixtures/synthetic/    fake brain with Robin's real rules/, planted canaries, stale facts, duplicates
fixtures/retrieval/    synthetic French and English retrieval golden set: notes laid over fixtures/synthetic,
                       questions.yaml (direct, held-out, dev2, blind2, carve) and baseline.json (bun scripts/retrieval-baseline.ts)
history/               one JSON line per run, keyed by app and brain commit
```

## Rules

- **Independent oracle.** The leak oracle reads `rules/` and the notes directly. It never calls `carve.ts`, so a bug in the compiler can't hide itself.
- **No contaminated cases.** A case input never shares a run of 6 prose words with a prompt it grades (orientation, the browser guide, the standing instruction, the judge, capture, sleep, after-check and relay prompts); `test/eval-hygiene.test.ts` fails otherwise. Write golden inputs in your own words. An adversarial case that imitates a prompt on purpose (an injection that copies the answer format) puts `-inject` in its id; only that line is exempt.
- **Graders read state, not a model's opinion.** Episodes are graded on what was received and written, plus the text checks in `lib/grade.ts`. A model judge, if one is ever added, runs at least twice per item and is never told why the item was picked.
- **No real data in the repo.** Real-brain expectations are worked out at run time. Reports name fact keys, never values.
- **Retrieval in the cloud.** The real golden set lives in the brain, so its cases are n/a without `PB_BRAIN`. The synthetic set in `fixtures/retrieval/` runs everywhere (CI, `bun test`): recall@5 must hold `baseline.json` with the French-English word map (`PB_LEXICON`) off and on, the word map must never cost a same-words question, and carve questions must return nothing hidden in either mode. The 85% gate that says to add semantic search is measured on `blind4` (gap G172 while it's under): strict paraphrases (no content word shared with the note) of the `blind3` notes, written by a writer who never saw `src/lexicon.ts`, the ranker or any other question. `blind3` is the same notes asked more loosely. `blind2` was read while the word map was widened (2026-10-22), so it is a dev set now. Never read the `blind3` or `blind4` questions while tuning search; write a new blind set by the same method if they ever get read. After a wanted ranking change, `bun scripts/retrieval-baseline.ts` rewrites the baseline.
- **Known gaps.** A case that fails for a known reason names its gap in `gaps.ts`. It shows in the scorecard and doesn't fail CI. When it starts passing, `--ci` says so, and the gap should be closed. Any other failure is a regression and fails CI.
