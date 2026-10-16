# Scale and crash safety

Two checks, both on synthetic brains built on the spot. Neither ever touches a real brain.

```sh
bun scripts/perf.ts [--notes 10000] [--days 365] [--runs 5] [--keep] [--json]   # exits 1 over a budget
bun scripts/perf.ts --gen <dir> [--notes N] [--days D]                         # only build the brain
bun scripts/crash.ts [--rounds 10] [--notes 1000] [--keep]                      # exits 1 on any finding
```

## The synthetic brain

`synthBrain` in `scripts/perf.ts` builds a brain from `examples/brain/rules`:

- 10,000 notes (people, orgs, projects, decisions, notes), with 2 to 5 facts each, distinct name-like values, prose with links, and 15% of notes private.
- A year of journal lines, about ten a day across three agents.
- A year of git history written with `git fast-import`: the bulk import, then 20 one-note commits a day.
- A year of read log, 100 reads a day, and a year of write log, one line per synthetic commit.

It is deterministic, so two runs build the same brain.

## Budgets

Medians, measured in process the way the hub runs (cells on), at 10k notes and a year of use:

| Step | Budget | Measured (cloud container, 2026-10-15) |
|---|---|---|
| search (warm) | 300 ms | 43 ms |
| context_pack | 500 ms | 28 ms |
| write (remember) | 1.5 s | 1.0 s |
| search after a write | 500 ms | 372 ms (2026-10-16) |
| whats_new | 1.5 s | 95 ms |
| whats_new over 300 trailer-less commits (`test/perf-changes.test.ts`) | 1.5 s | 2.3 s before batching; 0.4 s first ask, 0.05 s second (2026-10-16) |
| sleep pass (forget + consolidate scan) | 120 s | 43 s |
| backup | 60 s | 2.6 s |

whats_new and changes_since judge each commit by the facts it changed (a trailer-less commit by a diff with its parent): the note versions of a range are read by one `git cat-file --batch`, parsed once per blob, and each commit's verdict is kept for the agent and rules it was judged under.

"Search after a write" includes bringing the reader's cell up to date, in place, rewriting only the cell notes the write can reach (below). Its slowest run is about 0.7 s.

Before the fixes below, the same brain took 1.2 s for a warm search, 5.8 s for a write and 55 s for the first read after a write.

## A year of disk

`scripts/perf.ts` also reports what a year leaves on disk, after the night's housekeeping ran:

| What | Budget | Measured (cloud container, 2026-10-16) |
|---|---|---|
| `.git` after a year (after gc) | 512 MB | 34 MB |
| `log/` after a year | 256 MB | 6 MB |
| `git gc --auto` in the night pass | 120 s | 3 ms (nothing to pack) |

The night pass ends with housekeeping (`src/growth.ts`, job `housekeeping`), which touches no note and makes no commit:

- **git.** `git gc --auto`, never detached, so it finishes inside the write queue. Agent writes never run git's own gc: `gitRun` (`src/git.ts`) passes `gc.auto=0` and `maintenance.auto=false` to every commit, so a write is never the one that pays for packing the repo.
- **Hub logs.** Each `com.pocketbrain.*.log` in `~/Library/Logs` (or `$PB_HUB_LOG_DIR`) over 10 MB is copied to `.1` and emptied in place, because launchd keeps it open for appending. Three old copies are kept. A line written between the copy and the truncate is lost.
- **Budget.** A `.git` over `PB_GIT_MAX_MB` (default 2048 MB) fails the job, so the probe reports it before the disk fills.

`log/*.jsonl` (the hash-chained read and write logs) are never cut: rotating them would break the chain. At about 6 MB a year they don't need it.

## What was slow, and what changed

- **Carved-value scrubbing** (`src/view.ts`, `src/carve.ts`, `src/match.ts`). Every string in a cell was checked against every carved value by compiling one regular expression per value, per string. Now each value's pattern is compiled once per carve, and a value is tried only on strings that hold its first word or two (`tokenIndex` in `src/util.ts`). The matcher's needles are indexed by their first six letters. The results are exactly those of the old code; `scripts/perf.ts` doesn't check that, but a 20,000-case comparison did when this was written.
- **A quadratic set** in `visibleFacts` and in the write path's tripwire, rebuilt for every note.
- **YAML parsing** on every load. `loadBrain` keeps each parsed file while its text is unchanged. Code that edits notes gets its own copy; read paths (`loadBrain(root, { shared: true })`) get the cached note itself, frozen, so an edit throws.
- **Cells rebuilt in full after every write** (`src/cell.ts`). Now a cell is updated in place, and only the notes a change can reach are written again (`affectedBy`): a note whose own file changed, whose hidden facts or body grant changed, that names a note that came into or left the slice, or that holds the first words of a carved value added or dropped (or a line a disguised-value needle finds). When needles change, every note whose cell file already holds `[withheld]` is rendered again too, since a needle reads a line after the exact pass (gap G132). What each note offers those tests is worked out once per note (`formsOf`, during the full build at start: building 4 agents' cells at 10k notes went from 19.9 s to 26.9 s, about 7 s more). A grant change, kept values reordered, or a carved value or changed needle the tests can't see coming (one holding `withheld`, `redacted`, `[` or `]`, any case) rebuilds the cell in full. A full build of the same cell gives the same files byte for byte (`test/cell.test.ts`).
- **The first read after an update reloaded the whole cell.** It now reads again only the files the update wrote or removed (`cellChangesSince`, `reloadNotes`). Read paths share the cell's parsed notes, frozen, instead of each getting a copy (`loadBrain(..., { shared: true })`); a copy of 10k notes took a quarter of a second.
- **The search index was built again for every new carve.** Each note's document is kept while the note and what its rendering reads are the same, and term counts are adjusted for the documents that changed (`src/retrieve.ts`).
- **Smaller costs that added up**: value strings, shown words and needles are remembered per note or value; the commit that last touched `rules/` is looked up only when the rules change; the cell's rules files are written only when they change.
- **Every read loaded and carved the whole cell** (`snapshot` in `src/core.ts`). The cell's notes and carve are now kept while the cell is the same build (each build gets a number, `cellGeneration`), the day is the same and the token role is the same. An in-place update that fails partway is followed by a full build. The search index is kept per carve (`src/retrieve.ts`).
- **The read and write logs were read in full on every append** to find the last hash. Now only the file's end is read.
- The write path's tripwire no longer computes the preview's leak flags, which it never showed (`carve(..., { flags: false })`).

## Crash safety

`scripts/crash.ts` runs the hub (`serve`, cells on) on a synthetic brain and kills its whole process group with `kill -9`, git children included, as a launchd restart (`kickstart -k`) or a power cut would. It does this:

- several times in the middle of a stream of `remember` calls;
- in the middle of the nightly sleep pass;
- in the middle of a backup.

After each kill it checks four things:

1. `git fsck` passes.
2. Every note parses.
3. The read and write log chains verify.
4. Every write the hub answered `committed` is in HEAD.

At the end, the hub must start again and commit a new write, sleep must run, and a backup must succeed with no half-written file that looks like a backup.

Result on 2026-10-15: 12 kills during writes (41 acknowledged writes), 6 during sleep and 3 during backup. No finding on this branch. Main also passed, but it took only 7 writes in the same time, so few kills landed mid-commit.

Random kills rarely land in the narrow windows below. Each was found by reading the code paths a kill can interrupt, then reproduced as the state that kill leaves, in `test/crash-safety.test.ts`. All four tests fail on main.

- **A log line torn by a kill stopped every later write.** `logWrite` parsed the last line of `log/writes.jsonl` and threw on it. Appends now cut off a torn last line first (`endTornLine` in `src/util.ts`); that line was never acknowledged. Without this, the read log's chain would also read as tampered forever.
- **A stale `.git/index.lock`** left by a killed commit made every later commit fail. Because `git()` doesn't throw, the write path still answered `committed` for writes that were never in git. A lock older than a minute is now removed before a commit (`clearStaleLock` in `src/git.ts`).
- **A write whose commit fails for any reason** is now refused with "not saved", and its files go back to what HEAD holds (`commitPaths`). A younger lock may belong to a git command still running, so it is left alone and the write is refused.
- **A commit holds only the write's own files** (`git commit -- <paths>`), never whatever else happened to be staged. If a replica's hub gate refuses the commit, the files go back before the refusal propagates. An owner message id the texts agent relays rides in the note's commit when its own registry commit didn't go through, so a failed write doesn't leave the id counting as the owner's word; a write refused or sent to the inbox after the id was registered (but not committed) takes it out again, keeping any edit the owner had made to the file.
- **An inbox answer whose commit fails** is refused ("the answer wasn't recorded: the proposal is still in the inbox, answer it again"); an accepted fact already committed stays, and answering again is a no-op for it. Journal lines go through `commitPaths` too.
- **A note half-written by a kill** would stop every read, because a note that doesn't parse fails `loadBrain`. Notes are now written beside the original and renamed over it (`saveNote`).

Backups already wrote to a `.partial` file and renamed it only when complete. A kill of the hub alone (not its group) leaves its running `git commit` to finish; the harness waits for it before checking, as the next start would.
