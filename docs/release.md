# Releases, CI and the Mac's auto-update

How a change gets from a branch to the hub on the Mac, and who has to do what. Short version: every branch reaches `main` through a pull request that passes CI, the merge gate and a code review ([Pull requests](#pull-requests)), and `main` runs CI on every push. Today the Mac runs a `main` sha: the coordinator says "go <sha>" and the Mac thread runs `bun scripts/deploy.ts go <sha>`, which keeps it only when the restarted hub itself reports that sha, then prints the real brain's north star ([The Mac takes a main sha](#the-mac-takes-a-main-sha)). The release flow below (a dated version cut on `main`, a CI-made tag `vX.Y.Z`, the Mac following the `release` branch by itself) is kept for when tags exist; none has yet, since cloud sessions can't push tags.

```
branch ──PR (CI + gate + review)──▶ main ──CI──▶ release cut ──CI again──▶ tag vX.Y.Z + GitHub release + `release` branch ──▶ Mac (every 10 min)
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

A backlog item names its lane and is ready for a thread only when it has: **Spec** (what changes, in a sentence or two), **Why now**, **Done when** (checks a test or a command can show), **Blast radius** (lane, and whether it touches the access core, a prompt, or anything the owner has to do), **Test** (the failing-first test). A thread sends back an item missing one of them instead of guessing. Items marked **advisor** get a written finding only, **draft** get a branch the builder doesn't merge without the owner, and the rest go through the gate as usual.

## Regression

Two suites run on every push in CI, and the git pre-push hook runs the plain `bun test` and the evals (then the north-star replay, and on a push to main the merge gate's rules), against the fictional sample brain in `examples/brain` (never the real one):

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

`.github/workflows/ci.yml` runs on every branch push and every PR: gitleaks over the whole history, the personal-term denylist (repo secret `PB_DENYLIST`), a code scan (Semgrep's TypeScript, JavaScript and secrets rules at ERROR severity, pinned, reporting only findings the change adds over the same base the gate's rules use), the [dependency gate](#dependencies), the merge gate's rules (`bun scripts/gate.ts <base> --no-run --no-ledger`: the base is the PR's base, the previous tip on a push to `main`, else `origin/main`; the slice-audit and agent-eval evidence lives in the builder's ledger outside the repo, so CI prints those as notes and blocks on the rest), typecheck, dead code, both test runs, evals, the north-star replay (`bun scripts/north-star.ts`, blocking), the demo. The test and eval steps have their own timeout below the job's, so a hang there shows as a red step rather than a cancelled job. Without the `PB_DENYLIST` secret the denylist step warns and passes. Paid agent evals (`--llm`) never run in CI; they stay with the one batched runner.

## Dependencies

What the package pulls in is checked before anything goes public, in CI on every push (`scripts/deps.ts`):

- **Lockfile.** `bun.lock` is tracked and every `bun install` in `.github/workflows/` uses `--frozen-lockfile`, so CI and a release install exactly what was reviewed (`bun scripts/deps.ts lock`).
- **Licenses.** Every package under `node_modules`, dev tools included, has a license on the allowlist in `scripts/deps.ts` (`ALLOWED`): permissive licenses (MIT, ISC, BSD, Apache-2.0, MPL-2.0 and the like) and the AGPL-compatible GPL family (GPL-2.0-or-later, LGPL-2.1-or-later, GPL-3.0, AGPL-3.0). An SPDX expression passes when every `AND` part does and one side of each `OR` does. A package with no license field, `UNLICENSED`, `SEE LICENSE IN`, GPL-2.0-only, SSPL or BUSL fails `bun scripts/deps.ts licenses`. To keep such a package, read its license and add it to `REVIEWED` with the version and why; a new version fails again until it is read again.
- **Advisories.** `bun audit --audit-level=high` fails CI on a high or critical advisory in any locked package. `bun audit fix` upgrades within the declared ranges.
- **SBOM.** Each GitHub release carries `sbom.cdx.json`, a CycloneDX 1.5 list of what `npm install pocketbrain` brings in (the runtime dependencies and theirs, resolved like Node; dev tools never ship), from `bun scripts/deps.ts sbom`.

## Releases

A release is a tag `vX.Y.Z` on `main` whose `CHANGELOG.md` section is dated and whose version is in `package.json`.

**Versions.** Before 1.0: a change to the brain format or the agent door (anything an owner or an agent must act on) is a minor bump and is listed under **Changed** with what to do; everything else is a patch.

**Changelog.** A branch that changes behaviour adds its line under `## [Unreleased]` in the same branch, in plain words a user would understand, under its group (`### Added`, `### Changed`, `### Fixed`, `### Security`). Anything the owner must do by hand when the Mac takes the release (a rules/ change, a command to run once, a new key) also gets a line under `### Before you update`.

**Release notes.** `bun scripts/release.ts notes <tag>` builds a release's notes from its section (`releaseNotes`, contract in `test/release.test.ts`): opening prose, then **Before you update** first, then Security, Changed, Added, Fixed, then any other group in order. A group named twice (two branches' keep-both merge) becomes one, and a line under no heading goes last as **Other changes**. The tag message `cut` writes and the GitHub release both carry these notes, and `verify-tag` (run by CI on every release) fails a section with no entries, so a tag can't go out with empty notes.

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

`cut` dates the changelog section and sets `package.json`'s version and the README's status line on a `claude/release-X.Y.Z` branch, merges it into `main` and makes a local annotated tag. It never pushes. Pushing `main` is enough: cloud sessions can push branches but GitHub refuses their tag pushes (HTTP 403), so CI makes the tag. On every push to `main`, `.github/workflows/release.yml` asks `bun scripts/release.ts due` whether `package.json`'s version has a dated section and no tag yet. When it has: the whole CI again on that commit, then a check that it matches `package.json`, the README's status line and a dated section with entries (`bun scripts/release.ts verify-tag`) and is on `main`, then CI makes the tag `vX.Y.Z`, then the GitHub release (its text is the release notes, `bun scripts/release.ts notes <tag>`), and last the `release` branch moves to the tag. It only fast-forwards, so an older tag can't move it back. A plain merge to `main` is not due and the workflow stops after its first step. A tag pushed by hand (the owner, from the Mac) runs the same steps and skips making the tag.

## The Mac takes a main sha

How the Mac runs new code today (outside audit 2026-10-27). After the builder pushes `main`, the coordinator tells the Mac thread "go <sha>", and the Mac thread runs:

```sh
cd ~/pocketbrain && bun scripts/deploy.ts go <sha>     # or: go main, for origin/main's tip
```

1. fetches `origin/main`; the sha must be a commit on it (a sha from another branch is refused, nothing moves); on hold, or with uncommitted changes in `~/pocketbrain`, it stops;
2. checks out exactly that commit (detached), runs `bun install --frozen-lockfile`, restarts the hub with a plain `launchctl kickstart -k` of `com.pocketbrain.start`, and waits for `http://127.0.0.1:8787/health`;
3. **verifies**: `/health` answers `{ "ok": true, "code": "<sha>" }`, where `code` is the sha the hub's own checkout was at when that process started serving (`codeAtStart` in `src/util.ts`), not what is checked out now. `code` is answered only to a loopback caller (a `127.0.0.1`, `localhost` or `[::1]` Host and no `cf-*`, `X-Forwarded-For`, `Forwarded` or `Tailscale-*` header), so the public door never names the running sha; `go` refuses a `--health` that isn't on loopback. A healthy hub that reports another sha, or none, has not taken the new code, and counts as a failure like an unhealthy one;
4. on a failure, checks out the sha it ran before, installs, restarts, and records the rollback (`down` if that doesn't come up either);
5. on success, runs the real brain's north star once for that code (`northStarFor` in `src/probe.ts`: `scripts/north-star.ts --brain <brain> --json`, the same run the hub would make 5 minutes after it starts, which then finds the record and skips) and prints its counts line. Report-only: a FAIL, or a north star that can't run, never changes the deploy's status or raises an alert. The brain is `--brain <dir>`, else `$PB_BRAIN`, else the one `init` remembered in `~/.config/pocketbrain/brain`. It only writes `log/north-star.json` there, the untracked file the hub writes; nothing is committed to the brain.

Already on that sha with the hub reporting it: no restart, it says `current` and prints the north star for it. Checked out but never restarted (the hub reports the old sha): it restarts and verifies.

What it prints (the Mac thread reports these lines with the result):

```
2026-10-27T12:00:00.000Z deploying 1a2b3c4 (was 9f8e7d6)
north star (real brain, code 1a2b3c4): FAIL, 8 asks, 6 not about a contradiction, 2 on the home, 63/99 pages ok
2026-10-27T12:01:40.000Z deployed: deployed 1a2b3c4 (was 9f8e7d6); hub healthy and running 1a2b3c4
```

and on a failure, exit 1:

```
2026-10-27T12:01:40.000Z 1a2b3c4 failed (healthy but reported 9f8e7d6); rolling back to 9f8e7d6
2026-10-27T12:03:10.000Z rolled-back: 1a2b3c4 healthy but reported 9f8e7d6, asked 1a2b3c4; back on 9f8e7d6
```

Exit 0 means `deployed` or `current`: the hub said it runs that sha. Where the running sha is recorded, for the owner and the Mac thread:

- `curl -s http://127.0.0.1:8787/health` on the Mac — the live answer, `code` is the running sha (loopback only);
- `bun scripts/deploy.ts status` — `deploy.json`: `sha` (asked), `running` (what `/health` reported), `previous`, `mode: "go"`, and `north_star` (counts only);
- the hub's `update` check (`deployCheck`, in `log/probe.json`, the digest and the dashboard): `deploy go deployed: … running 1a2b3c4; north star FAIL, 8 asks, …`. A `go` record never goes stale (it is a one-off by hand); a rollback, a block or a `down` fails the check like the release follower's.

The first time, the Mac's checkout predates `go`, so: `cd ~/pocketbrain && git fetch origin main && git checkout --detach <sha> && bun scripts/deploy.ts go <sha>` (the checkout is there, the hub still reports the old code or none, so `go` restarts and verifies). The working copy stays detached from then on; hand `git pull`s stop.

## The Mac follows releases

Kept for when tags exist (none has yet). `scripts/deploy.ts run` runs every 10 minutes under launchd (`com.pocketbrain.update`). Each pass:

1. fetches `origin/release` and its tags; the tip must carry a `vX.Y.Z` tag;
2. stops if `~/pocketbrain` is already on that tag, if `~/pocketbrain` has uncommitted changes (it never overwrites them), or if it is on hold;
3. checks out the tag, runs `bun install --frozen-lockfile`, restarts the hub with a plain `launchctl kickstart -k` of `com.pocketbrain.start`, and waits about 90 seconds (up to three minutes if the hub is slow to answer) for `http://127.0.0.1:8787/health`;
4. if the install fails or the hub doesn't come back healthy, checks out the version it ran before, installs and restarts again, and records the rollback.

It never touches the tunnel, never boots anything out, and never reads or writes the brain (only `go` runs the north star on it, read-only apart from `log/north-star.json`). Each pass writes `deploy.json` in the config folder (`~/.config/pocketbrain`), including `unreleased_since`, the date of the oldest commit on `main` that `release` lacks (the hub's self-check warns after 7 days); the hub's health probe (`src/probe.ts`) turns a rollback, a block, a failed fetch, or a pass that stopped running for over 3 hours into one `hub` alert, which reaches the owner like any other.

```sh
bun scripts/deploy.ts status          # the last pass
bun scripts/deploy.ts hold            # stay on this version (unhold to follow releases again)
bun scripts/deploy.ts run             # one pass now
```

It only moves forward: a hub that `go` put on a `main` commit the release tag doesn't contain stays where it is (`current`, "not moving back").

A bad release is fixed forward: cut a new release with the fix (or with the change reverted). After a rollback the hub stays on the old version, and later passes leave the bad tag alone, until a newer tag reaches the `release` branch.

**Setting it up on the Mac** (once, by the owner, in the Mac thread). The working copy moves from following `main` by hand to running tags, so hand `git pull`s stop:

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

## The public repo and the site

The public repo (`pocketbrain-oss`, beside this repo under the same GitHub owner; `PB_PUBLIC_REPO` names another) holds what `main` holds, and pocketbrain.dev names the newest release (owner, 2026-10-31: the public repo is always in sync with what is built, and the site never names a version that isn't tagged).

**The public repo follows `main` by itself.** `.github/workflows/public-sync.yml` runs after `ci.yml` passes on a push to `main`, for `main`'s tip only (an older green run skips):

1. `sh scripts/public-export.sh` writes the tracked files minus `scripts/public-exclude.txt` and refuses if any term of the private denylist (repo secret `PB_DENYLIST`: the employer, school, family names, addresses, phones) is in them. Without the secret it refuses; it never publishes unchecked;
2. gitleaks scans the export; only a rule already allowed for the same test file in `.gitleaksignore` passes (`bun scripts/public-sync.ts leaks`), anything else stops it;
3. the export replaces the public repo's files as one new commit on its `main`, `pocketBrain <version> (main)` with a `Source: <private sha>` line and no private commit subject, pushed with the deploy key in repo secret `PB_OSS_DEPLOY_KEY` (write access on pocketbrain-oss only). Never a force push; a commit that changes nothing is not made.

The public repo keeps its own history of these commits; the private history (which holds unscrubbed early docs) never goes there. The sync workflow and its test are left out of the export.

**CI on the public repo.** The public repo runs the same `ci.yml` and `release.yml`. Its commits have other shas than the private ones, so the fingerprints in `.gitleaksignore` (commit:file:rule:line) never match there: in `pocketbrain-oss` the gitleaks step scans the checked-out tree and applies the same file-and-rule check as step 2, instead of the whole history. Nothing CI needs may live only in a file `scripts/public-exclude.txt` leaves out: `scripts/film/take.ts` once gave every file the DOM types, so the public typecheck failed until `tsconfig.json` named `DOM` itself (`test/public-ci.test.ts` holds both). The docs keep naming left-out files and the secrets only they read: the docs tests count a path in `scripts/public-exclude.txt` as present, and a name on its `# names:` line as read (`test/excluded.ts`). When a dated version reaches the public repo untagged, its `release.yml` tags it and publishes the GitHub release there too.

**The site follows tags.** The site's one version is the `data-pb-version` attribute in `site/index.html` on branch `claude/pocketbrain-site` (never merged into `main`). After a release is tagged, the thread that cut it updates that version and the site's status and "What you see" lines from the release's **What you see** section, pushes the branch, and the coordinator asks the Mac thread to deploy it (the cloud can't reach Cloudflare):

```sh
cd /tmp && rm -rf pb-site && mkdir pb-site && git -C ~/pocketbrain archive origin/claude/pocketbrain-site site | tar -x -C pb-site
cd pb-site/site && npx wrangler pages deploy . --project-name pocketbrain --branch main
```

**The installer's address is the site's.** `install.sh` clones from `https://pocketbrain.dev/git`, and the quick start's one line fetches `https://pocketbrain.dev/install.sh`. Both are routes of the site's counter worker ([site-analytics.md](site-analytics.md)), which isn't deployed yet, and the installer takes the newest `v*` tag, which the public repo doesn't have yet (the sync pushes commits, not tags). Until both are there, the README and the quick start install from a clone, and `bun scripts/docs-live.ts` fails on any `pocketbrain.dev` address a doc names that doesn't answer.

**Checking both.** `bun scripts/public-sync.ts check` reads the live site and the public repo and prints IN SYNC or OUT OF SYNC with what lags: a site naming a version that is not a tag, or not the newest tag; a public repo whose last commit names another source than `main`'s tip, or another version. `--site <file>` checks a site file before deploying it, `--no-site` and `--no-public` check one side. `verify-tag` (CI, on every release) also refuses a tag whose README status line names another version, and `cut` moves that line with `package.json`.

## Pull requests

Owner, 2026-10-31: every thread branch lands through its own pull request with a code review, so each change has one page holding its diff, CI, review and evidence.

1. **The thread** pushes `claude/<name>` and opens a pull request against `main` from `.github/pull_request_template.md`, filling every section (or "none"), and asks the builder to land it. One branch, one PR; a follow-up fix is a new commit on the same branch.
2. **The builder** replays the branch onto `main`'s tip as today (replayed shas differ from the thread's) and pushes it back to the same branch (`git push --force-with-lease`; the branch is the builder's once handed over), so CI, the slice audit and the gate all see the exact tree that will land.
3. **The builder reviews it**: `/merge-gate` on that head, with `/code-review --comment <PR number>` as its fresh-eyes step, so the findings are inline comments on the PR, and a security pass, `/security-review` on the same diff (owner, 2026-10-31: "run security scan on pr"), its High and Medium findings posted as one PR comment. A finding that affects correctness, security or a law goes back to the thread as a failing test on the same branch; the rest are optional. When the access core changed, the slice audit's report is linked in the PR.
4. **The builder merges** with a merge commit (**Create a merge commit**, never squash or rebase merge) once the `test` check is green on that head and the gate said MERGE. The replayed commits land with the exact shas and trees that CI, the slice audit and the gaps' `closed:` cites saw. Branches audited together may land as one PR. The Mac is given the `main` sha.

A release cut goes the same way: `bun scripts/release.ts cut` builds `claude/release-X.Y.Z` locally, then the builder pushes that branch and opens a PR from it instead of pushing `main`; its merge is the push to `main` that `release.yml` tags. The ruleset goes on only after v0.2.1 is tagged, so the queue ahead of that cut lands directly as before.

The ruleset on `main` (owner, set once in Settings, Rules, or by a session with admin rights after the owner's word): pull request required, 0 approvals (the builder and the threads act as one GitHub account, which can't approve its own PR), required status check `test` (the `ci` workflow's job; not `release` or `public-sync`, which push tags, the `release` branch and the public repo, never `main`), merge commits allowed and linear history not required, no force-push, no deletion, no bypass list. Not "branch must be up to date": the builder already replays onto the tip before merging, and a strict check would rerun 20 minutes of CI for every other open PR after each merge. It never restricts tags, or CI can't tag.

## Docs

Docs that no longer match the code are a bug (project rule 11), and two tests catch the drift a test can see, so CI fails on it:

- `test/docs.test.ts`: every `pocketbrain` command and flag named in a code span is one the CLI has, every `bun run` script is in package.json, every path in a code span exists, every CLI command and MCP tool is named somewhere, known overclaims stay out, and public docs speak to any owner.
- `test/docs-truth.test.ts`: links to a section of a doc land on a heading, repo paths named in sentences exist, `pocketbrain <command> <subcommand>` is one `help --all` lists, the environment variables and key names the code reads are named in the docs and the other way round (names only), package.json, README's status line and the newest dated CHANGELOG section name one version, the changelog opens with `[Unreleased]` and runs newest first, every gap id it cites is named by code or tests, CLAUDE.md's map lists each file once, every doc is linked from another, and the phone doc's Settings list is the dashboard's.

What needs the network is `bun scripts/docs-live.ts`: every `https://pocketbrain.dev` address inside a doc's shell block must answer. CI's `docs-live` workflow (`.github/workflows/docs-live.yml`) runs it on every push to `main` and daily, so a site change that breaks a doc shows within a day; run it by hand after a site deploy and before a public post; `bun scripts/public-sync.ts check` is its partner for the site's version and the public repo.

## Who pushes

| Step | Who |
|---|---|
| Open a pull request | the thread that wrote the branch |
| Merge a pull request into `main` | the builder thread, after `/merge-gate` says MERGE on the replayed head, its `/code-review` is on the PR and `test` is green |
| Cut a release | the builder, after a merge batch, when CI on `main` is green and nothing waits on a paid eval or slice audit; the release branch lands by PR and CI makes the tag |
| Deploy to the Mac | the Mac thread, on the coordinator's "go <sha>": `bun scripts/deploy.ts go <sha>`, reporting its last lines (verified sha, north star). Once tags exist and the update job is installed, the Mac also takes a tag by itself once its CI passed |
| Public repo | CI's public-sync workflow, after CI passes on `main` (owner, 2026-10-31); a first-time push or any other change to it, the owner only |
| The site | after each tag, the thread that cut it updates and pushes `claude/pocketbrain-site`; the Mac thread deploys it on the coordinator's word |
| npm, `rules/` in the brain | The owner only |

GitHub enforces the rest: the ruleset on `main` above, and on `release` no force-push, no deletion. Neither restricts tag creation, or CI can't tag.
