# Production readiness

What happens to the hub and the brain when something breaks, case by case, and how each answer is known. A case is **covered** when a test or a scheduled check fails if the answer stops being true, **not covered** when the code was read and the answer is wrong or nothing checks it, and **unknown** when nobody has tried. A not-covered case has a gap id in `evals/gaps.ts` and is closed by a test seen failing first.

First written 2026-11-19 from a read of `main`. Keep it true: a fix moves its row to covered in the same branch.

## The list

| # | What breaks | State | How it is known |
|---|---|---|---|
| 1 | The hub is killed in the middle of an assistant's write | covered | `test/crash-safety.test.ts` (torn log lines, git locks left behind, a commit that can't be made is never reported as made), `test/restart-recovery.test.ts`; `bun run crash` kills a real hub at random moments and checks every acknowledged write is in git |
| 2 | The hub is killed during the night pass | covered since G1011 | Before: the pass was marked done for the day when it began, so that night was skipped and nothing said so for 36 hours. Now a pass that began and never ended runs again at the next start, once; cut off twice, it is recorded as failed. `test/start.test.ts` |
| 3 | The hub is killed between two steps of a longer job (a capture, a pull, a memory correction, an ask to see) | covered | `test/restart-recovery.test.ts`, one test per job |
| 4 | A restart undoes something the owner or the hub already settled | covered since G1012 | The start's repairs are one list (`START_REPAIRS`, `src/start.ts`). `test/start-twice.test.ts` runs it twice on a made-up week, then after an answer, a keep both, an Undo and a set-aside that removes pages: each start must change nothing. The repair that moved 26 settled items back to the inbox on 2026-11-19 was G1006 and G1007 |
| 5 | The hub hangs without dying | covered | The watchdog (`src/watchdog.ts`, its own launchd job) restarts it after two missed answers; `test/watchdog.test.ts` |
| 6 | The watchdog restarts the hub during a deploy | not covered | Read only: a deploy's restart is shorter than the watchdog's two misses five minutes apart, so they should not meet, but neither knows of the other and no test holds them apart. Open, G1013 |
| 7 | A deploy leaves a hub that is up and wrong | covered | `test/deploy-go.test.ts`: the restarted hub must report the new sha or the deploy rolls back |
| 8 | The machine is lost: restore onto a clean one | covered on made-up data, unknown on the real backup and a second machine | `test/backup.test.ts`, `test/restore-hardening.test.ts`, CI's `drill --demo`, and the Sunday restore test (`src/restore-drill.ts`). Nobody has yet restored the real backup, with the real key, on a machine that never held the brain. Procedure below |
| 9 | A backup stops being made, or the offsite copy stops | covered | Heartbeats and the probe's job checks (`src/heartbeat.ts`, `src/probe.ts`), `test/offsite.test.ts`, `test/origin-push.test.ts` |
| 10 | A source is down or slow for a day | covered | A stalled pull ends and frees the write queue (`test/pull-timeout.test.ts`); a failing source is one alert a day; a source silent for 72 hours is a failing check |
| 11 | A source's sign-in expired | covered for being told, unknown for the wording | The pull fails with the source's reason and alerts once a day (`test/pull.test.ts`). Whether the owner's line names the one command that fixes it has not been read on a real expiry |
| 12 | The tunnel or the public door is down | covered for being told | The probe checks the public door and the OAuth door and alerts once (`test/probe.test.ts`); launchd keeps the tunnel running. Assistants get nothing while it is down; nothing queues their writes |
| 13 | The disk is full | not covered | The probe warns under 1024 MB free. No test fills a disk: what a write, a log line and a state file do at "no space left" is unknown. Open, G1014 |
| 14 | The hub's own state files are cut short by a crash | covered since G1015 | `log/start-state.json` and `log/watchdog.json` are written beside themselves and renamed over (`writeWhole`, `src/util.ts`), as heartbeats and the read log already were. `test/state-files.test.ts` |
| 15 | The brain's git repository is damaged, or its private copy has other history | not covered | `git fsck` runs only inside a restore. The hub starts on a damaged repository without looking; a private copy that diverged shows only as a push that keeps failing. Open, G1016 |
| 16 | The kill -9 check itself stops being run | covered since G1017 | It ran only by hand and had come to fail on every run, on its own synthetic log. Fixed, and CI now runs a short one on every pull request (`test/crash-check.test.ts`) |
| 17 | A night job runs past its time | covered | Recorded as failed at once while it keeps running (`runJob`, `test/probe.test.ts` "absence") |

## A real restore drill

The one case only the owner's machine can answer (row 8). It changes nothing in the brain, its settings or its backups: it reads the newest offsite backup and restores it into a scratch folder. It needs the owner's own go-ahead because it uses the backup key.

1. On a machine that never held the brain (or a new user account on the Mac), install the app from the public repository and stop there: no `init`.
2. Copy the newest backup file from the synced folder to that machine. Note its size and time.
3. Run `pocketbrain restore <backup file> --to <empty folder> --identity <key file>` with the key from the password manager, as `docs/backup.md` says. Time it.
4. In the restored folder run `pocketbrain doctor`. It must have no FAIL line.
5. Compare counts only, never values: the number of notes and facts the restore prints against `pocketbrain week` on the live hub.
6. Delete the restored folder and the copied backup file.

Pass: steps 3 to 5 work from the written steps alone, with nothing fixed by hand. Anything that needed a hand fix is a finding and becomes a failing test.

## The standing security review rule (proposed, not yet in force)

Today `CLAUDE.md` asks for `/security-review` when a branch "touches access, sign-in or secrets", and `.claude/rules/access-core.md` loads for eight files. Neither names the code that moves data off the machine, which is where the hourly push of the brain and the public mirror came from. Proposed, for the owner's yes:

1. **One list, in code.** A registry of "data leaves here" surfaces beside the access-core registry (`test/contracts/registry.ts`): backup, offsite copy, the push to origin, the public export and sync, export bundles, the relay and act door's sends, source pulls, the support bundle, and `scripts/outbound-hosts.txt`.
2. **The gate enforces it.** `scripts/gate.ts` already refuses an access-core change without a recorded slice audit. The same rule for this list: a branch that changes one of these files needs a recorded security review for its exact tree, or the gate says no.
3. **The words live in three places that already exist**: a row in the Laws table of `CLAUDE.md`, a new rule file beside `.claude/rules/access-core.md` that loads when one of these files is edited, and the Security section of the pull request template.
4. **Each review answers four questions**: what leaves the machine, to where, who can read it there, and how the owner turns it off.
