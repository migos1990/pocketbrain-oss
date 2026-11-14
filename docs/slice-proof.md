# How the cut is tested

The claim: one memory, and each assistant is given only its own slice of it. This page says how that is tested, how often, and what the test does not cover.

The line the app and the site show comes from here:

> 300 memories, 3 doors, 0 leaks

with the day it was last run.

Code: `test/carve-check.ts` (the check), `test/carve-gen.ts` (the made-up memories), `evals/lib/oracle.ts` (what counts as a leak), `scripts/slice-proof.ts` (the run), `src/slice-proof.ts` (the nightly job and the line). Tests: `test/carve-property.test.ts`, `test/slice-proof.test.ts`.

## What one run does

1. **It makes a memory up.** A random brain: 7 to 12 pages of every kind (people, projects, money, notes, organisations, decisions) at every level from public to secret, with other names, facts made of parts, lists, facts shared with some assistants only, contact cards held until the owner has seen them, and pages that link and name one another. Every name, value, id and date in it is a made-up word or number used once, so finding one in an answer says exactly where it came from.
2. **It makes rules up.** Two to four assistants, trial or core, each with its own slices (by area, kind, tag, level, attribute), kinds kept from it, pages kept from it by name, a ceiling, and for half of them a second, read-only token capped lower.
3. **It lets things happen.** On most memories the real page writer writes every page; on about half, two pages are merged; on more than half, one assistant hands another a task that names a page and quotes a fact.
4. **It reads as every assistant, through every door.** For each assistant and each of its tokens, on the live server:

   | Door | How an assistant comes in | What is read |
   |---|---|---|
   | `mcp` | `POST /mcp` with its token (sign-in through OAuth and the local bridge for desktop apps end in the same calls) | orientation, what changed (with handoffs), the whole slice, a topic, every page by id, searches, the memory check, where each fact came from, who an address belongs to |
   | `api` | `GET /v1/...` with its token | the same reads |
   | `browser` | the sign-in form at `/b`, then pages with the session cookie | the same reads, less the two this door doesn't have (where a fact came from, who an address is) |

   Every page is asked for by id, whether or not the assistant may see it.
5. **It checks every answer against the oracle.** The oracle reads the rules files and decides, without calling the code that makes the cut, what each assistant must never receive: every value of a page or fact kept from it, in any spelling the matcher sees through (spacing, dashes, case, reformatted amounts), and every such page's title, other names, id and dates. One of these in one answer is a leak. What the assistant itself typed (the id it asked for, its search word) is taken out of that answer first.

A door that stops answering never counts as a door that leaks nothing: a refused sign-in, a request turned away or an error fails the run.

## How often

- **Every test run:** 6 memories, two through each door, plus every memory that ever leaked, kept as a fixture in `test/fixtures/carve-seeds/` and replayed for good through the door it leaked by. Where several memories found one fault, one of them is replayed on every run and the others (`same_as` in their `meta.json`) with every door. `CARVE_DOORS=all bun test test/carve-property.test.ts` reads every door on each, and every fixture.
- **Every night, on the hub:** 300 memories no night has read before, half read the way the hub serves (from each assistant's own cell) and half straight from the brain. It runs in a process of its own after the night pass, on brains it makes in a temp folder. It never reads or writes your brain; the one thing it leaves is a line of counts in `log/slice-proof.jsonl`. No model, no network. About 20 minutes of one core.
- **By hand:** `bun scripts/slice-proof.ts` (300 memories), or `--cases 50 --from 7000 --json`.

A night that finds a leak says so: the line reads "300 memories, 3 doors, 1 leak", the job shows as failed on your home and in Settings, and the record keeps the seed, so `CARVE_SEED=<seed> bun test test/carve-property.test.ts` replays that exact memory. A leak here is a fault in that version of the code on made-up data, not a leak of yours. A run that broke or didn't finish is recorded as such and is never shown as a result.

`PB_SLICE_PROOF=0` in the hub's environment turns the nightly run off; `PB_SLICE_PROOF_CASES` changes how many memories it reads.

## For a screen or a page that shows the line

`src/slice-proof.ts`:

- `lastSliceProof(root)`: the last finished run: `at` (when), `code` (the version checked), `memories`, `doors`, `leaks`, and the counts behind them (`pages`, `facts`, `readers`, `answers`).
- `sliceProofLine(p)`: the sentence, the same words everywhere: `300 memories, 3 doors, 0 leaks`. Print the day from `at` beside it.
- `sliceProofStreak(sliceProofs(root))`: how many nights in a row, and how many memories, with no leak.

Show the last finished run as it is. A night with a leak is shown as a leak, never replaced by an older clean night.

## What this does not prove

Say these with the line, or don't say "proof".

- **The memories are made up.** The test proves the code on thousands of random brains and rules. It does not read your brain. Your own rules are checked another way: the weekly carve audit (`docs/carve-audit.md`), the canaries (`docs/canaries.md`) and See as on every page.
- **It is a test, not a mathematical proof.** It finds what the generator can build. When a leak is found some other way (a review, a red team), the shape that leaked is added to the generator in the same change, and the memory that showed it is kept as a fixture.
- **A value said in other words gets through.** The oracle and the hub's own checks match a value in any spelling, not in a paraphrase ("about four hundred thousand"). No matcher can. The rows are in `test/ceilings.test.ts`.
- **A page merely outside an assistant's slices is not "kept from it".** The oracle counts what the rules carve out on purpose (a kind not shared, a page excluded by name, a level above the ceiling, a fact shared with others only). A page in an area an assistant was never given answers "not in your view", the same as a page that doesn't exist, and that is what is tested for it.
- **The word an assistant searched for.** What it typed is taken out of its answer before the check, since repeating a question leaks nothing. When the check searches for a word that is itself kept from that assistant, an answer that gave the word back from a hidden page is not told apart from an echo (G811). The page's other values, its name, id and dates are still checked in every other read.
- **Three doors, not every path out.** Mail between assistants through the relay, the act door (an assistant asks to send one mail), the sealed copy served while the hub sleeps (`docs/edge.md`), one-time reads you approve yourself, and an export of one assistant's slice are each tested on their own (`test/contracts/`, `evals/cases/redteam.ts`), not by this run.
- **What an assistant already remembers is its own.** The test covers what the memory gives out today. It cannot take back what an assistant was given before you changed a rule.

## The leaks this run found

- **A read-only token, through a cell (G810, November 2026).** The first run of 300 memories with half of them read the way the hub serves found three (seeds 7042, 7238, 7288): an assistant's read-only token, capped lower than the assistant itself, was told the name of a private page by another page that mentions it. It read the assistant's own cell with a second cut on top, and the second cut could no longer see which page the sentence named. A read-only token now reads from a cell carved for it. The three memories are kept as fixtures and replayed on every test run.
- **A handoff that names a page (G254).** A handoff from one assistant to another that named a page the other may not see was delivered with the name (seed 7067; open from October to November 2026 and kept as a failing test in public the whole time). The relay now treats the id and title of a page carved out for the recipient like any hidden value: the handoff is held for you. See `docs/handoffs.md`.
