# Releases, CI and the Mac's auto-update

How a change gets from a branch to the hub on the Mac, and who has to do what. Short version: branches go through the merge gate, `main` runs CI on every push, a release is a dated version cut on `main`, CI runs again on it and makes the tag `vX.Y.Z`, and only then does the Mac pick it up by itself, with a health check and an automatic rollback, once its update job is installed (below).

```
branch ──gate──▶ main ──CI──▶ release cut ──CI again──▶ tag vX.Y.Z + GitHub release + `release` branch ──▶ Mac (every 10 min)
```

## Lanes

Every change is in one or more lanes, worked out from the files it touches by `scripts/lane.ts` (contract: `test/lane.test.ts`). Build threads can specialize by lane, and CI prints a PR's lanes in its summary.

| Lane | Files |
|---|---|
| ui | `src/dashboard/`, `src/browser.ts`, their tests and `test/ui/` snapshots |
| backend | the rest of `src/` and `test/`, `package.json`, `bun.lock`, the sample brain |
| evals | `evals/` |
| harness | `.github/`, `.githooks/`, `.claude/`, `scripts/` |
| docs | `docs/`, top-level `*.md` |
| other | anything no rule names (never quietly backend) |

```sh
bun scripts/lane.ts main      # Lane: ui, docs
```

A backlog item names its lane and is ready for a thread only when it has: **Spec** (what changes, in a sentence or two), **Why now**, **Done when** (checks a test or a command can show), **Blast radius** (lane, and whether it touches the access core, a prompt, or anything Louis has to do), **Test** (the failing-first test). A thread sends back an item missing one of them instead of guessing. Items marked **advisor** get a written finding only, **draft** get a branch the builder doesn't merge without Louis, and the rest go through the gate as usual.

## Regression

Two suites run on every push in CI, and the git pre-push hook runs the plain `bun test` and the evals, against the fictional sample brain in `examples/brain` (never the real one):

- **Behaviour:** `bun test` (twice in CI: once plain, once with every read through per-agent cells), `bun evals/run.ts --ci` (the deterministic evals, red team included) and, in CI only, the demo.
- **UI:** `test/ui-regression.test.ts` opens every dashboard page and every browser-door (`/b`) page in Chromium and compares what a person or a screen reader gets (headings, links, buttons, fields, their text) with the saved snapshot in `test/ui/`. It compares structure and words, not pixels, so it is the same on a Mac and in CI. A page with no snapshot fails. Without Chromium (a machine that never installed it), the UI suite skips itself locally; only CI, which counts screenshots, catches that.

- **Every door, end to end:** `bun run e2e` (`scripts/e2e.ts`, CI job `e2e`) starts a real hub with `pocketbrain serve` on a copy of the sample brain and connects one fake assistant through each door the real ones use: a pasted bearer on `/mcp` (like Town), the `/b` sign-in form (like Instinct), `/mcp/oauth` with dynamic registration and PKCE against a stand-in authorization server (like Muse, added with `add --door oauth`), and a token from `add --door local` (like Claude Code). Each door runs the same path: read, write, a write held for review, a hidden note refused, memory sync after `beliefs fix` holding no withheld value or hidden note id (red-team G74), paused by the owner, back, and revoked. Besides the saved answers, a few rules must hold on every door (`invariants` in `scripts/e2e.ts`): a leak fails the run even if someone saved it as the expected answer. The owner's side goes through the CLI and the dashboard's own pause. Then the free switch-day check runs (`bun evals/run.ts --only switchday`). Every answer, and every note id it names, is compared with `test/e2e/doors.json`; a changed answer fails. After a change you meant: `PB_E2E_UPDATE=1 bun scripts/e2e.ts`, then read `git diff test/e2e/`.

A UI change you meant to make:

```sh
PB_UI_UPDATE=1 bun test test/ui-regression.test.ts   # rewrite test/ui/*.aria.yml
git diff test/ui/                                    # read it: this diff is the UI review
```

CI also saves a full-page screenshot of each page (`PB_UI_SHOT_DIR=<dir>`), uploaded as the `ui-shots` artifact of the run, and fails if there are fewer screenshots than snapshots, so a browser that couldn't start never passes as green.

## CI

`.github/workflows/ci.yml` runs on every branch push and every PR: gitleaks over the whole history, the personal-term denylist (repo secret `PB_DENYLIST`), typecheck, dead code, both test runs, evals, the demo. The test and eval steps have their own timeout below the job's, so a hang there shows as a red step rather than a cancelled job. Without the `PB_DENYLIST` secret the denylist step warns and passes. Paid agent evals (`--llm`) never run in CI; they stay with the one batched runner.

## Releases

A release is a tag `vX.Y.Z` on `main` whose `CHANGELOG.md` section is dated and whose version is in `package.json`.

**Versions.** Before 1.0: a change to the brain format or the agent door (anything an owner or an agent must act on) is a minor bump and is listed under **Changed** with what to do; everything else is a patch.

**Changelog.** A branch that changes behaviour adds its line under `## [Unreleased]` in the same branch, in plain words a user would understand.

**Releasable** means all of these, checked by `bun scripts/release.ts check`:

- on `main`, nothing uncommitted;
- something under `## [Unreleased]` (or a prepared `## [X.Y.Z] - unreleased` section);
- the tag is free;
- `bun run check` passes (tests, typecheck, dead code, evals);

and, outside the script: the latest CI run on `main` is green, and no branch merged since the last release is waiting on a paid agent eval or a slice audit (the gate ledger has them).

**Cutting one** (the builder, after a merge batch):

```sh
bun scripts/release.ts cut patch      # or minor; a prepared "- unreleased" section keeps its own version
git push origin main
```

`cut` dates the changelog section and sets `package.json`'s version on a `claude/release-X.Y.Z` branch, merges it into `main` and makes a local annotated tag. It never pushes. Pushing `main` is enough: cloud sessions can push branches but GitHub refuses their tag pushes (HTTP 403), so CI makes the tag. On every push to `main`, `.github/workflows/release.yml` asks `bun scripts/release.ts due` whether `package.json`'s version has a dated section and no tag yet. When it has: the whole CI again on that commit, then a check that it matches `package.json` and a dated section (`bun scripts/release.ts verify-tag`) and is on `main`, then CI makes the tag `vX.Y.Z`, then the GitHub release (its text is the changelog section, `bun scripts/release.ts notes <tag>`), and last the `release` branch moves to the tag. It only fast-forwards, so an older tag can't move it back. A plain merge to `main` is not due and the workflow stops after its first step. A tag pushed by hand (Louis, from the Mac) runs the same steps and skips making the tag.

## The Mac follows releases

`scripts/deploy.ts` runs every 10 minutes under launchd (`com.pocketbrain.update`). Each pass:

1. fetches `origin/release` and its tags; the tip must carry a `vX.Y.Z` tag;
2. stops if `~/pocketbrain` is already on that tag, if `~/pocketbrain` has uncommitted changes (it never overwrites them), or if it is on hold;
3. checks out the tag, runs `bun install --frozen-lockfile`, restarts the hub with a plain `launchctl kickstart -k` of `com.pocketbrain.start`, and waits about 90 seconds (up to three minutes if the hub is slow to answer) for `http://127.0.0.1:8787/health`;
4. if the install fails or the hub doesn't come back healthy, checks out the version it ran before, installs and restarts again, and records the rollback.

It never touches the tunnel, never boots anything out, and never reads or writes the brain. Each pass writes `deploy.json` in the config folder (`~/.config/pocketbrain`), including `unreleased_since`, the date of the oldest commit on `main` that `release` lacks (the hub's self-check warns after 7 days); the hub's health probe (`src/probe.ts`) turns a rollback, a block, a failed fetch, or a pass that stopped running for over 3 hours into one `hub` alert, which reaches the owner like any other.

```sh
bun scripts/deploy.ts status          # the last pass
bun scripts/deploy.ts hold            # stay on this version (unhold to follow releases again)
bun scripts/deploy.ts run             # one pass now
```

A bad release is fixed forward: cut a new release with the fix (or with the change reverted). After a rollback the hub stays on the old version, and later passes leave the bad tag alone, until a newer tag reaches the `release` branch.

**Setting it up on the Mac** (once, by Louis, in the Mac thread). The working copy moves from following `main` by hand to running tags, so hand `git pull`s stop:

```sh
cd ~/pocketbrain && bun scripts/deploy.ts plist > ~/Library/LaunchAgents/com.pocketbrain.update.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pocketbrain.update.plist
bun scripts/deploy.ts run && bun scripts/deploy.ts status
```

Its log is `~/Library/Logs/com.pocketbrain.update.log`.

## Brain format

The brain carries a format number in the `FORMAT` file at its root (`pocketbrain-brain/1`; a brain with no such file is format 1). Code knows the formats up to `FORMAT` in `src/format.ts`. A release that changes how the brain is laid out raises that number and adds a migration in the same file, with a test that runs it. It also freezes a copy of the new layout in `test/fixtures/brain-formats/<n>/` (format 1 is the layout from before the `FORMAT` file). A fixture is never edited once its format ships, and `test/brain-format.test.ts` migrates every one of them to the current format, checks that it loads, that every note survives a save unchanged and that an agent can read it, and fails if a known format has no fixture.

- **An older brain** is migrated: first on a copy of the whole brain (the dry run), and only if every step worked there and the copy still loads, in place, as one owner commit (`Kind: migrate`) that `git revert` undoes. `pocketbrain migrate` shows the dry run and changes nothing; `pocketbrain migrate --apply` runs it. `start` and `serve` apply it by themselves, so an update that needs a migration doesn't wait for the owner. A failed dry run stops `start` with the reason, and the brain stays as it was.
- **A newer brain** than the code knows stops every command, `start` included, with one line ("this brain is format 2; pocketBrain v0.1.3 reads formats up to 1 …") before anything is read or written. `backup` and `drill` stop the same way; `restore` checks the format of what it unpacks and refuses a backup newer than the code, leaving no folder behind; and the scripts that read a real brain (`scripts/gardener-audit.ts`, `scripts/usage-day.ts`) check it first. The updater (`scripts/deploy.ts`) never reads the brain: a hub that refuses to start fails its health check, so the updater reports `down`.

That second rule is what makes a rollback safe. If a release migrated the brain and then failed its health check, the updater goes back to the old tag, and the old hub refuses to start rather than run on a layout it predates. `deploy.json` then says `down`, the hub's log has the line, and the fix is forward: a release that knows the new format (`bun scripts/deploy.ts unhold`, then `bun scripts/deploy.ts run` once it is on the `release` branch). A release that raises the format should say so in its changelog section, since the version before it can't run that brain any more.

## Who pushes

| Step | Who |
|---|---|
| Merge a branch into `main` | the builder thread, after `bun scripts/gate.ts main` says MERGE |
| Push `main` to the private repo | the builder, when the gate passed and `bun run check` is green; CI runs again there |
| Cut a release and push `main` | the builder, after a merge batch, when CI on `main` is green and nothing waits on a paid eval or slice audit; CI makes the tag |
| Deploy to the Mac | nobody, once the update job is installed: the Mac takes a tag once its CI passed |
| Public repo, npm, the launch site, `rules/` in the brain | Louis only |

GitHub enforces the rest with a ruleset on `main` and `release` (Louis sets it once, `release-ruleset-steps.md`): no force-push, no deletion. It doesn't require the `test` check, which would refuse the builder's direct pushes; CI on `main` and the release workflow's own CI run stand in for it. It must not restrict tag creation, or CI can't tag.
