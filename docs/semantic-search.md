# Semantic search

Search by words misses a question asked in other words: "who stops the pucks in my weeknight league" finds nothing in a note that says "goalie, Tuesday hockey". Semantic search adds a second ranking by meaning, made by an embedding model that runs on the hub's own machine, and fuses it with the word ranking. It is optional, and it is off until you download the model.

On the synthetic French and English question set (`evals/fixtures/retrieval`), recall in the top 5 with the word map on, words alone then with semantic search:

| Questions | Words | Words and meaning |
|---|---|---|
| strict paraphrases written blind, no word shared with the note (`blind4`, the 85% bar) | 56% | 83% (85% before a passed deadline read stale; accepted, gap G374) |
| the same, a fresh set written after semantic search was built, never tuned against (`blind5`) | 48% | 83% |
| questions written blind (`blind2`, a dev set) | 68% | 88% |
| questions that use the note's own words (`direct`, `direct2`) | 100% | 100% |
| `blind3` | 100% | 100% |
| held-out and `dev2` (each loses a question or two to a note close in meaning) | 100% | 97% and 93% |

`PB_MODEL_DIR=<model dir> bun run eval:semantic` measures it again (case `ret-synth-semantic`; n/a without the model).

## What runs where

Everything runs on this machine, in the hub's process (the model in a worker thread of it, so a model call never holds up the hub's other requests):

- the model, [bge-m3](https://huggingface.co/BAAI/bge-m3) by BAAI, in its 8-bit ONNX conversion `Xenova/bge-m3` (MIT licence), through `@huggingface/transformers` (Apache-2.0) and ONNX Runtime (MIT);
- the vectors of the notes, computed from the notes on this machine and kept on this machine;
- the vector of each query, computed when an assistant searches.

No note text and no query is ever sent anywhere. The only network use is `pocketbrain search setup`, which downloads the model's four files once from huggingface.co, which hands the large ones to its file host (`us.aws.cdn.hf.co`, or another `*.cdn.hf.co` by region): a firewall allowlist needs both, for setup only. Every other load of the model has downloads turned off (`allowRemoteModels` false and local files only), so a search can never fetch anything: with the model missing, search is words only.

## Turning it on

```sh
pocketbrain search setup
```
 The download and the check run in a child process of the command, which reports back before it exits, so the model is never loaded in the command itself.
It downloads the model into `~/.cache/pocketbrain/models` (or `PB_MODEL_DIR`), checks it loads from there with downloads off, and prints how much space it took. Semantic search is then on, for a running hub too, from its next search. `pocketbrain doctor` has a `search` line that says on or off, and why.

## Disk and memory

- The model: about 590 MB on disk (`onnx/model_quantized.onnx` is 570 MB of it).
- The library: `@huggingface/transformers` is an optional dependency; with ONNX Runtime it takes about 400 MB in `node_modules`. `bun install --omit optional` leaves it out, and the hub works without it.
- Memory: the loaded model adds about 1.2 GB to the hub while it runs. It is loaded at the first semantic search or vector pass after the hub starts (about 5 seconds).
- Vectors: 4 KB per note text (1,024 numbers), so about 40 MB for 10,000 notes.

## The vectors

A note's vector is made from exactly the text the asking assistant's search index holds for it: the note as that assistant is shown it, cut at 1,500 characters. A hidden fact, a carved value or a note outside the slice is not in that text, so it can't shape any vector, and two assistants that see a note differently get different vectors for it. Search ranks by meaning over the asking assistant's own visible notes only. Hidden equals missing holds with semantic search on: `test/semantic.test.ts` searches each carved value on the brain, and on one where it was never written, and checks the answers are the same.

Vectors are cached on disk by the sha256 of that text, in `~/.cache/pocketbrain/vectors/<brain>/<model>/` (or under `PB_VECTOR_DIR`), files readable by you only. That is outside the brain on purpose: git never sees it and backups never carry it, and nothing needs adding to an existing brain's `.gitignore`. A vector dir that would sit inside a git work tree or a brain folder is never written to; vectors are then kept in memory only, and doctor says so.

They are computed in the background, by a pass over every view: when the hub starts, and a few seconds after an assistant's write through the hub, only when it is authenticated, on a write route, and a commit actually landed (the pass checks the brain's HEAD moved; a request with no token or a read never starts one). At most one pass runs and one waits, they start at most every 30 seconds, and the pass gives the hub's event loop back between agents. A note a search finds without a vector is queued too, ahead of the pass, so the asker's own notes come first. Until a note has its vector it has no meaning rank, only its word rank. A reader token's narrower view gets its own vectors in the pass.

Each pass also deletes the vectors no current view needs. A forget doesn't wait for one: `pocketbrain forget` (and its undo) and the dashboard's Forget delete the vectors no view needs any more on disk at once, whether semantic search is on or off (docs/forget.md). Deleting the vector folder is always safe: it is rebuilt.

## Load and fairness

A query is cut at 256 characters (a question, not a document) and waits for the model behind at most one query per assistant: an assistant's newer query replaces its older waiting one, assistants take turns, and no more than 16 wait in all; past that, or after 4 seconds, the search answers by words alone, and a query whose caller stopped waiting is dropped, never run. So one assistant searching hard can't keep semantic search from the others. A note already waiting for its vector is never queued again, so repeated searches on a brain still being embedded add no work (G373).

What can still be seen: while a pass embeds notes after a write somewhere in the brain, searches can be slower, or answered by words alone when their 4 seconds run out. An assistant could time its searches to tell that something was written, and roughly how much, though never what or where; word search has a smaller version of the same effect.

## What an assistant sees

Search and a topic context pack fuse the two rankings (reciprocal-rank fusion, k=60). A note found by its words explains itself as before (docs/hub.md, "How a search hit explains itself"). A note found only by meaning is a weak hit with `via: ["similar meaning"]`, and a context pack heads it "Matched only by similar meaning, none of your words (weak: check it is what was asked before relying on it)". Only the ten nearest notes get a meaning rank, and a note found only by meaning is kept only when its similarity to the question stands at least 0.07 above the median similarity over the asker's view. The model gives every note a fairly high score, so no fixed cut-off tells a paraphrase from an unrelated question; how far a note stands out from the rest does. The floor was chosen on the `blind2` dev set and twenty unrelated or nonsense questions only (on those, under one weak hit per question on average, against almost nine with no floor), never on `blind4` or `blind5`. The median comes from the visible notes only, like the vectors. When every hit is found only by meaning, the answer says so: MCP `search` returns the empty-search answer (`why`: none of the words is in a note in the view, the hits are only similar in meaning; `next`: if none is what was asked, it isn't in your view) with those hits, and a topic context pack says it in its header. So an assistant can still honestly answer "not in my view". The owner's "See as" search on the dashboard is words only.

## Turning it off

- `PB_SEMANTIC=0` in the hub's environment: words only, nothing loaded, the files kept.
- Without the library (`bun install --omit optional`), or with a model that doesn't load, it is off too: the hub says why in its log, and `pocketbrain doctor` names a missing library.
- To remove it: delete the model folder (`~/.cache/pocketbrain/models`) and the vector folder (`~/.cache/pocketbrain/vectors`).
