# pocketBrain

**One memory of you, for every AI assistant you use. You own it, it moves with you, and it keeps itself true.**

You use several assistants, each from a different vendor, each with its own memory of you, and none of them agree. pocketBrain is the one memory they all read from and write to: who you are, the people and projects in your life, what you decided, and what changed since. It is a personal wiki of facts, each with the source it came from and the date it was true, kept in plain files you own. Every assistant you connect starts from the same picture of you, and what one learns, the others know next time.

> **Status: early (0.2.1, see [CHANGELOG.md](CHANGELOG.md)), used daily by its author with hosted assistants connected over MCP and OAuth.** It runs end to end on a single owner's brain: import, the write path with sources and conflicts, search (words, and meaning when the local model is on), upkeep and nightly forgetting, the wiki pass, explain, the daily digest, a live MCP and JSON server with per-assistant slices and revocable tokens, an OAuth door, quick capture, agent session logs, hub and replicas, encrypted backups, model spend caps, and an owner dashboard. The agent-to-agent relay runs with its file transport; the live AgentMail path is untested. Install is `git clone` (not on npm or Homebrew). Licensed under [AGPL-3.0](LICENSE).

## Why

If you use more than one assistant, you rebuild your context in each of them, and each one keeps its own copy that drifts. A memory of a person has two kinds of facts: ones that hold (your birthday, who your sister is) and ones that change (your current role, a project's next step, the car you drive now). Vendor memories mix the two, can't tell you where a fact came from, and never notice when it stops being true.

pocketBrain keeps both kinds in one place:

- **Facts with evidence.** Every value carries its source (an email, an event, your own word, an assistant's report), when it was true, and how sure we are. Sources stay where they are; the brain stores the fact and a reference.
- **Changes over time, kept.** A new value replaces the old one and the old one goes to history, so "what is true now" and "what was true in March" both have answers. Facts that go stale have a shelf life, and the upkeep pass rechecks them against their source.
- **Pages that link.** One note per person, organisation, project, decision or topic, linked like a wiki, with a summary at the top that a maintainer agent keeps in step with the facts.
- **Yours, and portable.** Markdown in a git repo on your own machine. Moving it is `git clone`; any tool or person can read it without pocketBrain. Encrypted backups restore on a new machine with one command.
- **Shared with care.** Each assistant gets a token and a slice: the one that books your travel doesn't get your medical notes. The limits are enforced in code, not left to the assistant (see [What the gateway enforces](#what-the-gateway-enforces)).

### Why not just paste a file, or keep an LLM wiki?

If you use one assistant, you don't need pocketBrain. Paste one file into it, or keep an LLM-maintained wiki: raw sources in a folder, a model that compiles and maintains Markdown pages with an index, and no vector database. For one person and one model that's the right setup, and pocketBrain's brain format is close to it on purpose: Markdown in git, a maintainer that writes summaries and looks for contradictions, and embeddings only as an optional, local extra.

It stops being enough once a second assistant needs the same memory, especially one a vendor runs:

1. **Write-back.** Email and calendar are sources; they sync. Conclusions don't. When one assistant works out that "the Acme project is on hold until the audit closes", that lives in its own memory, and the next assistant re-derives it, or doesn't. With a write path, the conclusion lands in the brain once, with its source, and every assistant picks it up on its next read.
2. **Staleness and conflicts.** A pasted file has no shelf life. "Next step: teach session 6 on Sunday" is still in there three weeks later, and when two assistants wrote two different next steps nobody notices. Facts here carry `as_of` and `review_after`, a newer or stronger source replaces an older one and keeps it in history, real disagreements come to you, and the upkeep pass runs while you sleep.
3. **Slices.** The file is one blob. The assistant that books your travel gets your salary along with your flights. Here each assistant's slice is compiled from a policy you write, and a withheld value inside a visible sentence ("renewed the lease at [withheld]/month") stays withheld without you editing prose.
4. **Revocation and audit.** You can't un-paste. Here a paused assistant gets 403 on its next call, `carve --why` explains any fact's presence or absence, and the log shows who read what and when.

The honest limit: a hosted assistant still has whatever it was shown in a session, and vendor memory outside the brain is outside our control. pocketBrain is the memory they share; it cannot reach into theirs.

If you want the pattern without this code, [IDEA.md](IDEA.md) describes it in one page.

## What it is

```
   assistant A        assistant B        assistant C
   (MCP)              (MCP)              (plain JSON API)
       │                  │                  │
       └────────── one URL, per-agent token ─┘
                          │
            ┌─────────────▼──────────────┐
            │  pocketBrain hub           │
            │  read: search, pages and   │
            │    context from the brain, │
            │    within this agent's     │
            │    slice                   │
            │  write: facts with sources,│
            │    changes kept in history,│
            │    conflicts to the owner  │
            └─────────────┬──────────────┘
                          │
              brain repo (truth): Markdown + YAML, git
              upkeep and wiki maintainer, daily digest, owner dashboard
```

Principles:

1. **One memory.** Every assistant reads and writes the same brain. What one learns with a source, the others get on their next read.
2. **Facts carry evidence and time.** Each value has its sources, its `as_of` date and how it was verified. A change keeps the old value in history; a fact that goes stale is due for a recheck.
3. **Portable.** The brain is Markdown with YAML frontmatter in git. Moving it is `git clone`; any tool or person can read it without pocketBrain.
4. **Owned.** It runs on your own machine. Hosted assistants reach it through a tunnel.
5. **Self-checking.** An upkeep agent fixes links and dates, flags facts that are past due, rechecks facts against a source you connected (`pocketbrain upkeep --live`, or Gmail and calendar pulls), and sends contradictions to you; it never settles them itself.
6. **Accountable.** Every write is a git commit authored by the agent that made it, and the write log is hash-chained.
7. **Sliced per assistant, in code.** Each assistant has a token and a carve: which areas, types and attributes it sees, up to which sensitivity, and whether its writes land or wait for you. A hidden note answers exactly like a missing one, and a value an agent was never shown can't come back through its writes, even if it ignores every instruction.

## Your brain is not in this repo

This repo is the **tool**. Your notes live in a **separate, private** git repo that pocketBrain reads and writes. Never commit personal notes, tokens or logs here. The sample brain in [examples/brain](examples/brain) is fictional, and it is also the test fixture. The owner's screens and the UI tests use a bigger made-up one, [examples/demo-brain](examples/demo-brain): about 500 facts of a life, with a week replayed on top ([docs/ui-quality.md](docs/ui-quality.md#the-demo-brain)).

## Quick start

About five minutes on a Mac, Linux, or Windows with WSL. A laptop is fine. You need git and [Bun](https://bun.sh) 1.4; [docs/quickstart.md](docs/quickstart.md) walks through it, including installing those two.

```sh
git clone <this repository's address> pocketbrain && cd pocketbrain && bun install && bun link
pocketbrain init               # a few questions; your brain goes in ~/my-brain
pocketbrain start              # leave it running
```

Then connect your assistant. [docs/connect.md](docs/connect.md) has a page for each:

| Runs on your computer, about 2 minutes | Runs in the cloud |
|---|---|
| Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, Claude Desktop, any MCP app: `pocketbrain add <app> --kind <app> --write --yes`, or pick it in `init` | Claude on the web or phone: needs a fixed public address and a sign-in service, an evening today ([docs/connect/claude-web.md](docs/connect/claude-web.md)). ChatGPT: not supported yet. |

**Want your assistant to install it?** Point it at [docs/install-with-an-agent.md](docs/install-with-an-agent.md): every command runs without questions, and it stops where only you can answer.

Where the brain runs (a laptop, a home server, a VPS, a container) is up to you; [docs/hosting.md](docs/hosting.md) says what the hub needs from a host.

`bun link` puts the `pocketbrain` command in `~/.bun/bin`; `git pull && bun install` updates it. `install.sh` (Bun if missing, then the newest release tag into `~/.pocketbrain/app`, nothing without a release, the tag's signature checked once a release key is pinned) is meant to be served as `curl -fsSL https://pocketbrain.dev/install.sh | sh`, but the site doesn't serve it yet ([docs/release.md](docs/release.md#the-public-repo-and-the-site)).

Working on the code (you need [Bun](https://bun.sh) 1.4 and git):

```sh
bun install
bun test                     # the suite, including attacks on the write path, relay and server
bun run demo                 # the whole story on the sample brain: carve, refuse, hold, settle, digest
bun run demo --dashboard     # the same, then the owner dashboard on the demo copy
bun src/cli.ts help --all    # every command; `pocketbrain` is the same CLI once installed
```

Other ways in and around:

```sh
pocketbrain init ~/my-brain --name "Your name" --agent claude --from-text notes.txt
#   add --from-mbox / --from-ics for a Gmail or calendar export
#   no terminal (CI, a pipe, some IDEs)? these flags, or the answers piped in one per line with --interview
pocketbrain carve claude --preview   # what an agent would get, and what the preview flags
pocketbrain connect claude           # a new token for the agent and what to paste into its connector
                                     # (wider than trial: --code from the agent's dashboard page)
pocketbrain add newbot --slices area:work --yes   # a new trial agent: its slice, token and paste text in one go
pocketbrain consent newbot "handles family logistics"   # say what it is for; see what it would see first
pocketbrain digest                   # what needs you today
pocketbrain doctor                   # is everything healthy
```

Commands find the brain from `--brain`, `$PB_BRAIN`, the current folder, or the one `init` made last.

Adding another assistant later, from picking its door to revoking it: [docs/add-an-agent.md](docs/add-an-agent.md).

`init` writes `rules/` (one trial agent that sees your work area and basic contacts, never money or anything private), one note per person, org, project, decision and money item, a report of anything it removed or guessed, and the agent's token. The seed format is in the quickstart; [examples/seed](examples/seed) has a sample text file and exports. Nothing is sent anywhere and no model is called.

Point an MCP client at `http://<host>:8787/mcp` with `Authorization: Bearer <token>` (a client that can't set headers uses the OAuth door at `/mcp/oauth`). Tokens stop working after 90 days unless rotated. A client without MCP uses the same token on `/v1/...`; the spec is at `/openapi.json`. An assistant that can only browse and fill a password from its vault signs in at `/b` instead, once `pocketbrain connect <agent> --browser` turns that on for it ([docs/browser-door.md](docs/browser-door.md)).

The dashboard is yours alone (it binds to 127.0.0.1). It opens on **On your mind**, one of four tabs (On your mind, Memory, Ask, Who knows; [docs/owner-home.md](docs/owner-home.md)), and only a conflict asks you anything. Settings, at the foot of Who knows, leads to everything else. Besides what is still open and the kill switches, its Brain page lets you search every note, edit any fact or a whole note in place (each save is a git commit by you, and the old value goes to history), or ask a model to make a change, which you see as a diff and approve or discard. After replacing a value you can mark the old one as never right, so history shows a correction rather than a change. Each note has Forget (the note leaves every assistant's view at once; git keeps it and Recently forgotten on the Brain page brings it back as it was) and Change who can see it (hide it from one assistant by name, show it again, or change how private it is; facts you marked private stay private). On the Assistants page you can name one outside assistant as your editor: its writes apply directly instead of waiting in the inbox, every check still runs, each change is listed with a Revert button, and Remove editor takes it back in one click. No editor is set by default.

Coming from Notion: put a raw export under `import/raw/` in the brain and run `bun src/cli.ts import-notion`. Which area a row belongs to is personal, so it lives in the brain's `rules/import.yaml`, not in the code.

## Running it for real

Step by step: [docs/quickstart.md](docs/quickstart.md) to connect a first assistant, then [docs/hub.md](docs/hub.md#a-fixed-address-on-your-domain) for a fixed address that survives a restart. In short, the hub runs on your own machine and binds to 127.0.0.1; a tunnel gives it one URL on your domain; `bun run smoke <url> <token>` checks it from the outside. `build --all` writes `views/snapshots/<date>/<agent>.md`, a dated copy of each agent's slice for when the hub is asleep; it carries the same carve as the live server. Other machines are replicas whose writes queue for the hub, and any of them can become the hub with `pocketbrain hub promote`; `pocketbrain doctor` reports on all of it ([docs/hub.md](docs/hub.md)).

Day to day, as the owner (`pocketbrain help --all` has every flag):

| Command | What it does |
|---|---|
| `pocketbrain dashboard` | your control panel on localhost only; prints a login link |
| `pocketbrain inbox --accept <file>` | answer a proposal (`--reject` to drop it) |
| `pocketbrain dispute --confirm <c-NNNN>` | check an answer the resolver relayed for a private fact (`--reject` if wrong) |
| `pocketbrain owner --msg <id>` | register your real message ids, so a write citing your word can be checked |
| `pocketbrain refs --load <file.json>` | record which Gmail and calendar refs exist, from a connector |
| `pocketbrain write --as <agent> --json '{...}'` | one write through the write path, as that agent |
| `pocketbrain upkeep` | the rule-only tidy pass: links, dates, freshness, duplicates |
| `pocketbrain judge` | near-duplicates judged by a model, set in `rules/models.yaml` |
| `pocketbrain minutes <n>` | log the minutes you spent on the brain today |
| `pocketbrain forget <people/id> --yes` | take a person out on request: note, links, standing, inbox; undo within 14 days ([docs/forget.md](docs/forget.md)) |
| `pocketbrain handover --to "Name" --out <dir>` | a stripped, verified copy for the person taking over, encrypted to their key; never sends |

On a Mac, the menu-bar app shows whether the hub is up and which day of the real-use bar you are on, opens the dashboard, pauses or cuts off an agent, and installs or restarts the hub under launchd: build it with `macos/PocketBrainBar/build.sh` ([docs/menubar.md](docs/menubar.md)).

A sealed edge can answer reads while the hub sleeps, from per-agent cells it can't read itself, and queue writes for the hub; it's a local proof, not deployed ([docs/edge.md](docs/edge.md)).

## The brain format

One note per file; the id is the path. Facts are records with provenance:

```markdown
---
id: projects/course-a
type: project
title: Course A
area: work
sensitivity: personal
facts:
  next_step:
    value: Publish grades
    as_of: 2026-10-07
    sources: ["gmail:f000000000000006"]
    verification: verified-by-source
    by: town
---
Free text, with [[people/jane-roy]] links.
```

A fact can carry `sensitivity` (raised above its file's level, never lowered) and `share_with` (only the named agents ever get it; on a list or a disputed fact, one item or candidate whose `share_with` leaves an agent out hides the whole fact from it). The original format spec, written before the code: [docs/history/memory-shape.md](docs/history/memory-shape.md); `src/brain.ts` and `examples/brain` are what it is today.

The brain repo:

```
rules/        policy.yaml, slices.yaml, checks.yaml, import.yaml, RULES.md, tokens.yaml,
              models.yaml, relay.yaml, hub.yaml, escalation.yaml, owner-messages.yaml,
              oauth.yaml, instructions/   (owner only)
people/ orgs/ projects/ decisions/ notes/ money/ agents/<agent>/
disputes/     conflict packets
inbox/        writes waiting for the owner; reflect/, sleep/, captures/, logs/
journal/      per-agent episodes and session logs, never in other views
comms/        the record of relayed agent mail
digest/       daily digests and the week scorecard
archive/      archived journals
ops/          replica operations waiting for the hub
handovers/    handover packages
log/          writes.jsonl and reads.jsonl (hash-chained), alerts, judgments, usage
views/        built views (not committed)
.cells/       one directory per agent holding only its slice (not committed)
```

## What the gateway enforces

- **Identity is the token.** A request that names another agent is ignored.
- **One cell per agent.** When serving, each agent's reads are answered from a directory that holds only its slice, with links to hidden notes and carved values already removed and no other agent named as a writer. A read's JSON facts name no writer and a `share_with` naming only the reader, with cells or without; a source ref such as `agent:<name>` still says which assistant reported a fact. A bug in the read path can only leak what that agent already holds. A cell is rebuilt when the brain's commit moves or `rules/` changes on disk, so an uncommitted rules edit applies at once, as without cells. Writes, disputes and the relay stay on the hub. (`serve --no-cells` turns this off.)
- **Carve before anything.** Views, search, read and context packs are computed from the agent's carve. A hidden note answers like a missing one, flagged facts never leave, links to hidden notes render as `[[redacted]]`, and a carved value that shows up in visible prose, or in a visible note's title or aliases, becomes `[withheld]`. An agent's write never changes a fact hidden from it: a retire answers like a missing fact, and any other write waits in the owner's inbox with the same reply whatever the hidden value is. A new note's id leaves out a value carved from another agent.
- **Writes run checks that can't be switched off**: schema, `rules/` is read-only, protected paths, secret shapes (secrets belong in a password manager), injection shapes, and approval claims without a message id. A write can't probe for notes it can't see. A note an agent creates gets a random 6-character suffix (`people/sam-carter-3fa1c2`), so a name taken by a note it can't see answers like a fresh one; agents inside the wall keep plain names. That's the default, and the owner can change it. Replaying text already stored in the same fact, which the writer can see, isn't sent back to the owner for its wording.
- **Leak tripwire.** A write carrying a value its author was never shown is refused, and a relayed message carrying a value its recipient can't see is held for the owner; both are logged, including spaced, encoded, look-alike-letter and reformatted-number variants.
- **Other people's health, school, legal or money details** are stored, but forced to private and shared only with the resolver. The word list is French and English (santé, école, casier judiciaire, dettes; chemo, report card, custody, loan) matches whole words with accents at either edge, plurals, French typed without accents and snake_case attribute names (diagnosis_date). Words that would catch ordinary facts (doctor, lawyer, prêt, revenu, payé) are left to the model after-check. The owner's own money words from `pocketbrain init` match with accents too (épargne).
- **Facts file themselves; only conflicts ask.** An assistant's or a source's fact lands on its page without anyone approving it (with Undo). A different value for one the brain holds follows fixed steps (owner's word, then verified source, then exact source, then newer). What they can't settle is filed as a conflict beside the value in use, which stays until the resolver agent or the owner closes it. The Gardener may suggest a side with its sources; it never settles, and your tap is the answer ([gardener.md](docs/gardener.md)). An assistant never replaces a value the owner confirmed, not even with a more precise date or a later `merge: max` value: that goes to the owner to settle. Its retract of a value the owner confirmed waits for the owner too.
- **Agent mail goes through the relay**, which checks each message against the recipient's carve and holds anything it shouldn't see. This holds only once direct mail between your assistants is blocked: `pocketbrain relay --block-plan` prints the block lists, and you apply them with your mail provider's admin key. Until then an assistant can mail another directly, unchecked. A send the mail service refuses is never recorded as delivered: the mail stays unread for the next pass and you get a `relay_failed` alert for it, once a day per message and cause.
- **Split tokens for the main assistant.** A core agent's token can be issued as a reader (its slice below private, no dispute or owner-channel routes, and its citations of the owner's messages wait in the inbox) and a resolver (only those routes), so the token in a vendor's config is not the whole brain. A dispute packet on a private fact, or on one `share_with` keeps from the resolver, never shows the values, to any token, and goes to the owner. An agent that asks by topic and then takes its whole view in one read raises an alert. A token without a role works as before.
- **The owner's guidance reaches each agent scrubbed.** `rules/RULES.md` goes into every view and cell like a note: carved values withheld, links to hidden notes redacted, and other agents' ids, aliases and labels replaced by "another assistant" (so an id that's also an ordinary word, like helper, is replaced too).
- **Kill switches.** `status: paused` on an agent holds everywhere: server, write path and relay. `read-only` stops its writes, dispute moves and outgoing mail; it can still read and receive. A refused write still lands in `log/writes.jsonl` (check `agent_status`), so a paused agent's attempts show in its activity. Tokens are revocable.
- **Assistants can ask to act, never act alone.** An assistant the owner gives an `act` block may ask the brain to send one mail to an address on the owner's list. The brain refuses an unlisted address, a secret or any value outside that assistant's cut (and alerts the owner), marks private values it may see, and holds every mail until the owner approves it in the dashboard, bound to the exact text. A text can only reject it. The transport is a file for now; nothing leaves the machine ([docs/act.md](docs/act.md)).
- **Standing weighs asks, it never opens doors.** You say who matters (`pocketbrain standing set`: inner, close, known); assistants see a person's tier only within their slice and ask `who_is` before acting on a message, so family comes first and a stranger's request waits for you. It matches the sender's address, never the display name, only addresses you or a source vouched for, and no assistant can raise anyone. No check reads it ([docs/standing.md](docs/standing.md)).
- **Rules integrity.** Edits to `rules/` outside git, or commits to it by an agent, go to the top of the digest.
- **The gardener plays by the same rules.** An optional agent flagged `role: gardener` reads everything. While it is on trial it only suggests, a few a day, and each waits for you; once you make it core, its facts file themselves like any core assistant's, and it still never settles a conflict. It may connect only in its hours: its token used outside them pauses it and tells you. It can never be the resolver or own an area, and it never reads agents' journals ([docs/gardener.md](docs/gardener.md)).

Known limits: a paraphrase of a hidden fact gets past any matcher; the read log records what an agent was handed and what it went looking for (`explain`), not what it did with it afterwards; bearer tokens stand in for a hosted authorization server; the injection check is a pattern list; the relay spots asks for a withheld category by its words and a few money-ask phrases, and new wording gets through (eval gap G6). An opt-in small model (the request check, `relay.flag`, `relay: { classify: true }`) reads what the words let through; it stays off by default until its false holds on fee and payment logistics (gap G26) are fixed.

## Models (bring your own)

Every check above is plain code. Models suggest; they never settle a conflict or delete anything. Facts a model reads out of a capture or a source file themselves like any other source's (with Undo); a conflict waits for the Gardener's nightly look, then for you. The other model-judged steps (near-duplicate review, nightly journal consolidation, the check after each agent write, and the dashboard's `dashboard.ask` and `dashboard.edit`) produce review items or proposals for the owner. The one exception only tightens: an opt-in second-opinion classifier can make a fact more private, never less ([docs/aftercheck.md](docs/aftercheck.md)). The provider is set per step in `rules/models.yaml` and defaults to Anthropic:

```yaml
default: { provider: anthropic, model: claude-sonnet-5-5 }          # key from ANTHROPIC_API_KEY
steps:
  upkeep.duplicates: { provider: openai-compatible, base_url: http://localhost:11434/v1, model: llama3.1 }
```

Steps are routed by role so routine work costs less. The executor steps (`capture.extract`, `sleep.consolidate`, `write.conflicts`, the relay's `relay.flag`, the duplicates judge `upkeep.duplicates`, whose verdicts only reach the owner as merge suggestions, and the box's reading `say.read`, which code checks word by word before the owner's sentence is written) turn text into candidates, flags or suggestions that the deterministic checks or the owner then filter, so they run on `claude-haiku-5-5`. The `review` role (`claude-opus-5-5`) has no step; to run a step on the strongest model, give it its own line under `steps:`. `bun scripts/usage-day.ts --grow 31` prices one scripted day of these calls at each step's routed model and on Haiku. The dashboard's Ask and Edit stay on the default. Those role defaults apply only while the default provider is Anthropic. `roles: { executor: {...}, review: {...} }` in `models.yaml` moves a whole role (any provider), a step's own line under `steps:` still wins, and `routing: off` puts every step on the default. A role can't set `max_sensitivity`; only `default` or a step's own line decides what a step may send. `pocketbrain models` prints which model each step runs on and which line picked it.

Providers: `anthropic`, `openai`, `gemini`, `openai-compatible` (Ollama, vLLM, OpenRouter…) and `typesafe` (TypeSafe AI's Jev, which answers typed questions with probabilities instead of free text). Keys by provider: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (also for `openai-compatible`), `GEMINI_API_KEY`, `TYPESAFE_API_KEY`, in the environment or one file each in `~/.config/pocketbrain/keys/`. With Jev, a near-duplicate is only reported as "same" when its confidence is at least 0.8. A step only sends notes at or below its `max_sensitivity` (default `personal`), never note bodies (except `dashboard.edit`, which rewrites the one note you asked about, and only when that note and every value in it are at or below the ceiling; nightly consolidation sends journal lines and capture sends your own captured text), and every verdict is logged with the model that gave it.

A hub started by launchd or systemd has no shell environment, so `serve` and `start` also read keys from `~/.config/pocketbrain/keys/`. The folder holds one file per key, named after its variable (`ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY`, `AGENTMAIL_RELAY_KEY`), and each file holds only the key. A file that anyone but you can read is ignored, a key already set in the environment wins, and the log names only which keys were found.

## Layout

```
src/brain.ts       load and save notes          src/core.ts        what the server does, per agent
src/rules.ts       rules/ folder                src/server.ts      MCP and JSON adapters
src/carve.ts       slice compiler               src/auth.ts        per-agent tokens (hashes only)
src/cell.ts        per-agent cells              src/oauth.ts       OAuth door (Muse-style clients)
src/view.ts        view rendering               src/orientation.ts what an agent is told on connect
src/checks.ts      write checks                 src/dashboard/     owner dashboard
src/write.ts       the write function           src/relay.ts       agent mail relay
src/match.ts       leak matcher                 src/upkeep.ts      upkeep agent
src/sources.ts     source refs and ranks        src/sleep.ts       nightly forgetting and consolidation
src/retrieve.ts    BM25 search                  src/explain.ts     why an agent sees what it sees
src/readlog.ts     hash-chained read log        src/merge.ts       owner's merge of duplicates
src/capture.ts     quick capture                src/intake.ts      capture channels
src/logs.ts        agent session logs           src/textline/      text channel to the owner
src/hub.ts         hub, replicas, ops           src/doctor.ts      health checks
src/backup.ts      encrypted backups, drill     src/usage.ts       model spend caps
src/measure.ts     first-week numbers           src/start.ts       everything in one process
src/owner.ts       owner identity               src/judge.ts       model-judged steps
src/digest.ts      daily digest                 src/model.ts       bring-your-own model adapter
src/import/        Notion and log import        src/handover.ts    full handover to a person
src/init.ts        new brain from nothing       evals/             end-to-end scenario evals
src/menubar.ts     what the Mac menu-bar app shows  macos/PocketBrainBar/  the menu-bar app (SwiftUI)
src/uninstall.ts   leaving cleanly (uninstall)
examples/brain/    fictional sample brain       examples/seed/     sample seeds for init
examples/demo-brain/ the ~500-fact made-up life the owner's screens and UI tests use
docs/              guides; history/ = design    scripts/           demo, smoke, public check
site/analytics.ts  the launch site's counter (no cookies, no ids)
```

Working on the code as an agent? Start with [CLAUDE.md](CLAUDE.md). The design records written before the code are in [docs/history/](docs/history/) (section 0 of [architecture.md](docs/history/architecture.md) is the agreed v1).

## Prior art

| Project | Built for | Access control |
|---|---|---|
| **pocketBrain** | a person using several hosted assistants | per-agent carve enforced in code, relay, tripwire, kill switches |
| [GBrain](https://github.com/garrytan/gbrain) | a power user running their own agents | OAuth scopes, opt-in private notes |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | one user with a local client | none per agent |
| [Mem0 / OpenMemory](https://mem0.ai/blog/introducing-openmemory-mcp) | developers adding memory to an app | app-level toggles |
| [Letta](https://github.com/letta-ai/letta) | developers building stateful agents | per agent by construction |
| Notion via MCP | teams | per-integration page sharing |

An honest assessment of what is new and what is assembled, written on 2026-10-08: [docs/history/innovation-assessment.md](docs/history/innovation-assessment.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require signing the Individual CLA in [CLA.md](CLA.md).

## Security

The gateway is a security boundary, so please report vulnerabilities privately through GitHub's private vulnerability reporting, not as public issues. In scope: anything that lets an agent read, write or infer notes outside its carve; token or policy bypass; the relay, upkeep or dashboard being used to leak or alter notes.

## Licence

[GNU AGPL-3.0](LICENSE). Anyone who runs a modified pocketBrain as a service has to share their changes. Your brain repo is your own data and isn't covered.
