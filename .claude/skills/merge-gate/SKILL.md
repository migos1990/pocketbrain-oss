---
name: merge-gate
description: Run before merging any pocketBrain branch into main, whichever thread wrote it; returns MERGE or BLOCKED with evidence
disable-model-invocation: true
---

Run on a checkout of the branch, never in the real brain. Show each command and its result line. Every branch from every thread passes the same gate; a batch merge passes it again on the batch head.

1. `git diff --stat main...HEAD`.
2. `bun scripts/gate.ts main`. It blocks on:
   - test first: code changed with no test change (unless a `No-Test: <reason>` trailer), and the red run: the branch's changed tests must fail against main's code;
   - docs: a new src file or a CLI change with no README, CLAUDE.md or docs/ change;
   - slice audit: the access core changed and no `clear` audit is recorded for this tree;
   - agent evals: a prompt or `evals/cases/agents.ts` changed and no passing `--llm --only agents` run is recorded for this tree; the runner compares against the saved baseline, `bun evals/run.ts --llm --only agents --k 3 --compare agents` (same model as the baseline), and a pass -> fail (a drop of 2 or more of k) is a fail. A run done elsewhere can be paired after the fact with `--compare-files evals/baselines/agents.json <results.json>`;
   - `bun run check` (tests, typecheck, dead code, evals `--ci`), which includes `test/docs.test.ts` and `test/outbound.test.ts`.
3. Missing evidence: the slice audit is the `slice-auditor` agent (any session may run it, then `bun scripts/gate.ts record slice-audit clear|regression`). Paid agent evals have one runner session: add a line to /mnt/project-files/pocketbrain/eval-queue.md (branch, sha, why) and wait for its recorded result. Don't run them yourself unless you are that runner.
4. Fresh-eyes review: `/code-review` on the diff. Only findings that affect correctness or a law block; the rest are optional.
5. Docs: name the doc this change touched. If behaviour changed and no doc did, BLOCKED until one is updated or you state why none describes it.
6. Verdict MERGE or BLOCKED with the failing lines. Never skip or disable a test, add a known gap, or record evidence you did not see, to get green.
