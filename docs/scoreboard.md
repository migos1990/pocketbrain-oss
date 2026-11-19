<!-- Written by `bun scripts/scoreboard.ts record` from docs/scoreboard.json. Do not edit by hand. -->
# Scoreboard

What pocketBrain claims, as numbers. A command in this repository printed each one, on made-up memories or on a public benchmark, never on anyone's own memory. The command is beside the number, with the commit it ran on and the day, so you can run it and compare.

| What is measured | Result | Command |
|---|---|---|
| Each assistant gets its slice and nothing else | 300 memories, 3 doors, 0 leaks, 0 missing | `bun scripts/slice-proof.ts` |
| Many calls at once get the same slice as one call | 115,644 reads in bursts, 0 memories with a fault | `BURST_SOAK=1 bun test test/burst-property.test.ts` |
| Each assistant answers what it is allowed to know | answered, of the questions its slice can answer: claude 30 of 34, chatgpt 28 of 32, gemini 19 of 22 | `PB_SEMANTIC=0 bun scripts/usefulness.ts` |
| Search finds the right past sessions (LongMemEval, retrieval only) | one evidence session in the top 5 for 95% of questions, every one for 84% | `bun scripts/longmemeval.ts --data ~/lme/longmemeval_s_cleaned.json --slice rest --semantic` |

To check the whole page on your own machine, from a checkout of this repository:

```sh
bun install
bun scripts/scoreboard.ts run
```

It runs each command below and prints, row by row, whether every number came out the same. A row that needs the local search model or the benchmark's file says so and is left as recorded until they are on the machine. Rows that use no model give the same counts on any machine. Rows that use the local model are less exact: between two machines or two versions a count can move by a question or two ([longmemeval.md](longmemeval.md#results) has two runs side by side).

## Each assistant gets its slice and nothing else

> 300 memories, 3 doors, 0 leaks, 0 missing

Measured 2026-11-19 on commit `2705acc2e49d`.

```sh
bun scripts/slice-proof.ts
```

300 made-up memories with made-up rules, 3,023 pages in all, read as 1,338 assistants and tokens through 3 doors. 206,213 answers were checked for anything the rules keep from the reader ("leaks": the count of memories where one was found), and 8,166 facts a reader is owed were read back ("missing": the count of memories where one was absent). The run took 33 minutes.

A hub runs the same check every night on 300 memories no night has read before. How it works, and what it does not prove: [slice-proof.md](slice-proof.md).

## Many calls at once get the same slice as one call

> 115,644 reads in bursts, 0 memories with a fault

Measured 2026-11-19 on commit `b0cd967770f5`.

```sh
BURST_SOAK=1 bun test test/burst-property.test.ts
```

60 made-up memories, 254 tokens. Every read an assistant can make was sent many at a time: 115,644 reads, 76,894 of them held byte for byte to the same call asked alone. 2,972 writes from other assistants landed between the reads (113 filed, 1,194 refused), and 3,600 calls over the request budget were turned away with nothing in them.

What each statement means: [slice-proof.md](slice-proof.md#a-burst-of-calls).

## Each assistant answers what it is allowed to know

Measured 2026-11-19 on commit `999ccbe18379`.

```sh
PB_SEMANTIC=0 bun scripts/usefulness.ts
```

The demo memory (about 500 made-up facts, with a week replayed on top) is asked its question set as each of its three assistants, through each door an assistant reads by. A question counts as answered when everything it needs is in what came back. "Its slice can answer" counts the questions the assistant's whole slice holds the answer to; the rest are outside its slice by the owner's rules, which is the point of a slice.

By context pack: one call, with the question as its topic.

| Assistant | Asked | Its slice can answer | Answered | Outside its slice | Median tokens read |
|---|---|---|---|---|---|
| claude | 34 | 34 | 30 | 0 | 1,677 |
| chatgpt | 34 | 32 | 28 | 2 | 1,737 |
| gemini | 35 | 22 | 19 | 13 | 1,622 |

By search: the search, then the top three pages read.

| Assistant | Asked | Its slice can answer | Answered | Outside its slice | Median tokens read |
|---|---|---|---|---|---|
| claude | 34 | 34 | 29 | 0 | 3,598 |
| chatgpt | 34 | 32 | 27 | 2 | 3,549 |
| gemini | 35 | 22 | 16 | 13 | 2,718 |

By memory check: what changed since the assistant last looked, then up to three of those pages. This door does not take the question, so it answers fewer.

| Assistant | Asked | Its slice can answer | Answered | Outside its slice | Median tokens read |
|---|---|---|---|---|---|
| claude | 34 | 34 | 10 | 0 | 1,548 |
| chatgpt | 34 | 32 | 10 | 2 | 1,548 |
| gemini | 35 | 22 | 10 | 13 | 1,774 |

`PB_SEMANTIC=0` asks by words alone, as a new install searches, so the counts are the same on every machine. With the local search model installed (`bun src/cli.ts search setup`), `bun scripts/usefulness.ts` searches with it and counts differently. By context pack it printed: claude 29 of 34, chatgpt 27 of 32, gemini 19 of 22 (2026-11-19, commit `999ccbe18379`).

How a question is scored, and why each miss missed: [prove-the-loop.md](prove-the-loop.md#usefulness).

## Search finds the right past sessions (LongMemEval)

> one evidence session in the top 5 for 95% of questions, every evidence session for 84%

Measured 2026-11-19 on commit `2705acc2e49d`. The bench prints one label with every number: "retrieval only; sessions filed as raw pages; no language model in the loop".

```sh
mkdir -p ~/lme && curl -L -o ~/lme/longmemeval_s_cleaned.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416c24c778c2fee6e6f3006e7a073259d48f/longmemeval_s_cleaned.json
bun src/cli.ts search setup
bun scripts/longmemeval.ts --data ~/lme/longmemeval_s_cleaned.json --slice rest --semantic
```

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) is a public benchmark of 500 questions about long chat histories. This row measures one narrow thing: given a question, does pocketBrain's own search put the sessions that hold the evidence near the top? No answer is written and no judge is used, so it is not the benchmark's question-answering score and is not to be compared with one. The 450 questions here were held out while the bench was built. Scored: 373. Skipped: 77, as the benchmark's own retrieval code skips them (questions to abstain on, and questions whose evidence is in no user turn). File `longmemeval_s_cleaned.json`, sha256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.

Words alone:

| question type | scored | skipped | recall_any@5 | recall_any@10 | recall_all@5 | recall_all@10 |
|---|---|---|---|---|---|---|
| knowledge-update | 63 | 6 | 100% | 100% | 95% | 98% |
| multi-session | 108 | 12 | 95% | 97% | 64% | 78% |
| single-session-assistant | 5 | 48 | 100% | 100% | 100% | 100% |
| single-session-preference | 29 | 0 | 72% | 83% | 72% | 83% |
| single-session-user | 50 | 6 | 98% | 98% | 98% | 98% |
| temporal-reasoning | 118 | 5 | 88% | 92% | 74% | 85% |
| all | 373 | 77 | 92% | 95% | 78% | 87% |

Words and the local model (bge-m3, on your machine):

| question type | scored | skipped | recall_any@5 | recall_any@10 | recall_all@5 | recall_all@10 |
|---|---|---|---|---|---|---|
| knowledge-update | 63 | 6 | 100% | 100% | 94% | 100% |
| multi-session | 108 | 12 | 97% | 100% | 74% | 90% |
| single-session-assistant | 5 | 48 | 100% | 100% | 100% | 100% |
| single-session-preference | 29 | 0 | 93% | 97% | 93% | 97% |
| single-session-user | 50 | 6 | 96% | 100% | 96% | 100% |
| temporal-reasoning | 118 | 5 | 92% | 94% | 80% | 89% |
| all | 373 | 77 | 95% | 98% | 84% | 93% |

Every question type is shown, the weak ones too. The method and the rules that keep the number honest: [longmemeval.md](longmemeval.md).

## What this page does not say

- Nothing here was measured on a real person's memory. The slice numbers are about the code, on memories and rules a generator makes up; the answers are about one small demo memory and a question set written for it.
- A count of 0 is a test result, not a mathematical proof. The limits are listed in [slice-proof.md](slice-proof.md#what-this-does-not-prove).
- A row is added to this page only with a command that prints it. A check that is not in the repository has no row.
