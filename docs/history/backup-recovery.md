# pocketBrain: backup and recovery

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

> Status: proposal, 2026-10-08; storage and key choices confirmed by Louis the same day. Builds on the agreed v1 in [architecture.md](architecture.md) section 0 (Markdown in a private git repo, compiled per-agent views, own-area direct writes, an upkeep agent `reflect` whose fixes are revertable commits). Not yet reviewed by Louis.

Once every assistant reads from the brain, losing it or poisoning it hurts all of them at once. This doc covers three questions: where the copies live, how to undo damage at different sizes, and how to know a backup actually restores. It is sized for one person: **about 30 minutes of setup, then zero recurring chores**. Anything that needed Louis to remember to do it was cut (see section 6).

## 1. The challenge to "git history is the backup"

The README says "Git history is the backup and the audit trail. Nothing an agent does is unrecoverable." That is half true.

- **Git protects against bad edits**, as long as history is never rewritten. A bad write is one `git revert` away.
- **Git does not protect against losing the repo**: a deleted or locked GitHub account, a leaked token that force-pushes `main`, or the laptop and GitHub both being unavailable. History is only a backup if a copy of it exists somewhere the same failure can't reach.
- **Git does not make recovery easy at scale.** Reverting one commit is easy. Reverting "everything Town wrote this morning, but not Louis's edits in between" needs commits tagged well enough to select them, which has to be designed in from the first write.

So the plan is: make history impossible to destroy from where agents sit, keep one copy outside GitHub, and stamp every commit so that undo can select by agent, run, or time.

## 2. What needs backing up (v1)

The rule that keeps this small: **everything that matters is in the repo, and everything outside the repo can be rebuilt.**

| Thing | Where | Backed up? |
|---|---|---|
| Notes, facts, `rules/`, `policy.yaml`, `inbox/`, `comms/`, canary notes | repo | Yes, it is the repo |
| Hash-chained write/read log | repo (`log/`, append-only) | Yes, with the repo |
| Compiled per-agent views, FTS index (later) | build output | **No.** Rebuilt from `main` by `pocketbrain build` |
| The `age` private key (decrypts `secret` notes and backups) | Louis's 1Password + one paper copy | **Yes, separately.** Lose it and `secret` notes and the off-site copy are unreadable |
| Connector credentials (Gmail, calendar for `reflect`), agent credentials | wherever each is issued | No. Re-issued, not restored |
| Notion "Second Brain" | Notion | Kept read-only as a day-zero fallback for the period [bootstrap.md](bootstrap.md) sets, with Louis's native Notion export zip kept alongside the off-site copies |

**Guardrail for later phases:** the phase 2 live server, the control panel and anything after them must keep this rule. A new piece of state either lives in the repo or can be rebuilt from it. If something can't meet that (OAuth client registrations, for example), it has to be listed in this table with its own backup before it ships. challenges.md section on portability already warns that this is how "git clone moves the brain" quietly stops being true.

## 3. Where the copies live

Three copies, on three different failure domains, with nothing manual:

| # | Copy | How it stays current | What it protects against |
|---|---|---|---|
| 1 | **GitHub private repo** (`your-user/pocketbrain-data`), the primary remote | Every write goes here through the single committer | Laptop loss |
| 2 | **Louis's laptop checkout** | The build script and `reflect` pull before every run, so it is always a full clone; the laptop's own system backup (Time Machine or equivalent, if on) covers it too | GitHub outage or account loss |
| 3 | **Off-site encrypted bundle** in the cloud storage Louis already pays for (decided 2026-10-08), in a `pocketbrain-backups/` folder | The laptop's scheduled job (the one that runs `reflect`), nightly when `main` has moved: `git bundle create --all`, encrypt with the `age` **public** key, write a dated file into the synced folder | GitHub and laptop failing together, or an attacker with GitHub access |

Why this shape:

- **No new provider and no new credentials.** The job writes into a folder the cloud service's own desktop app already syncs, so nothing in GitHub can reach the off-site copy at all. Someone who takes over GitHub can't touch it.
- **Dated files, never overwritten**: `brain-2026-10-09.bundle.age`. Keep every daily file for 30 days and the first of each month forever. A repo this size makes that a few megabytes a year (*inferred*).
- **The trade-off Louis accepted: weaker delete protection.** Unlike a locked bucket, anyone signed in to that cloud account, or with the laptop unlocked, can delete the folder. The service's own trash and version history (usually 30 days, *not checked for your service*) is the only safety net. Acceptable for a one-person brain, because losing the off-site copy alone loses nothing while GitHub and the laptop are fine.
- **It depends on the laptop being awake.** If it sleeps for a week, the off-site copy is a week old. The freshness check in section 5 catches it.
- **A git bundle, not a file sync.** It carries full history, so restoring it gives back the audit trail, not just today's files.
- **Not a second git host mirror** (GitLab, Codeberg). A push mirror would replicate a force-push or deletion just as faithfully. Locked, versioned snapshots don't.

### Protecting history at the source

These cost nothing and stop most disasters before backups matter:

- **Agents never hold git credentials.** In v1 they write through the write path, and the one committer pushes. A rogue agent can produce bad commits but cannot rewrite or delete history.
- **Branch protection on `main`**: no force-push, no deletion, for everyone including admins. Louis's own token included, so a mistyped command can't do it either.
- **Rollbacks are always new commits** (`git revert`, or restoring files as a new commit). Never `git reset --hard` plus push on `main`. This also keeps the hash-chained log valid, because nothing in it disappears.
- **Day-zero tag**: the Notion import commit is tagged `import/notion-YYYY-MM-DD`, the oldest known-good state.

The one exception to "never rewrite history" is a secret that should never have been stored (a password, a card number). That is section 4.5.

## 4. Rolling back, by size of the problem

Every commit made by the write path carries trailers, so undo can select precisely:

```
reflect: fix date on people/01JA…/role

Agent: reflect
Run: reflect-2026-10-09T03:00
Kind: auto-fix
Fact-Keys: people:01JA…:role
```

`Agent` comes from the identity the write path stamped, not from anything the agent typed, so it can be trusted for selection.

### 4.1 One bad automated fix

Already in the design: each `reflect:auto` fix is its own commit, listed in the digest, revertable in one tap. One addition is needed:

- **A revert must also suppress the fix.** Writes are idempotent and `reflect` runs nightly, so without a suppression it will re-apply the same "fix" the next night. Reverting an auto-fix writes a suppression entry (fact key + the rule that fired) to `rules/suppressions.yaml`, the same file that holds dismissed findings. The fix stays reverted.

### 4.2 A bad run or a bad day

An agent misread a source and wrote twenty wrong facts, or a `reflect` run went wrong.

```
pocketbrain undo --run reflect-2026-10-09T03:00
pocketbrain undo --agent town --since 2026-10-09T08:00
```

- It selects matching commits by trailer, previews the list ("21 commits, 34 fact keys, 3 files"), and on confirm writes **one** revert commit. Everyone else's writes in the same window stay.
- If a later commit by someone else touched the same fact key, that key is **not** reverted automatically. It is listed as a conflict and goes to Louis, because reverting it would silently undo the other writer.
- Views are rebuilt from the new `main` straight away, so the bad facts leave every agent's view.

**Last resort, whole brain to a point in time:** `pocketbrain undo --to 2026-10-08T23:59` restores the tree as it was then, as a new commit. Everything after is lost from the live tree but stays in history, and the preview lists what will be dropped. This should be rare enough that it needs no shortcut beyond the command.

### 4.3 An agent goes rogue in its own area

Owners write directly into their area, so this is the case to plan for: prompt injection or a bad instruction, and Town rewrites `teaching/` wholesale.

**Limit the blast radius before it happens** (two checks added to the ~10 enforced checks in 0.6):

- **No deletes for agents.** An agent can only supersede a fact (`valid_until` closed, new value added). Removing a note or a fact key is refused, so a "rewrite" leaves the old values in the file, not just in git.
- **Bulk-change limit.** One write, or one agent's writes within an hour, touching more than a set number of fact keys (default 20) or more than 25% of an area goes to `inbox/` instead of committing. A normal day stays well under this. A rogue rewrite hits it on the first big batch.

**If it happens anyway:**

1. **Pause the agent**: remove it from `policy.yaml` (one line, by Louis) and rebuild. Its view goes empty and its writes are refused.
2. **Undo**: `pocketbrain undo --agent town --since <first bad write>` as in 4.2.
3. **Check what leaked out**: the read log shows which other agents read the bad facts while they were live. Their own private memories can't be recalled, so the digest names them, and the next view they get marks those facts `disputed → corrected` so they see the correction.
4. **Re-enable** when the cause is understood, ideally on `trial` tier for a while.

### 4.4 Losing the repo

| Situation | Restore from | Steps |
|---|---|---|
| GitHub repo deleted or account locked | Laptop checkout | Create a new private repo, push the laptop clone, re-add branch protection and the off-site Action |
| Laptop gone too, or the laptop clone is suspect | Off-site bundle | Download the latest bundle, `age -d` with the key from 1Password, `git clone brain.bundle`, push to a new repo |
| History force-pushed despite protection | Off-site bundle from before the event | Same as above, choose the bundle by date |
| Off-site folder deleted | Cloud service trash, then GitHub or laptop | Restore from trash if within its window; otherwise just let the next nightly run recreate it from the laptop clone |

Then: re-issue agent and connector credentials, run `pocketbrain build --all`, paste or reconnect views.

### 4.5 A secret that should never have been stored

The one time history is rewritten. Manual, by Louis or Claude Code inside the wall:

1. Rotate the secret first (the password, the card). That is the real fix; scrubbing history is cleanup.
2. Remove it from history with `git filter-repo`, temporarily lift branch protection, force-push, restore protection.
3. Delete the off-site bundles that contain it, and empty them from the cloud service's trash. Backups from before the secret was stored are unaffected.

The "no secret-shaped strings" check in 0.6 exists to make this rare.

## 5. Knowing a backup restores

A backup that has never been restored is a hope. Proportionate version:

- **Once, at setup: a full drill.** On a clean machine or a fresh container, with only 1Password: download the latest bundle, decrypt, clone, run `pocketbrain build --all`, open one `secret` note. This proves the key path, which is the part most likely to be broken and least likely to be noticed. Repeat only after changing the key or the provider.
- **Monthly, automatic: a restore test** run by the same scheduled job as `reflect` (inside the wall, where the private key already is). It downloads the latest bundle, decrypts it, clones it, runs `git fsck`, checks the bundle's `main` matches GitHub's `main` within a day, and runs the build. **It reports only when something is wrong**, as one line in the daily digest.
- **Freshness of the backup itself**: the same job flags if the newest file in the backup folder is older than 3 days while `main` has moved, which catches a sleeping laptop or a broken job. This check runs as a small GitHub Action that only reads the date of the last backup from a one-line `log/last-backup` entry the laptop job commits, so GitHub still never sees the backups.

What this does not cover: whether Louis would notice the digest line. If digests turn out to go unread (the success criteria in 0.4 will show this), a failed restore test should go out as an Instinct text instead, since that is already the escalation channel.

## 6. Cut for proportion

| Considered | Why it's out |
|---|---|
| Daily `good/YYYY-MM-DD` tags | `git rev-list -1 --before=<date>` gives the same thing for free |
| Second git host as a push mirror | Copies a force-push or deletion; locked snapshots don't |
| Backing up views or the index | Rebuildable from `main` in seconds |
| Manual weekly backup check | Nobody keeps it up; the monthly automatic test replaces it |
| Separate database backups | There is no database in v1. Section 2's guardrail keeps it that way or forces the backup to be designed with the new state |
| Encrypting the whole repo at rest | GitHub private repo plus `age` for `secret` notes already covers it; full encryption breaks diffs and the build |

## 7. Setup checklist (one time, about 30 minutes, when the repo is created)

1. Branch protection on `main`: no force-push, no deletion, include admins.
2. Generate the `age` key pair; store the private key in 1Password and on paper; commit the public key to `rules/backup.pub`. The paper copy matters: it is the only way back if the 1Password account itself is lost.
3. Create the `pocketbrain-backups/` folder in the cloud storage you already pay for and confirm its desktop app syncs it.
4. Add the nightly bundle step to the laptop's scheduled job, and the freshness-check Action.
5. Tag the Notion import commit; set Notion to read-only.
6. Run the restore drill in section 5 once.

Additions to other docs, for their owners to pick up: the "no deletes" and "bulk-change limit" checks belong in architecture.md 0.6's list of enforced checks, and commit trailers belong in the write-path function described there.

## 8. Questions for Louis

Answered 2026-10-08: the off-site copy goes to cloud storage Louis already pays for, and the key lives in 1Password plus a paper copy. None open.
