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
| A **hand edit** to the brain | a commit whose author isn't `<name>@pocketbrain.local`. Every commit pocketBrain makes, dashboard edits included, carries that address (`authorEnv` in `src/git.ts`), so any other author is someone editing, reverting or merging by hand. The brain's first commit is its setup and doesn't count. Changing a setting with an owner command (`ask on`, `night`, `gardener setup`, `hub url` and the other `rules/` setters in `src/ownerset.ts`) is configuration and carries that address too, so it doesn't count; the same change typed into `rules/` by hand does. Read from git each time, not copied into the log |
| A **hand restart** of the hub | `pocketbrain start` writes each start, and each stop by a signal, to `log/hub-runs.jsonl`. A start right after such a stop counts, unless the machine rebooted in between, the updater restarted it (`scripts/deploy.ts` writes `deploy.restart` next to `deploy.json` just before its kickstart), or the code changed: each start records the app's version and commit, and a start on different code than the last one is an update, even when a person pulled it and ran the kickstart. The app checkout's HEAD moving since the last start (a pull, a checkout, a commit: the time of its HEAD reflog, read without running git) counts as new code too, so a start after an older hub that recorded no build, or one where git couldn't name the commit, isn't taken for a hand restart. The hub's log says `noted a hand fix (<date> <time> UTC): …` for each one it counts. A start with no stop before it followed a crash that launchd recovered from; the probe reports those. A `kill -9` leaves no stop line either, so it isn't counted |
| A **hung hub** (no hand fix, but a failed hub check) | `pocketbrain watchdog` runs from its own launchd job, `com.pocketbrain.watchdog`, every 5 minutes, outside the hub, so a hub frozen on one call can't freeze it too. It asks `/health` with a 15-second timeout. After two missed answers in a row it restarts the hub (`launchctl kickstart -k`, marked as planned like the updater's restart) and leaves a `probe_hub_hung` hub alert, so that day breaks the bar as a hub check that failed. Then it waits 15 minutes before restarting again. Off a Mac it only alerts. Each run also does the hub's own job checks that need no network (a night pass, digest, backup or Gardener run that stopped, an assistant that stopped reading), so they are seen while the hub is down. Each failing one, like a hung hub, shows as a Mac notification once a day and as a ⚠ line in the menu bar, from `log/watchdog.json`. The hub's self-check flags a watchdog that hasn't run for 15 minutes, and so does the menu bar. `pocketbrain menubar install` adds the watchdog to a hub installed before it existed, without touching the hub's own launchd file. With the dashboard on the tailnet, each run also pings, over the tailnet only (`tailscale ping --until-direct=false -c 1 --timeout 5s`: a pong over a relay counts, since an idle phone often answers through one first, G743), each phone in `dashboard_tailnet_devices` that `tailscale status` calls online (an offline phone is just not in use and is never pinged). A phone that fails two runs in a row (10 minutes) is one menu-bar line, "tailnet: the hub can't reach your phone; toggle Tailscale on the phone first, restart it on the Mac only if that fails", naming the kind of device only, never its name or address. It is report-only for now: no Mac notification (G741) |
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
| `pull` | a source pull threw or ran past 15 minutes, or `rules/sources.yaml` doesn't parse (cleared once it does) |
| `job_timeout` (an alert, not a probe line) | a job in the hub's write queue (`serial()`, `src/server.ts`) ran past its limit: 2 minutes for a door's write or a Gardener pass (`PB_SERIAL_LIMIT_MS`), 10 for the Gardener's tend, 20 for a pull, 30 for a backup, `PB_JOB_MINUTES` + 5 for the daily jobs. An async job is let go there, so later writes on every door go on and its caller gets an error; synchronous work can't be cut short in the hub's thread and is only reported once it returns. Each is a line in `log/jobs.jsonl`, and one alert per job a day |
| `backup` | backups are set up, the last one is over 48 hours old and the brain moved since |
| `auto_saves` | a fact the hub planned to file was refused in the last day (names the refusal checks, never a value); it waits as a card and is tried again the next day. A save refused twice under the same code is parked until new code runs, and counts for as long as its proposal is open (G538). Early warning |
| `filed_lines` | a fact the hub filed in the last day left no line on the owner's home (its commits touched no diary file); names how many, never a value. Early warning (G524) |
| `source_cap` | a source reached its daily `max_per_day` limit; the rest is read tomorrow. Early warning |
| `calendar_pull` | a calendar pull read nothing for 3 days while that calendar's coming events include ones it never read, even after each pass reads those by id (G744): the sync is broken, not quiet |
| `origin` | with `push_origin: true` in `rules/backup.yaml`: the hub's last 2 hourly pushes of main to the brain's origin failed (rejected because origin moved on, no credentials, or no answer in 5 minutes), so new commits are only on this disk |
| `texts` | the last 3 texts to the owner all failed to send (for iMessage, usually the Messages permission) |
| `fill` | once `rules/sources.yaml` has the consent line: a listed source made no proposal and re-confirmed no fact for 72 hours (`silent_after_hours` per source; see [sources-pull.md](sources-pull.md#silent-sources)) |
| `local` | the hub's own `/health` doesn't answer 200. `/health` answers 503 when the brain's rules don't parse, since every agent call would fail too |
| `probe` | `log/probe.json` itself can't be read (the hub died mid-write). The next run starts over and re-alerts every failing check; the file is written to a temp file and renamed, so this should not happen again |
| `model` | a model key the owner put in `~/.config/pocketbrain/keys/` (for the conflict check or the sleep pass) isn't loaded in the hub, so those steps quietly run rule-only. `start` also prints which keys it ignored and why |
| `disk` | under 1024 MB free on the brain's disk (once the hub has run `start`) |
| `restore_drill` | once backups are set up and the Sunday restore test has run: its last run failed, or it hasn't run for 8 days ([backup.md](backup.md#the-sunday-restore-test)) |
| `restarts` | the hub started 5 or more times in 6 hours without a plan (each `start` adds a line to `log/starts.jsonl` with its `kind`): it is crashing and coming back. An update (new build or HEAD moved), a reboot, the updater's or watchdog's `deploy.restart` mark and the menu's Restart hub are `planned` and don't count (G394) |

### The daily self-check: early warnings

The same probe also looks for what would otherwise end in a hand fix before the owner notices (`selfChecks` in `src/probe.ts`). These are warnings: each raises one alert (`check: probe_warn_<name>`) through the same path, but doesn't count as a hub failure, so it doesn't break the streak. The fix it leads to still does, if done by hand.

| Check | Warns when |
|---|---|
| `connections` | an assistant that read the brain in the last 14 days has been silent for 3 days: its token or connection probably stopped working (paused agents and the gardener are left out) |
| `logs` | the `.json` and `.jsonl` files directly in `log/` total over 500 MB (`PB_LOG_MAX_MB`); names the biggest. Subfolders such as `log/sources/` aren't counted |
| `release` | `main` has had changes the `release` branch lacks for over 7 days, from the auto-update's `deploy.json` (`unreleased_since`, see [release.md](release.md)). Not checked while auto-update is on hold (`deploy.ts hold`) |

A gardener that missed its night isn't a warning here: the job check `gardener_runs` fails for it, per hours window ([gardener.md](gardener.md)).

Tokens don't expire on their own, so there is no expiry date to watch; a connection that stopped working shows up as `connections`.

The digest's "Numbers" carry one line for every check the probe last recorded in `log/probe.json` (door, job and self-checks together): `Self-check: all 14 ok`, or `Self-check: 2 of 14 failing (disk, door); see Needs you`, where each failing check is listed until it passes.

A check that turns to failing raises one alert (`agent: hub, check: probe_<name>`), which texts the owner and breaks the streak; while it stays failing the bar can't be met. Job outcomes are kept in `log/start-state.json` (`<job>_at`, `<job>_error`).

### One ledger for every job

Every scheduled job leaves one heartbeat when it ends, in `log/heartbeats/<job>.json` (`src/heartbeat.ts`): when it ran, whether it worked, how long it took, and when it last worked. One file per job, so the hub, the watchdog and the offsite copy (three processes) never lose each other's line. The jobs: `night`, `digest`, `searchable`, `backfill`, `trust`, `housekeeping`, `audit`, `pull` (from `recordJob`), `backup_look`, `origin_push`, `offsite`, `restore_drill`, `probe`, `watchdog`, and the Gardener's `gardener_cleanup`, `gardener_rotate`, `gardener_jobs`. Each has a cadence (`CADENCE`): a job is **late** when its last good run is older than that (36 hours for the nightly ones, 6 for the hourly backup look and push, 48 for the offsite copy, 8 days for the Sunday test and the weekly audit, 12 for the probe, 1 for the watchdog), and **failing** when its last run failed. A job that never ran is neither, so a new brain, or the offsite copy before it is turned on, shows nothing.

| Where | What |
|---|---|
| The home | one line under the count, only when a job is late or failing: "Your night pass has not run for 2 days. Settings has the details." It is not an ask: no card, and nothing added to the count (G691) |
| Settings, "Scheduled jobs" | the Sunday restore test's line, each late or failing job with when it last worked, and how many are on time |
| `pocketbrain doctor` | a `jobs` warning per late or failing job, or "all N scheduled job(s) on time" |
| `pocketbrain week` | "Scheduled jobs: N of M on time", and which are behind |
| `pocketbrain jobs` | the whole ledger, one line per job; exits 1 when any is late |

The probe's job checks above stay as they were (they alert and break the streak); the ledger is what the owner's screens read.

## Where it shows

| Where | What |
|---|---|
| `pocketbrain bar` | the line above |
| `digest/<date>.md` "Numbers" | the same line, every morning |
| `pocketbrain week` | "Hand fixes" and "Hub failures" rows per day, the bar line, a "Hand fixes and hub failures" verdict (any is "fix first"), and the [brain health](#brain-health-in-the-week-report) lines |
| The dashboard's Settings | a "Real-use bar" card: the day of the streak and its last break, days since the last hand fix and what it was, and the restore drill (passed, failed or not run yet) |

Logs: `log/fixes.jsonl` (`{at, what, via}`), `log/hub-runs.jsonl` (`{at, ev, signal?}`), `log/alerts.jsonl` (probe checks are `agent: hub, check: probe_*`), `log/drills.jsonl`, `log/reads.jsonl`.

Probe failures are counted as hub outages, not as forged commits (before 2026-10-15 they also raised the "Forged or wrong-author commits" stop verdict).

## Brain health in the week report

The bar says whether the brain was used without hand fixes. It doesn't say whether the brain is slowly going bad. `pocketbrain week` ends with a "Brain health" section of eight lines to show that. Each line has one number, its count, last week's number, and the one action that improves it. A line at 0% has no action. The lines contain counts only, never a value, title or source.

| Line | Counts | Fix it with |
|---|---|---|
| Facts with no live source | Facts in force (each live list item counts once) that have neither your word nor an exact ref (a message, event or document). A fact whose source the pull found moved or gone (`recheck`) counts too. An agent's own memory, a vague pointer and `unverified` are not live sources. | `pocketbrain sources backfill <source>`, which searches your mail for each such fact and adds the mail that still says it as its source (`sources pull` does the same as new mail arrives) |
| Stale facts that change over time | Facts whose attribute has a `shelf_life` in rules/checks.yaml and that were last confirmed more than twice that long ago | the Brain's "To recheck" (Still true, Change) |
| Conflicts open more than 7 days | Open conflicts older than a week, out of all open ones | Waiting on you on the home, each settled on its own screen |
| People and projects with no wiki summary | Person and project notes, not archived or superseded, without a `summary:` line (docs/wiki.md). An assistant asking who someone is gets the summary instead of a list of facts. | nothing by hand: the Gardener writes up to 3 a night and 10 a week from the page's facts, while `pocketbrain wiki sync on` lets it |
| Gardener writes the hub refused in 7 days | The Gardener's `wiki_sync`, `remember` and `retire` calls in `log/calls.jsonl` over the last 7 days that the hub refused. Pages stay empty and facts go unwritten when the hub refuses what the Gardener writes, not only when it doesn't run; otherwise a refused write shows only in the Gardener's own transcript. | nothing by hand while it stays low: each refusal says what to change and the Gardener tries once more; if it stays high, `pocketbrain week` lists the refusal kinds |
| Notes not linked to any other note | People, org, project, decision, note and money notes (not merged) with no `[[link]]` to or from another note, in their text or facts (docs/wiki.md). An island is a note an assistant only finds by searching for it. | nothing by hand for names: upkeep links a name that fits exactly one note each night (docs/wiki.md, "Names become links"); for the rest, add a `[[link]]` where one note mentions another |
| Links to a note that doesn't exist | Links from those notes to an id no note has, out of all their links | the `broken-link` review lines in the digest: point each at the right note, or remove it (upkeep already repoints one that matches a single note's name) |
| Notes no assistant read in 90 days | Notes at least 90 days old that no assistant read (the Gardener's reads don't count, as in forgetting). The line says "no data yet" until reads go back 90 days. | nothing by hand: the nightly pass forgets their facts once they pass their shelf life, and `pocketbrain undo --run` brings one back |

Each week report adds its percentages to `log/health.jsonl` (`{date, pct}`), and the next report reads last week's numbers from there. Running a report again for the same day doesn't add a row. Code: `src/health.ts`.

## In the morning digest

Under "Needs you", every day until they're resolved:

- **Hub problem**: each health check still failing, with what failed and since when. The alert texts once; this line keeps it in view.
- **Hand task**: what only the owner can do, added with `pocketbrain task "<what>" --cmd "<exact command>"` (by the owner, or by a session that hit something only the owner's hands can do, such as a key into their password manager). The command is optional but should be there whenever one exists, so he never has to work it out; neither may hold a secret (it names where the secret lives instead). `pocketbrain task` lists them with their commands, the digest shows each with its command, and `pocketbrain task --done <n>` closes one. Log: `log/owner-tasks.jsonl`.

The week scorecard also totals the stale, due and disputed facts agents were handed (each went out with its label).
