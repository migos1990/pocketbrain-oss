# How the cut is tested

The claim: one memory, and each assistant is given only its own slice of it. This page says how that is tested, how often, and what the test does not cover.

The line the app and the site show comes from here:

> 300 memories, 3 doors, 0 leaks, 0 missing

with the day it was last run. The [scoreboard](scoreboard.md) holds a full run of it beside the other numbers, each with the command that prints it.

Code: `test/carve-check.ts` (the check), `test/carve-gen.ts` (the made-up memories), `evals/lib/oracle.ts` (what counts as a leak), `test/carve-owed.ts` (what each assistant is owed), `scripts/slice-proof.ts` (the run), `src/slice-proof.ts` (the nightly job and the line). Tests: `test/carve-property.test.ts`, `test/slice-proof.test.ts`, and `test/burst-property.test.ts` for calls sent many at a time ("A burst of calls" below).

## What one run does

1. **It makes a memory up.** A random brain: 7 to 12 pages of every kind (people, projects, money, notes, organisations, decisions) at every level from public to secret, with other names, facts made of parts, lists, facts shared with some assistants only, contact cards held until the owner has seen them, and pages that link and name one another. Every name, value, id and date in it is a made-up word or number used once, so finding one in an answer says exactly where it came from.
2. **It makes rules up.** Two to four assistants, trial or core, each with its own slices (by area, kind, tag, level, attribute, a list of pages by id), some pages not filed yet, kinds kept from it, pages kept from it by name, a ceiling, and for half of them a second, read-only token capped lower.
3. **It lets things happen.** On most memories the real page writer writes every page; on about half, two pages are merged; on more than half, one assistant hands another a task that names a page and quotes a fact.
4. **It reads as every assistant, through every door.** For each assistant and each of its tokens, on the live server:

   | Door | How an assistant comes in | What is read |
   |---|---|---|
   | `mcp` | `POST /mcp` with its token (sign-in through OAuth and the local bridge for desktop apps end in the same calls) | orientation, what changed (with handoffs), the whole slice, a topic, every page by id, searches, the memory check, where each fact came from, who an address belongs to |
   | `api` | `GET /v1/...` with its token | the same reads |
   | `browser` | the sign-in form at `/b`, then pages with the session cookie | the same reads, less the two this door doesn't have (where a fact came from, who an address is) |

   Every page is asked for by id, whether or not the assistant may see it.
5. **It checks every answer against the oracle.** The oracle reads the rules files and decides, without calling the code that makes the cut, what each assistant must never receive: every value of a page or fact kept from it, in any spelling the matcher sees through (spacing, dashes, case, reformatted amounts), and every such page's title, other names, id and dates. One of these in one answer is a leak. What the assistant itself typed (the id it asked for, its search word) is taken out of that answer first.
6. **It reads back what each assistant is owed (G815).** A second oracle, also written from the rules files without the code that makes the cut, lists the facts each assistant and token must be given: every plain fact of a page in an area or in the whole memory the assistant holds outright, that no rule keeps from it. Each one must be in the read of its page, through every door, found by the same matcher that finds a leak. A memory where any owed fact is absent counts as one "missing". Without this half, a hub that gave every assistant nothing would read 0 leaks.

A door that stops answering never counts as a door that leaks nothing: a refused sign-in, a request turned away or an error fails the run.

## How often

- **Every test run:** 6 memories, two through each door, plus every memory that ever leaked or missed an owed fact, kept as a fixture in `test/fixtures/carve-seeds/` and replayed for good through the door it leaked by (`doors` in its `meta.json` names others). `CARVE_FREEZE=1` with `CARVE_SEED=n` freezes a memory that leaked or missed. Where several memories found one fault, one of them is replayed on every run and the others (`same_as` in their `meta.json`) with every door. `CARVE_DOORS=all bun test test/carve-property.test.ts` reads every door on each, and every fixture.
- **Every night, on the hub:** 300 memories no night has read before, half read the way the hub serves (from each assistant's own cell) and half straight from the brain. It runs in a process of its own after the night pass, on brains it makes in a temp folder. It never reads or writes your brain; the one thing it leaves is a line of counts in `log/slice-proof.jsonl`. No model, no network. About 20 minutes of one core.
- **By hand:** `bun scripts/slice-proof.ts` (300 memories), or `--cases 50 --from 7000 --json`.

A night that finds a leak says so: the line reads "300 memories, 3 doors, 1 leak", the job shows as failed on your home and in Settings, and the record keeps the seed, so `CARVE_SEED=<seed> bun test test/carve-property.test.ts` replays that exact memory. A leak here is a fault in that version of the code on made-up data, not a leak of yours. A run that broke or didn't finish is recorded as such and is never shown as a result.

`PB_SLICE_PROOF=0` in the hub's environment turns the nightly run off; `PB_SLICE_PROOF_CASES` changes how many memories it reads.

## For a screen or a page that shows the line

`src/slice-proof.ts`:

- `lastSliceProof(root)`: the last finished run: `at` (when), `code` (the version checked), `memories`, `doors`, `leaks`, `missing`, and the counts behind them (`pages`, `facts`, `readers`, `answers`, and `owed`, the owed facts read back).
- `sliceProofLine(p)`: the sentence, the same words everywhere: `300 memories, 3 doors, 0 leaks, 0 missing`. Print the day from `at` beside it. A night recorded before owed facts were read back has no `missing` and its line stops at the leaks.
- `sliceProofStreak(sliceProofs(root))`: how many nights in a row, and how many memories, with no leak and nothing missing.

Show the last finished run as it is. A night with a leak is shown as a leak, never replaced by an older clean night.

See as shows it (`tested` in `src/dashboard/see.ts`, `test/see-proof.test.ts`): on `/see/<agent>` and under each page there, with the day, the sentence that the memories are made up, and nothing before the first finished run.

## A burst of calls

An assistant that writes a script, instead of asking one thing at a time, sends the hub many calls at once, mixed with another assistant's calls and with writes landing between its reads. `test/burst-property.test.ts` (the check is `test/burst-check.ts`) sends every read above, for every assistant and token, in a seeded order and 64 at a time, on the same made-up memories, and says what a burst may not change:

- **The same answer.** A read gets, in the burst, the answer the same call gets when asked alone, byte for byte, and never the answer another token gets.
- **0 leaks, 0 missing.** No answer in the burst carries what the oracle keeps from its reader, with or without writes landing between the reads, and every fact a reader is owed is in the burst's read of its page.
- **Every write is checked.** A write the checks refuse alone (a password-shaped value, the reserved `standing` attribute, a path under `rules/`) is refused on every call in the burst in the same words; the refused value is in no file and no commit, and `rules/` is as it was.
- **A hidden page stays missing.** A write to a page out of the writer's view answers like a write to a page that does not exist.
- **Each write keeps its writer.** Every assistant writes a marker of its own while the others do the same; each marker in the brain afterwards is recorded as its own writer's, in the page and in the commit.
- **The budget holds.** On the default request budget (`docs/hub.md`), 180 calls at once from one token get 120 answers and 60 refusals that carry nothing, and another token's calls in the same burst are all answered.

Two memories on every test run, each through one door in turn; `BURST_DOORS=all` for every door, `BURST_SOAK=1` for 60 memories through every door, `BURST_SEED=n` to replay one. A seed that fails is added to `test/fixtures/burst-seeds.json` and replayed on every run. It is a test only: nothing on the hub runs it on a schedule. The calls are made inside one process, the way the hub serves them; it does not open sockets, so it says nothing about a proxy or a tunnel in front of the hub.

## What this does not prove

Say these with the line, or don't say "proof".

- **The memories are made up.** The test proves the code on thousands of random brains and rules. It does not read your brain. Your own rules are checked another way: the weekly carve audit (`docs/carve-audit.md`), the canaries (`docs/canaries.md`) and See as on every page.
- **It is a test, not a mathematical proof.** It finds what the generator can build. When a leak is found some other way (a review, a red team), the shape that leaked is added to the generator in the same change, and the memory that showed it is kept as a fixture.
- **A value said in other words gets through.** The oracle and the hub's own checks match a value in any spelling, not in a paraphrase ("about four hundred thousand"). No matcher can. The rows are in `test/ceilings.test.ts`.
- **A page merely outside an assistant's slices is not "kept from it".** The oracle counts what the rules carve out on purpose (a kind not shared, a page excluded by name, a level above the ceiling, a fact shared with others only, a page not filed yet that the assistant's slices don't read in every area and don't list by id, or that every slice reading it in every area caps below its level). A page in an area an assistant was never given answers "not in your view", the same as a page that doesn't exist, and that is what is tested for it.
- **The word an assistant searched for.** What it typed is taken out of its answer before the check, since repeating a question leaks nothing. When the check searches for a word that is itself kept from that assistant, an answer that gave the word back from a hidden page is not told apart from an echo (G811). The page's other values, its name, id and dates are still checked in every other read.
- **"0 missing" covers the plain part of a slice.** The owed list holds the facts with one reading only: a page in an area the assistant holds, or anywhere when it holds the whole memory, read by its id. A page not filed yet is owed only to an assistant that holds the whole memory or an area slice for every area; a slice with only a level or a list of attributes reads it under that filter, which is not counted (G981); read by its area alone it is kept from the assistant, and the leak half checks that. Pages an assistant reaches only through a slice of its own making (by kind, tag or a list of attributes) are not on it, nor are facts that link another page, facts made of parts, or a value that contains something kept from that assistant. Left off too: a value the check cannot tell from ordinary text (under four characters, a common word, a bare year or date, a word in small letters only, a web address), a fact that has ended or been retired, a page folded into another, and the assistants' own pages. A fact of one of those kinds withheld by mistake would not be counted. Whether search or a topic finds an owed fact is not checked either; usefulness is measured elsewhere (`docs/prove-the-loop.md#usefulness`).
- **Three doors, not every path out.** Mail between assistants through the relay, the act door (an assistant asks to send one mail), the sealed copy served while the hub sleeps (`docs/edge.md`), one-time reads you approve yourself, and an export of one assistant's slice are each tested on their own (`test/contracts/`, `evals/cases/redteam.ts`), not by this run.
- **What an assistant already remembers is its own.** The test covers what the memory gives out today. It cannot take back what an assistant was given before you changed a rule.

## The leaks this run found

- **A read-only token, through a cell (G810, November 2026).** The first run of 300 memories with half of them read the way the hub serves found three (seeds 7042, 7238, 7288): an assistant's read-only token, capped lower than the assistant itself, was told the name of a private page by another page that mentions it. It read the assistant's own cell with a second cut on top, and the second cut could no longer see which page the sentence named. A read-only token now reads from a cell carved for it. The three memories are kept as fixtures and replayed on every test run.
- **A handoff that names a page (G254).** A handoff from one assistant to another that named a page the other may not see was delivered with the name (seed 7067; open from October to November 2026 and kept as a failing test in public the whole time). The relay now treats the id and title of a page carved out for the recipient like any hidden value: the handoff is held for you. See `docs/handoffs.md`.
- **A miss that was the check's own (G981, November 2026).** The night of 2026-11-16 read "0 leaks, 2 missing" (seeds 21773206 and 21773215). Both times an assistant held area slices for some areas but not all, plus a slice with only a level or a list of attributes, and a page not filed yet sat in one of its areas. The hub was right to keep the page from the area slice (G872); the owed list was wrong to expect it, and the leak half would not have caught the opposite fault. Both halves now follow the hub's rule, and the two memories are fixtures replayed through every door on every test run.
