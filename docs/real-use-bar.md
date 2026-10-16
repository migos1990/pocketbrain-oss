# The real-use bar

pocketBrain counts as real, not a prototype, when it has run for **14 days in a row of daily use with no hand fix, plus one clean restore drill** (the owner, 2026-10-14). `pocketbrain bar` says where that stands, and the morning digest and the weekly scorecard carry the same line:

```
Real-use bar: day 3 of 14 with daily use and no hand fix; last break 2026-10-12 (hand fix: restarted the hub); restore drill: not yet; last backup 2026-10-15.
```

## What counts

A day counts when a live agent (not the gardener) read the brain and nothing broke. The streak goes back from today and stops at the first day that has any of:

- a **hand fix**, logged with `pocketbrain fix "<what>"`: a hub restart by hand, a re-pasted instruction, a reconnect, a hand edit to unstick something. Log it whoever did it, the owner or a Claude session on the Mac;
- a **hub failure**: a health-probe check (`src/probe.ts`) that turned to failing that day;
- a **failed restore drill**;
- **no reads at all** from a live agent. Today counts once it has a read, and until then it doesn't break the streak.

Days before the brain existed (its first commit or first log line) don't count and don't break the streak, so a brain made today shows no break yet.

The bar is met when the streak reaches 14, the latest `pocketbrain drill` was clean, and no health check is failing right now (shown as "open problem: …").

## Hand fixes the hub sees by itself

`pocketbrain fix` stays the way to log a fix the hub can't see. These are logged without anyone typing it (`log/fixes.jsonl`, `via: auto:…`):

| Fix | How the hub sees it |
|---|---|
| A **hand edit** to the brain | a commit whose author isn't `<name>@pocketbrain.local`. Every commit pocketBrain makes, dashboard edits included, carries that address (`authorEnv` in `src/git.ts`), so any other author is someone editing, reverting or merging by hand. The brain's first commit is its setup and doesn't count. Read from git each time, not copied into the log |
| A **hand restart** of the hub | `pocketbrain start` writes each start, and each stop by a signal, to `log/hub-runs.jsonl`. A start right after such a stop counts, unless the machine rebooted in between, the updater restarted it (`scripts/deploy.ts` writes `deploy.restart` next to `deploy.json` just before its kickstart), or the code changed: each start records the app's version and commit, and a start on different code than the last one is an update, even when a person pulled it and ran the kickstart. A start with no stop before it followed a crash that launchd recovered from; the probe reports those. A `kill -9` leaves no stop line either, so it isn't counted |
| The menu's **Restart hub** | `pocketbrain menubar restart` logs "restarted the hub from the menu"; the start after it isn't counted twice |
| A **repair command** run by hand | `pocketbrain hub replay`, `hub promote` and `restore` (logged in the restored brain) |

The daily self-check's warnings (`probe_warn_<name>` alerts) don't break the streak; its failing checks (`probe_<name>`) do.

The line also says how long it has been since the last hand fix, from both sources:

```
Real-use bar: day 4 of 14 with daily use and no hand fix; 4 days since the last hand fix (2026-10-16, hand edit: 1a2b3c4 fix a typo); restore drill: clean 2026-10-15; last backup 2026-10-19.
```

## Silent failures the probe catches

The health probe in `start` (`src/probe.ts`, every 2 hours) checks the public door and, with no network, the hub's own jobs. Each check appears once the thing it watches exists:

| Check | Fails when |
|---|---|
| `night` | the nightly pass threw or ran past its time (`PB_JOB_MINUTES`, default 45), or last finished over 36 hours ago |
| `digest` | the morning digest threw, or last finished over 36 hours ago |
| `housekeeping` | run after every nightly pass (`src/growth.ts`): `git gc --auto` failed, or the brain's `.git` is over its budget (`PB_GIT_MAX_MB`, default 2048 MB). It also rotates the hub's launchd logs; see `docs/perf.md` |
| `searchable` | run after every nightly pass, even a failed one: a note file whose path doesn't match its id, or a note in an agent's view that its search index lacks or that a search for its own title doesn't return |
| `pull` | a source pull threw or ran past 15 minutes |
| `backup` | backups are set up, the last one is over 48 hours old and the brain moved since |
| `texts` | the last 3 texts to the owner all failed to send (for iMessage, usually the Messages permission) |
| `fill` | once `rules/sources.yaml` has the consent line: a listed source made no proposal and re-confirmed no fact for 72 hours (`silent_after_hours` per source; see [sources-pull.md](sources-pull.md#silent-sources)) |
| `model` | a model key the owner put in `~/.config/pocketbrain/keys/` (for the conflict check or the sleep pass) isn't loaded in the hub, so those steps quietly run rule-only. `start` also prints which keys it ignored and why |
| `disk` | under 1024 MB free on the brain's disk (once the hub has run `start`) |
| `restarts` | the hub started 5 or more times in 6 hours (each `start` adds a line to `log/starts.jsonl`): it is crashing and coming back |

### The daily self-check: early warnings

The same probe also looks for what would otherwise end in a hand fix before the owner notices (`selfChecks` in `src/probe.ts`). These are warnings: each raises one alert (`check: probe_warn_<name>`) through the same path, but doesn't count as a hub failure, so it doesn't break the streak. The fix it leads to still does, if done by hand.

| Check | Warns when |
|---|---|
| `connections` | an assistant that read the brain in the last 14 days has been silent for 3 days: its token or connection probably stopped working (paused agents and the gardener are left out) |
| `logs` | `log/` is over 500 MB (`PB_LOG_MAX_MB`); names the biggest files |
| `release` | `main` has had changes the `release` branch lacks for over 7 days, from the auto-update's `deploy.json` (`unreleased_since`, see [release.md](release.md)) |

A gardener that missed its night isn't a warning here: the job check `gardener_runs` fails for it, per hours window ([gardener.md](gardener.md)).

Tokens don't expire on their own, so there is no expiry date to watch; a connection that stopped working shows up as `connections`.

The digest's "Numbers" carry one line for all of it: `Self-check: all 9 ok`, or `Self-check: 2 of 9 failing (disk, connections); see Needs you`, where each failing check is listed until it passes.

A check that turns to failing raises one alert (`agent: hub, check: probe_<name>`), which texts the owner and breaks the streak; while it stays failing the bar can't be met. Job outcomes are kept in `log/start-state.json` (`<job>_at`, `<job>_error`).

## Where it shows

| Where | What |
|---|---|
| `pocketbrain bar` | the line above |
| `digest/<date>.md` "Numbers" | the same line, every morning |
| `pocketbrain week` | "Hand fixes" and "Hub failures" rows per day, the bar line, and a "Hand fixes and hub failures" verdict (any is "fix first") |
| The dashboard's Overview | a "Real-use bar" card: the day of the streak and its last break, days since the last hand fix and what it was, and the restore drill (passed, failed or not run yet) |

Logs: `log/fixes.jsonl` (`{at, what, via}`), `log/hub-runs.jsonl` (`{at, ev, signal?}`), `log/alerts.jsonl` (probe checks are `agent: hub, check: probe_*`), `log/drills.jsonl`, `log/reads.jsonl`.

Probe failures are counted as hub outages, not as forged commits (before 2026-10-15 they also raised the "Forged or wrong-author commits" stop verdict).

## In the morning digest

Under "Needs you", every day until they're resolved:

- **Hub problem**: each health check still failing, with what failed and since when. The alert texts once; this line keeps it in view.
- **Hand task**: what only the owner can do, added with `pocketbrain task "<what>" --cmd "<exact command>"` (by the owner, or by a session that hit something only the owner's hands can do, such as a key into their password manager). The command is optional but should be there whenever one exists, so he never has to work it out; neither may hold a secret (it names where the secret lives instead). `pocketbrain task` lists them with their commands, the digest shows each with its command, and `pocketbrain task --done <n>` closes one. Log: `log/owner-tasks.jsonl`.

The week scorecard also totals the stale, due and disputed facts agents were handed (each went out with its label).
