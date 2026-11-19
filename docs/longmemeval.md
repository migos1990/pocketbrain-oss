# LongMemEval, retrieval only

The newest held-out result, with the commit it ran on, is on the [scoreboard](scoreboard.md). This page says what the bench measures, how it scores, and the rules it is run under.

## What it measures

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (Wu et al., ICLR 2025, MIT licence for code and data) asks 500 questions of a chat assistant's long-term memory. Each question comes with its own haystack of past chat sessions, a few of which hold the evidence. We use the `S` variant from the authors' cleaned release (`longmemeval_s_cleaned.json` on Hugging Face, `xiaowu0162/longmemeval-cleaned`, which replaced the original files in September 2025): 38 to 62 sessions per question. The question types in the file are single-session-user (70), single-session-assistant (56), single-session-preference (30), multi-session (133), knowledge-update (78) and temporal-reasoning (133); 30 of the 500 are abstention questions, marked `_abs` in their id.

The bench answers one narrow question: given a question, does our own ranker put the sessions that hold the evidence near the top? It prints, with every number:

> retrieval only; sessions filed as raw pages; no language model in the loop

It measures `rank` in `src/retrieve.ts` and nothing else: no capture, no filing, no facts, no carve that hides anything, no answer, no judge. A good number here does not mean the memory answers well; it means search would hand the right sessions to whatever answers.

## How it scores

It follows the benchmark's own session-level retrieval code (`run_retrieval.py` and `eval_utils.py`, in the retrieval folder of the authors' repository):

- A session's text is its user turns joined by a space. Assistant turns are left out, as there.
- The evidence sessions are those whose id contains `answer` and that have a user turn marked `has_answer`; an evidence session with no such turn does not count as a target.
- Abstention questions, and questions with no evidence in a user turn (most single-session-assistant ones), are skipped when the score is reported, as there. The table counts them under "skipped".
- `recall_any@k`: at least one evidence session in the top k. `recall_all@k`: every one of them. Both at k = 5 and 10.

Each question gets a throwaway brain of its own: one page per session (title "Chat on <day>", the session's text as the body), in an area the reader sees in full, run through the real carve and index, ranked for the question's words on the question's day. "words + local model" adds the same bge-m3 embedder the hub uses (`src/semantic.ts`, fused in `rank` with reciprocal-rank fusion), which embeds only the first 1,500 characters of each page, as the hub does.

## Running it

```sh
# once: the local model (about 590 MB), and the dataset to a folder outside the repo
pocketbrain search setup
curl -L -o ~/lme/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json

bun scripts/longmemeval.ts --data ~/lme/longmemeval_s_cleaned.json                 # dev slice, words only, seconds
bun scripts/longmemeval.ts --data ~/lme/longmemeval_s_cleaned.json --semantic      # adds words + local model
bun scripts/longmemeval.ts --data ~/lme/longmemeval_s_cleaned.json --slice rest --semantic   # the held-out run, once
```

Embedding is slow on a CPU without a GPU (about one session a second on a 4-core cloud container); vectors are cached by text under `~/.cache/pocketbrain/longmemeval-vectors`, so a stopped run picks up where it was.

## Rules that keep it honest

- **Dev and held out.** 50 questions, chosen by a hash of their ids, are the dev slice: the only ones to look at while working. The other 450 are run once. A second run of them on the same file is refused unless `--again "<reason>"` is given, and the reason and the count of earlier runs are printed with the table (`~/.cache/pocketbrain/longmemeval-rest-runs.jsonl`).
- **Frozen commit.** Every table prints the commit and the dataset file's sha256. The held-out run refuses a tree with uncommitted changes to `src/`, `scripts/`, the rules it reads or the lockfile; a dev run on such a tree says DIRTY and is never quoted.
- **No tuning on it.** No ranker constant changes in the branch that runs it. A ranker change is judged on our own question sets first, and this bench is run again after, on a new commit.
- **Whole table.** Every question type is printed, the weak ones too, and both recall columns.
- **Never committed.** The dataset is read from the path given and stays outside the repo.

## Results

The [scoreboard](scoreboard.md) carries the newest run with its full tables. Both runs so far, on all scored questions:

| run | commit | ranker | recall_any@5 | recall_any@10 | recall_all@5 | recall_all@10 |
|---|---|---|---|---|---|---|
| 2026-11-15 | `b501b4897a8d` | words | 92% | 95% | 78% | 87% |
| 2026-11-19 | `2705acc2e49d` | words | 92% | 95% | 78% | 87% |
| 2026-11-15 | `b501b4897a8d` | words + local model | 96% | 98% | 83% | 93% |
| 2026-11-19 | `2705acc2e49d` | words + local model | 95% | 98% | 84% | 93% |

By words alone the two runs are the same in every cell of every question type. With the local model they differ by at most two points in a cell, on two different cloud machines and two commits; which of the two moved it has not been looked at. So quote the model's numbers as "about", and the words' as exact.

The first run is kept below as it was written down.

### Held-out run, 2026-11-15

Run once on the 450 held-out questions, commit `b501b4897a8d`, data sha256 `d6f21ea9…c3a442`, on a 4-core cloud container (about 52 minutes of embedding). Retrieval only; sessions filed as raw pages; no language model in the loop.

#### words

| question type | scored | skipped | recall_any@5 | recall_any@10 | recall_all@5 | recall_all@10 |
|---|---|---|---|---|---|---|
| knowledge-update | 63 | 6 | 100% | 100% | 95% | 98% |
| multi-session | 108 | 12 | 95% | 97% | 64% | 78% |
| single-session-assistant | 5 | 48 | 100% | 100% | 100% | 100% |
| single-session-preference | 29 | 0 | 72% | 83% | 72% | 83% |
| single-session-user | 50 | 6 | 98% | 98% | 98% | 98% |
| temporal-reasoning | 118 | 5 | 88% | 92% | 74% | 85% |
| all | 373 | 77 | 92% | 95% | 78% | 87% |

#### words + local model

| question type | scored | skipped | recall_any@5 | recall_any@10 | recall_all@5 | recall_all@10 |
|---|---|---|---|---|---|---|
| knowledge-update | 63 | 6 | 100% | 100% | 94% | 100% |
| multi-session | 108 | 12 | 97% | 100% | 73% | 88% |
| single-session-assistant | 5 | 48 | 100% | 100% | 100% | 100% |
| single-session-preference | 29 | 0 | 93% | 97% | 93% | 97% |
| single-session-user | 50 | 6 | 96% | 100% | 96% | 100% |
| temporal-reasoning | 118 | 5 | 92% | 95% | 79% | 91% |
| all | 373 | 77 | 96% | 98% | 83% | 93% |

Reading it: with the local model, one evidence session is in the top 5 for 96% of scored questions and every evidence session for 83%. The weakest type is **multi-session** on `recall_all@5` (73% with the model, 64% by words alone): these questions need two or more sessions, and `recall_all` asks for every one in the top 5. Why the missing ones rank low is not yet looked at. Temporal reasoning is next (79%). Preference questions are the weakest by words alone (72%) and are mostly fixed by the model (93%). Single-session-assistant is mostly skipped (48 of 53), because its evidence is in an assistant turn, which the benchmark's session text leaves out.

The 50-question dev slice (seen while building, on a tree not yet committed, so not to be quoted) gave 98% and 89% at 5 for words plus the model.

### Where multi-session misses come from (dev slice only)

Read on the 50 dev questions only; no held-out question was looked at one by one. The dev slice has 13 scored multi-session questions, with 2 or 3 misses on `recall_all@5` depending on the ranker. They take three shapes:

1. **More evidence sessions than the top 5 has room for.** One question needs 5 sessions. Words alone put 3 of them in the top 5 and missed 2 altogether; with the model, 4 made the top 5 and one stayed out of the top 10. Over the whole file (a property of the data, not of any ranking), multi-session questions need 2 sessions in 81 cases, 3 in 21, 4 in 15 and 5 in 4, so at k = 5 the count alone leaves little room.
2. **The second session ranks low by words.** A two-session question: words put one session at rank 1 and the other at rank 9. The second shares fewer of the question's words (8 of 16 against 11 of 16). The session is there, so this is a ranking miss, not missing memory.
3. **The model's fusion pushes word hits out on long pages.** A two-session question that words alone had fully in the top 5 lost both sessions from the top 10 with the model added. One of them is about 3,300 characters, and the model embeds only the first 1,500 (`DOC_CHARS` in `src/semantic.ts`), so sessions that look closer in meaning took the places of the two that matched by words.

Two places for the pack work to aim, neither tried yet:

- **A second pass for what the first list didn't cover.** When a question asks about several things, look again for the parts the top notes don't answer, instead of relying on one top-k list.
- **Long pages and the fusion.** The 1,500-character limit on what the model embeds, and how the fusion treats a page the words ranked high and the model ranked low.

Any change to these is judged on our own question sets first, then this bench is run again on a new commit (`--again`), never tuned here.
