# Scale and crash safety

Two checks, both on synthetic brains built on the spot. Neither ever touches a real brain.

```sh
bun scripts/perf.ts [--notes 10000] [--days 365] [--runs 5] [--keep] [--json] [--progress]   # exits 1 over a budget
bun scripts/perf.ts --gen <dir> [--notes N] [--days D]                         # only build the brain
bun scripts/crash.ts [--rounds 10] [--notes 1000] [--keep]                      # exits 1 on any finding
```

## The synthetic brain

`synthBrain` in `scripts/perf.ts` builds a brain from `examples/brain/rules`:

- 10,000 notes (people, orgs, projects, decisions, notes), with 2 to 5 facts each, distinct name-like values, prose with links, and 15% of notes private.
- A year of journal lines, about ten a day across three agents.
- A year of git history written with `git fast-import`: the bulk import, then 20 one-note commits a day.
- A year of read log, 100 reads a day, and a year of write log, one line per synthetic commit.
- A year of alerts, five a day, and 1,000 open inbox proposals: the owner's longest lists.

It is deterministic, so two runs build the same brain.

## Budgets

Medians, measured in process the way the hub runs (cells on), at 10k notes and a year of use:

| Step | Budget | Measured (cloud container, 2026-10-16) |
|---|---|---|
| search (warm) | 300 ms | 59 ms |
| context_pack | 500 ms | 37 ms |
| write (remember) | 1.5 s | 361 to 434 ms |
| search after a write | 750 ms | 333 to 418 ms |
| whats_new | 1.5 s | 125 ms |
| whats_new over 300 trailer-less commits (`test/perf-changes.test.ts`) | 1.5 s | 2.3 s before batching; 0.4 s first ask, 0.05 s second (2026-10-16) |
| sleep pass (forget + consolidate scan) | 120 s | 1.7 s |
| upkeep (night) | 30 s | 2.7 s |
| searchable check (night) | 60 s | 11 s (did not finish in 10 minutes before `foundBy`) |
| memory sync pass (night) | 30 s | 9.1 s |
| backup | 60 s | 2.6 s |
| restart to first answer | 10 s | 8.9 s |
| peak memory of the hub | 2 GB | 1.7 GB with the night steps (1.2 GB without) |

whats_new and changes_since judge each commit by the facts it changed (a trailer-less commit by a diff with its parent): the note versions of a range are read by one `git cat-file --batch`, parsed once per blob, and each commit's verdict is kept for the agent and rules it was judged under.

"Search after a write" includes bringing the reader's cell up to date, in place, rewriting only the cell notes the write can reach (below). Its slowest run is about 1 s. It measured 372 ms on 2026-10-16, then 0.7 to 0.8 s once carves withheld carved values in titles and aliases (G56), since a read after a write carves twice (the brain, to update the cell, then the cell). The incremental carve (below) brought it back to about 0.4 s, measured side by side with the same machine and load (two runs each, medians: 636 and 636 ms before, 333 and 418 ms after; writes 444 and 435 ms before, 361 and 434 ms after; an earlier pair on batch 29 gave 829 and 761 ms before, 464 and 505 ms after). What's left is reading every note file (about 0.12 s), the cell's own update and the search index.

Before the fixes below, the same brain took 1.2 s for a warm search, 5.8 s for a write and 55 s for the first read after a write.

## Several agents at once

`bun scripts/load.ts [--notes 10000] [--readers 5] [--writers 2] [--seconds 30]` starts a real hub (`serve`) on the synthetic brain, has five readers (search, context_pack, read, whats_new) and two writers (remember) call its MCP door at the same time, and probes `/health` every 100 ms. The per-agent request budget is lifted for the run, since it measures the hub, not the budget. `PB_LOAD_PROF=<dir>` makes the hub write a CPU profile. It exits 1 over a budget (`BUDGETS_MS` in the script); it isn't in CI, since one run takes a couple of minutes.

The hub does each call's work on one thread, so a long call makes every other caller wait, `/health` included. The longest `/health` wait is how long the hub answered nobody. Measured in the cloud container on 2026-10-22, two runs each, 10k notes, 30 s:

| | search p95 | read p95 | remember p95 | longest /health wait |
|---|---|---|---|---|
| main a72fbaf | 2.1 to 2.6 s | 1.6 to 6.5 s | 2.2 to 6.1 s | 4.1 to 8.1 s |
| with the incremental carve | 1.4 to 1.7 s | 1.4 to 1.5 s | 1.5 to 1.7 s | 3.2 to 3.3 s |

What blocks the hub: each agent's first read after a write brings its cell up to date, and that carved the whole brain again (about 0.6 s at 10k), so with writes every second every reader paid it on almost every call. The incremental carve carves only the notes a write changed, and throughput rose by about half (25 to 40 reads in 30 s per reader set). A write itself still takes about 0.5 to 1 s of the hub's thread (the write check, the commit, the reader cells). Readers alone stay under 0.5 s p95 and 0.9 s for `/health`. The budgets hold today's numbers with room, not a target; the next step would be doing the cell refresh and the commit off the request path.

## Context sizes

`bun scripts/context-size.ts` measures what each agent is handed on the 10,000-note synthetic brain, in estimated tokens (characters / 4), under the default context budget (docs/hub.md, "Context budget"). Measured 2026-10-16:

| Agent | Orientation | Whole view, uncut | Whole view, sent (notes cut) | Topic pack | whats_new |
|---|---|---|---|---|---|
| steward | 2057 | 1,443,814 | 7982 (9948) | 1124 | 2315 |
| planner | 2039 | 797,325 | 7918 (7052) | 859 | 1000 |
| helper | 2036 | 693,372 | 7977 (6335) | 853 | 798 |

A topic pack and whats_new are well under their budgets at this size. The whole view is the call the budget exists for.

### The owner's pages

Each dashboard page has a 300 ms row in `scripts/perf.ts` (`DASHBOARD_PAGES`), timed through the dashboard's own handler, signed in, after the first page has built the page state. Medians at 10k notes, 2026-10-16:

| Page | Measured |
|---|---|
| Overview `/`, page 2 of Needs you | 212 ms, 244 ms |
| Assistants, Who sees what (`/map`, page 3) | 149 ms, 171 ms, 158 ms |
| Brain by kind, search | 157 ms, 185 ms |
| History this week, the brain on a date | 259 ms, 208 ms |
| Activity (page 5), Who matters | 172 ms (187 ms), 164 ms |
| A note, an assistant, one note's history | 376 ms, 305 ms, 1.0 s (before the last fixes below) |

After the fixes that followed (`bun scripts/perf.ts`, 2026-10-16): the Brain tab 175 ms, a search 180 ms, a note 180 ms and an assistant's page 246 ms (it was 420 to 660 ms). The assistant page had been loading every note again, the read and write logs and the rules, and running `git` twice, on each view: it now takes the page state's notes, logs and rules (`readsByDay` and `writeQuality` accept them), keeps its folder-sorted slice and summary with the carve they come from, and its write-quality line with the page's other log figures. The Brain tab's "To recheck" is kept per brain version, and a search (the owner's and every agent's, `rank` in `src/retrieve.ts`) works out the snippet and matched words only for the hits it returns; on a common word most of the brain scores, and those were most of a query. The first view of a page after the brain changes still does that work once (about 0.3 to 0.4 s). One note's history is still over its budget (about 0.9 s).

What the pages work out from git and the logs is kept until the files it reads change. The page key holds the commit, the rules and each log file's size and time, then the time at three grains: the minute for figures that count minutes, the hour for the memory exam (its day-long grace for an unanswered question moves by at most an hour), and the day for everything that reads only files and the day (the read log and its chain check, write quality, the real-use bar, recently forgotten notes, reverted commits, the brain on a date). So the first view of a page in a new minute costs about what a repeat view does. The row "dashboard /agent/planner (new minute)" times the first view in a new minute. At 10k notes it took 370 to 730 ms before and about 220 ms after.

The first page after a write that shows what an assistant sees (Settings, Assistants, an assistant, Who sees what, a note) carves each assistant again and has its own row, budget 8 s (measured 1.1 s). Every other page carves nobody: the page state carves an assistant only when a page first asks for its view or its counts (`LazyCarves` in `src/dashboard/data.ts`), so history and the brain's lists stay at their usual time ("dashboard /history (first after a write)", 300 ms). Making the remaining carve touch only the notes a write changed is the incremental carve, still to come. The first search builds the owner's index (about 3 s), then each query takes about 0.2 s. One note's history runs `git log` on that note's path, so its first view grows with the brain's history.

Every list that grows with the brain or its logs shows a page at a time (`src/dashboard/paging.ts`: 200 rows, Needs you 50, alerts 20, writes 100) with Previous and Next; the page number is in the query string (`?page=`, and `held`, `writes`, `alerts` for a page's second list).

Before, every page took about 11 s at 10k notes: each request loaded a copy of every note, carved every assistant (0.5 to 5 s each), read a year of logs, re-parsed the inbox and ran `git` for the real-use bar, then rendered every row.

## At 50k notes and three years

A brain used daily for years gets to tens of thousands of notes. `bun scripts/perf.ts --notes 50000 --days 1095` builds one (about three minutes) and checks it against its own budgets (`BUDGETS_50K_MS` and `PEAK_MB` in `scripts/perf.ts`); `--progress` prints each step and the hub's memory as it goes. Measured in the cloud container on 2026-10-16:

| Step | Budget at 50k | Before the fixes below | After |
|---|---|---|---|
| search (warm) | 300 ms | | 272 ms |
| context_pack | 500 ms | | 232 ms |
| write (remember) | 5 s | 6.4 s | 3.1 s |
| search after a write | 6 s | 2.6 s | 3.8 s |
| whats_new | 1.5 s | | 13 ms |
| sleep pass (forget + consolidate scan) | 120 s | 2,058 s | 37 s |
| upkeep (night) | 120 s | | 23 s |
| searchable check (night) | 300 s | 313 s | 93 s |
| memory sync pass (night) | 180 s | | 74 s |
| backup | 60 s | | 27 s |
| restart to first answer | 12 s | 32 s | 9 s |
| peak memory of the hub | 9 GB | 6.4 GB; 10.3 GB once the night steps were timed | 8.2 GB with the night steps (6.0 GB without) |
| `.git` after three years (after gc) | 512 MB | | 176 MB |
| `log/` after three years | 256 MB | | 46 MB (read log as written today, archive included) |
| read log, live file | 16 MB | 39 MB | 5 MB |

The first warm search after the cells are built takes about 15 s, once, while the search index is built. Building every agent's cell at start takes about 150 s, and a restart serves its first answer in about 9 s, because cells that are still current stay on disk and each note's parsed frontmatter is read from the restart snapshot (both below).

The incremental carve (above) measured side by side at 50k, seven runs each with the same machine and load: write 2.5 s before, 2.0 s after; search after a write 3.5 s before, 2.1 s after; warm search unchanged (241 and 253 ms). It costs about 0.4 GB of peak memory (6.3 GB against 5.9 GB in one pair of runs).

Writes and the first read after one still grow with the brain: each reads every note file, walks every note's remembered carve once per agent, and brings the reader's cell up to date. The 50k budgets hold today's numbers with room; they are not a target.

## The night pass

The hub's night (`src/start.ts`) runs upkeep, the source rechecks, the sleep pass, then, whether or not those failed, the check that every note can still be found (job `searchable`) and housekeeping. The memory-sync pass runs with the Gardener's or `memsync run`. `scripts/perf.ts` times each against the budgets above. Measured 2026-10-16 in the cloud container (the source rechecks read no source on a synthetic brain, so they aren't timed; ranking what to recheck took 0.6 s at 10k and 2.8 s at 50k):

| Night step | 10k notes, 1 year | 50k notes, 3 years |
|---|---|---|
| upkeep | 2.7 s | 23 s |
| sleep pass | 1.4 s | 37 s |
| searchable check | 11 s | 93 s |
| memory sync pass | 9.1 s | 74 s |
| housekeeping (`git gc --auto`) | 3 ms | 6.6 s |

At 50k notes the whole night takes about four minutes, inside the write queue, so agent writes wait for it.

**The searchable check was the wall.** For every agent and every note in its view, it searched for the note's title and looked for the note in the top 50. Each search scored every note in the brain and found each hit's best paragraph, so the check grew with the square of the brain: at 10k notes it did not finish in 10 minutes, and at 50k it took 313 s and took the hub to 10.3 GB. It now asks `foundBy` (`src/retrieve.ts`) whether the note makes the top 50: the note's own score first, then only the notes that hold a query term strong enough to beat it, each scored exactly as a search scores it. `test/night-scale.test.ts` holds its answer to the search's for every note, query, cut and synonym setting on the test brain. The check builds its own index per agent with `scoringIndex`, which keeps no paragraphs and leaves nothing in the search's caches.

The synthetic brain's short titles ("person 123 budget") share words with thousands of notes, so about 75 of its 50k notes are truly not found by their title and the check reports them; real titles are names.

**Memory.** The searchable check and the memory-sync pass each carve the whole brain once per agent. Until this run timed them, the 50k peak (6.0 GB) never included them; with them it is 8.2 GB, so the 50k budget is 9 GB. About 1 GB of that stays after the check, as each note's carve memos, and the next carve reuses them. What would bring the peak down is the same incremental carve that writes need.

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

- **Read log.** `log/reads.jsonl` gets a line per search, read, `context_pack` and `whats_new`, about 13 MB a year at 100 reads a day with the words and token sizes it now records (39 MB after three years), and most read paths parse the whole file. Housekeeping moves whole months older than 120 days into `log/reads-archive/YYYY-MM.jsonl` (`rotateReadLog` in `src/readlog.ts`), so the live file holds about 5 MB whatever the brain's age. 120 days covers every reader's window: forgetting looks back 90 days, the week report 8 weeks. The archive and the live file are still one hash chain, checked end to end by `verifyReadLog` (`explain`, the dashboard): a removed, edited or missing line or month anywhere shows. A chain that doesn't verify is never moved, the last line always stays live so the next read chains to it, and a pass cut off part-way is finished by the next one with no line twice. `explain` reads the archive too, and forgetting still counts the log's age from its first archived line. The archive is git-ignored like the live file and goes into backups like it; a month holding a secret-shaped word is the only part a backup leaves out. At three years (2,000 notes): the archive pass takes 1.6 s once, then a night's worth; `readCounts` went from 173 ms to 28 ms, and a cursor `whats_new` from 347 ms to 296 ms (the rest is the carve).

`log/writes.jsonl` (the write log's chain) is never cut: at about 2 MB a year it doesn't need it. The exception is `log/requests.jsonl`, a line per hub request for `pocketbrain trace` with no chain: the housekeeping keeps its last 30 days ([request-ids.md](request-ids.md)).

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
- **The owner's dashboard rebuilt everything per request**. The page state now uses the shared, frozen notes, and keeps each assistant's carve while the notes (same objects), rules and day are the same (`cachedCarve` in `src/dashboard/data.ts`). Figures that read only git, logs and rules (the memory exam, the real-use bar, history, forgotten notes, the read chain) are kept under a key of the minute, the brain's commit (read from `.git`, no spawn) and the stamps of every file in `log/` and `rules/` (`keptFor`). The logs are parsed again only when their size or time changes; the owner's search view and its index, and the backlinks, are kept per brain version. A note's page reads only that note's file. History reuses the parsed note when an old version's text is today's (`parseShared` in `src/brain.ts`). Needs-you cards are built only for the page shown.
- **Carved values against titles, one at a time** (`scrubExact` in `src/carve.ts`). It now tries only the values whose first words a title holds (`tokenIndex`); `test/scrub-exact.test.ts` fuzzes it against the loop it replaced.

At 50k notes and three years, these were the walls:

- **The sleep pass made one commit per note it forgot facts in**: 34 minutes. It now makes one commit for the whole pass, adding paths in chunks of 500 and passing the message (which lists every forgotten fact key) through a file, since thousands of keys overflow a command line (`forget` in `src/sleep.ts`): 32 s.
- **Exact scrubbing tried every carved value on every string** (`scrubExact` in `src/carve.ts`). It now tries only the values whose first words the string holds (`tokenIndex`), and compiles a value's pattern only when the string holds the value. The disguised-value matcher skips a string that holds no needle's first letters or digits (`quickHit` in `src/match.ts`). `test/name-withhold.test.ts` compares the results with the old code's.
- **Name withholding walked every visible fact on each call.** A carve withholds carved values in titles and aliases (G56), and the write path asks the same for each title and value it checks; each call split and squashed every visible fact's words again. A fact's squashed words are now remembered while the fact is frozen, and a carve's name needles once per carve (`nameNeedles` in `src/carve.ts`).
- **Every carve worked out every note.** At 10k notes a carve took about 200 ms even when nothing had changed, and a read after a write carves twice, a write once per agent. A carve without the preview's flags (cells, snapshots, the write path) now remembers, per grant, what each frozen note gave it: where it went, its hidden facts and what it adds to the carved and shown values (`carveFromMemo` in `src/carve.ts`). A note loaded shared is the same object while its file is unchanged, so a carve after a write works out only the notes the write touched and walks the rest as remembered lists, in note order, so its lists come out in the full carve's order. Titles and aliases keep their withheld form while the carved values are the same; when a value is added, only names it reaches are worked out again. A repeat carve takes about 40 ms. `test/carve-memo.test.ts` compares it with the full carve through random edits to notes and rules.
- **A write copied the whole brain** to edit one note. It now reads the shared, frozen notes and copies only the note it changes (`write` in `src/write.ts`).
- **The parse cache held 200,000 entries.** The hub's notes plus every agent's cell come to about 220,000 files at 50k notes and four agents, so the cache was cleared on every pass and each read parsed everything again. It now holds a million (`PARSE_CACHE_MAX` in `src/brain.ts`).
- **A restart rebuilt every cell.** A cell now stays on disk across restarts while its brain commit, rules, slices and the code that built it are current: `cell.json` records a hash of `src/` and the lockfile (`cellCode` in `src/cell.ts`), and a cell built by other code is rebuilt, not updated in place. At start, `startCells` removes the cells of agents no longer in the policy and half-built leftovers, and keeps none when the brain has uncommitted note edits, since a cell can't tell them apart from the commit it was built from. A torn `cell.json` reads as no cell.
- **A restart parsed every note again.** YAML parsing was about three quarters of a restart at 50k notes (32 s to the first answer). Each note's parsed frontmatter is now kept in `.cells/parse.json`, keyed by the SHA-256 of its YAML text, and a restart reads JSON instead (`snapshotParse` in `src/brain.ts`): 9 s to the first answer. The key is the content, so an edited note is parsed again and a stale entry is never used. A file from another version of the snapshot or of the YAML parser is dropped whole and rebuilt; a line that doesn't read is parsed again. Frontmatter JSON can't hold the same (an infinite number, a prototype key) is never kept. Cells share their brain's file. It is written when the process exits, when `serve` is stopped, and at most every five minutes while the hub runs (about 60 MB at 50k notes); entries no read used are dropped once the file holds more than twice what was used plus 10k. Like the cells, it is derived: git-ignored, left out of backups, and safe to delete. `PB_NO_PARSE_SNAPSHOT=1` turns it off.

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
