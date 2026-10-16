# pocketBrain in full

The complete tour: why it exists, every command an owner uses, what the gateway enforces, the brain
format, models and the source layout. The [README](../README.md) is the short version.

**A second brain you own, shared by several AI assistants, where each assistant sees only the slice you grant it, and the limits are enforced in code.**

Memory products today are built for developers who run their own agents. pocketBrain is for a person who *uses* several hosted assistants they don't control (each with its own vendor, memory and tools) and wants one memory under their own control, with every assistant on the far side of the trust boundary.

> **Status: early (0.1.0, see [CHANGELOG.md](../CHANGELOG.md)), used daily by its author with hosted assistants connected over MCP and OAuth.** It runs end to end on a single owner's brain: import, carving, the write path, sensitivity flags, per-agent cells, BM25 search, upkeep and nightly forgetting, explain, the daily digest, a live MCP and JSON server with per-agent revocable tokens and an orientation for each agent, an OAuth door, quick capture, agent session logs, hub and replicas, encrypted backups, model spend caps, and an owner dashboard. The agent-to-agent relay runs with its file transport; the live AgentMail path is untested. Install is `git clone` (not on npm or Homebrew). Licensed under [AGPL-3.0](../LICENSE).

## Why

If you use more than one assistant, you rebuild your context in each of them. Pointing them all at Notion or a notes folder gives you a shared store, but:

- access is all-or-nothing per integration, with no per-agent rules or sensitivity levels;
- authorship is whatever the agent typed, so you can't tell which assistant wrote what;
- nothing checks whether a fact is still true, so the store drifts;
- a new assistant can ask, or trick, an older one into telling it what it was never given.

pocketBrain's answer is plain Markdown files in a git repo you own, and one gateway in front of them that enforces a per-agent policy you write. The policy is "carvable": a new assistant gets one slice, and can't learn the rest through pocketBrain. Mail between assistants is checked against the recipient's slice when it goes through the relay (off by default; see [What the gateway enforces](#what-the-gateway-enforces)); assistants talking in their own apps never pass through pocketBrain.

### Why not just paste a file, or keep an LLM wiki?

If you use one assistant, you don't need pocketBrain. Paste one file into it, or keep an LLM-maintained wiki: raw sources in a folder, a model that compiles and maintains Markdown pages with an index, and no vector database. For one person and one model that's the right setup, and pocketBrain's brain format is close to it on purpose: Markdown in git, no embeddings until search measurably fails, and an upkeep pass that looks for contradictions.

It stops being enough once a second assistant needs access, especially one a vendor runs. A wiki has no walls. Whoever reads it reads all of it, whoever writes it can change anything, and nothing records which assistant used what. It breaks in four places:

1. **Carving.** The file is one blob. The assistant that books your travel gets your salary and your medical notes along with your flights. Removing them by hand means a different paste per assistant, kept by hand, forever. A carve is a per-agent slice compiled from policy, and a withheld value inside a visible sentence ("renewed the lease at [withheld]/month") stays withheld without you editing prose.
2. **Write-back.** Email and calendar are sources; they sync. Conclusions don't. When one assistant works out that "the Acme project is on hold until the audit closes", that lives in its own memory, and the next assistant re-derives it, or doesn't. With a write path, the conclusion lands in the brain once, with its source, and every other view picks it up on the next build.
3. **Staleness and conflicts.** A pasted file has no shelf life. "Next step: teach session 6 on Sunday" is still in there three weeks later, and when two assistants wrote two different next steps nobody notices. Facts here carry `as_of` and `review_after`, a resolver settles conflicts only with a stronger or newer source, and the upkeep pass runs while you sleep.
4. **Revocation and audit.** You can't un-paste. If you stop trusting an assistant, the file it already holds is gone for good, and you never knew which lines it actually used. Here a paused agent gets 403 on its next call, `carve --why` explains any fact's presence or absence, and the log shows who read what and when.

The honest limit: a hosted assistant still has whatever it was shown in a session, and vendor memory outside the brain is outside our control. pocketBrain decides what crosses the line and remembers that it did; it cannot reach across the line afterwards.

If you want the pattern without this code, [IDEA.md](../IDEA.md) describes it in one page.

## What it is

```
   assistant A        assistant B        assistant C
   (MCP)              (MCP)              (plain JSON API)
       │                  │                  │
       └────────── one URL, per-agent token ─┘
                          │
            ┌─────────────▼──────────────┐
            │  pocketBrain hub           │
            │  identity from the token   │
            │  carve: what this agent    │
            │    may see, compiled into  │
            │    its own cell            │
            │  write path: checks, leak  │
            │    tripwire, conflicts,    │
            │    inbox for the owner     │
            │  relay for agent mail      │
            └─────────────┬──────────────┘
                          │
              brain repo (truth): Markdown + YAML, git
              upkeep agent, daily digest, owner dashboard
```

Principles:

1. **Portable.** The brain is Markdown with YAML frontmatter in git. Moving it is `git clone`; any tool or person can read it without pocketBrain.
2. **Owned.** It runs on your own machine. Hosted assistants reach it through a tunnel.
3. **Default deny, per agent.** Each assistant has a token and a carve: which areas, types and attributes it sees, up to which sensitivity, and whether its writes land or wait for you.
4. **Enforced in code, not prose.** Sharing limits hold even if an agent ignores every instruction. A hidden note answers exactly like a missing one, and a value an agent was never shown can't come back through its writes. Mail between agents is held when it carries a value the recipient can't see.
5. **Accountable.** Every write is a git commit authored by the agent that made it, and the write log is hash-chained.
6. **Self-checking.** An upkeep agent fixes links and dates, flags facts that are past due, rechecks facts against a source you connected (`pocketbrain upkeep --live`, or Gmail and calendar pulls), and sends contradictions to you; it never settles them itself.

## Your brain is not in this repo

This repo is the **tool**. Your notes live in a **separate, private** git repo that pocketBrain reads and writes. Never commit personal notes, tokens or logs here. The sample brain in [examples/brain](../examples/brain) is fictional, and it is also the test fixture.

## Quick start

Five minutes ([docs/quickstart.md](quickstart.md) walks through it). You need [Bun](https://bun.sh) 1.4 and git:

```sh
git clone <repository> pocketbrain && cd pocketbrain
bun install && bun link        # puts the `pocketbrain` command on your PATH
pocketbrain init               # a few questions; your brain goes in ~/my-brain
pocketbrain start              # leave it running
claude mcp add …               # the connect line init printed (or any MCP client)
```

pocketBrain is not on npm or Homebrew yet; `install.sh` is for when it is.

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
pocketbrain carve claude --preview   # what an agent would get, and what the preview flags
pocketbrain connect claude           # a new token for the agent and what to paste into its connector
pocketbrain add newbot --slices area:work --yes   # a new trial agent: its slice, token and paste text in one go
pocketbrain consent newbot "handles family logistics"   # say what it is for; see what it would see first
pocketbrain digest                   # what needs you today
pocketbrain doctor                   # is everything healthy
```

Commands find the brain from `--brain`, `$PB_BRAIN`, the current folder, or the one `init` made last.

Adding another assistant later, from picking its door to revoking it: [docs/add-an-agent.md](add-an-agent.md).

`init` writes `rules/` (one trial agent that sees your work area and basic contacts, never money or anything private), one note per person, org, project, decision and money item, a report of anything it removed or guessed, and the agent's token. The seed format is in the quickstart; [examples/seed](../examples/seed) has a sample text file and exports. Nothing is sent anywhere and no model is called.

Point an MCP client at `http://<host>:8787/mcp` with `Authorization: Bearer <token>`, or at `/mcp/<token>` if it can't set headers. A client without MCP uses the same token on `/v1/...`; the spec is at `/openapi.json`. An assistant that can only browse and fill a password from its vault signs in at `/b` instead, once `pocketbrain connect <agent> --browser` turns that on for it ([docs/browser-door.md](browser-door.md)).

The dashboard is yours alone (it binds to 127.0.0.1). Besides the inbox and kill switches, its Brain tab lets you ask your brain a question and see the facts the answer drew on, edit any fact or a whole note in place (each save is a git commit by you, and the old value goes to history), or ask a model to make a change, which you see as a diff and approve or discard. After replacing a value you can mark the old one as never right, so history shows a correction rather than a change. Each note has Forget (the note leaves every assistant's view at once; git keeps it and Recently forgotten on the Brain tab brings it back as it was) and Change who can see it (hide it from one assistant by name, show it again, or change how private it is; facts you marked private stay private). On the Assistants page you can name one outside assistant as your editor: its writes apply directly instead of waiting in the inbox, every check still runs, each change is listed with a Revert button, and Remove editor takes it back in one click. No editor is set by default.

Coming from Notion: put a raw export under `import/raw/` in the brain and run `bun src/cli.ts import-notion`. Which area a row belongs to is personal, so it lives in the brain's `rules/import.yaml`, not in the code.

## Running it for real

Step by step: [docs/quickstart.md](quickstart.md) to connect a first assistant, then [docs/hub.md](hub.md#a-fixed-address-on-your-domain) for a fixed address that survives a restart. In short, the hub runs on your own machine and binds to 127.0.0.1; a tunnel gives it one URL on your domain; `bun run smoke <url> <token>` checks it from the outside. `build --all` writes `views/snapshots/<date>/<agent>.md`, a dated copy of each agent's slice for when the hub is asleep; it carries the same carve as the live server. Other machines are replicas whose writes queue for the hub, and any of them can become the hub with `pocketbrain hub promote`; `pocketbrain doctor` reports on all of it ([docs/hub.md](hub.md)).

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
| `pocketbrain handover --to "Name" --out <dir>` | a stripped, verified copy for the person taking over, encrypted to their key; never sends |

On a Mac, the menu-bar app shows whether the hub is up and which day of the real-use bar you are on, opens the dashboard, pauses or cuts off an agent, and installs or restarts the hub under launchd: build it with `macos/PocketBrainBar/build.sh` ([docs/menubar.md](menubar.md)).

A sealed edge can answer reads while the hub sleeps, from per-agent cells it can't read itself, and queue writes for the hub; it's a local proof, not deployed ([docs/edge.md](edge.md)).

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

A fact can carry `sensitivity` (raised above its file's level, never lowered) and `share_with` (only the named agents ever get it). The original format spec, written before the code: [docs/history/memory-shape.md](history/memory-shape.md); `src/brain.ts` and `examples/brain` are what it is today.

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
- **One cell per agent.** When serving, each agent's reads are answered from a directory that holds only its slice, with links to hidden notes and carved values already removed and no other agent named. A bug in the read path can only leak what that agent already holds. A cell is rebuilt when the brain's commit moves or `rules/` changes on disk, so an uncommitted rules edit applies at once, as without cells. Writes, disputes and the relay stay on the hub. (`serve --no-cells` turns this off.)
- **Carve before anything.** Views, search, read and context packs are computed from the agent's carve. A hidden note answers like a missing one, flagged facts never leave, links to hidden notes render as `[[redacted]]`, and a carved value that shows up in visible prose, or in a visible note's title or aliases, becomes `[withheld]`. An agent's write never changes a fact hidden from it: a retire answers like a missing fact, and any other write waits in the owner's inbox with the same reply whatever the hidden value is. A new note's id leaves out a value carved from another agent.
- **Writes run checks that can't be switched off**: schema, `rules/` is read-only, protected paths, secret shapes (secrets belong in a password manager), injection shapes, and approval claims without a message id. A write can't probe for notes it can't see. Replaying text already stored in the same fact, which the writer can see, isn't sent back to the owner for its wording.
- **Leak tripwire.** A write carrying a value its author was never shown is refused, and a relayed message carrying a value its recipient can't see is held for the owner; both are logged, including spaced, encoded, look-alike-letter and reformatted-number variants.
- **Other people's health, school, legal or money details** are stored, but forced to private and shared only with the resolver. The word list is French and English (santé, école, casier judiciaire, dettes; chemo, report card, custody, loan) matches whole words with accents at either edge, plurals, French typed without accents and snake_case attribute names (diagnosis_date). Words that would catch ordinary facts (doctor, lawyer, prêt, revenu, payé) are left to the model after-check. The owner's own money words from `pocketbrain init` match with accents too (épargne).
- **Conflicts** follow fixed steps (owner's word, then verified source, then exact source, then newer); what they can't settle becomes a dispute only the resolver agent or the owner can close. An assistant never replaces a value the owner confirmed, not even with a more precise date or a later `merge: max` value: that goes to the owner as a dispute. Its retract of a value the owner confirmed goes to the owner's inbox.
- **Agent mail goes through the relay**, which checks each message against the recipient's carve and holds anything it shouldn't see. This holds only once direct mail between your assistants is blocked: `pocketbrain relay --block-plan` prints the block lists, and you apply them with your mail provider's admin key. Until then an assistant can mail another directly, unchecked. A send the mail service refuses is never recorded as delivered: the mail stays unread for the next pass and you get a `relay_failed` alert for it, once a day per message and cause.
- **Split tokens for the main assistant.** A core agent's token can be issued as a reader (its slice below private, no dispute or owner-channel routes, and its citations of the owner's messages wait in the inbox) and a resolver (only those routes), so the token in a vendor's config is not the whole brain. A dispute packet on a private fact, or on one `share_with` keeps from the resolver, never shows the values, to any token, and goes to the owner. An agent that asks by topic and then takes its whole view in one read raises an alert. A token without a role works as before.
- **Kill switches.** `status: paused` on an agent holds everywhere: server, write path and relay. `read-only` stops its writes, dispute moves and outgoing mail; it can still read and receive. Tokens are revocable.
- **Assistants can ask to act, never act alone.** An assistant the owner gives an `act` block may ask the brain to send one mail to an address on the owner's list. The brain refuses an unlisted address, a secret or any value outside that assistant's cut (and alerts the owner), marks private values it may see, and holds every mail until the owner approves it in the dashboard, bound to the exact text. A text can only reject it. The transport is a file for now; nothing leaves the machine ([docs/act.md](act.md)).
- **Standing weighs asks, it never opens doors.** You say who matters (`pocketbrain standing set`: inner, close, known); assistants see a person's tier only within their slice and ask `who_is` before acting on a message, so family comes first and a stranger's request waits for you. It matches the sender's address, never the display name, only addresses you or a source vouched for, and no assistant can raise anyone. No check reads it ([docs/standing.md](standing.md)).
- **Rules integrity.** Edits to `rules/` outside git, or commits to it by an agent, go to the top of the digest.
- **The gardener plays by the same rules.** An optional agent flagged `role: gardener` reads everything and only proposes, with a daily proposal cap. It may connect only in its hours: its token used outside them pauses it and tells you. It can never be the resolver or own an area, and it never reads agents' journals ([docs/gardener.md](gardener.md)).

Known limits: a paraphrase of a hidden fact gets past any matcher; the read log records what an agent was handed and what it went looking for (`explain`), not what it did with it afterwards; bearer tokens stand in for a hosted authorization server; the injection check is a pattern list; the relay spots asks for a withheld category by its words and a few money-ask phrases, and new wording gets through (eval gap G6). An opt-in small model (the request check, `relay.flag`, `relay: { classify: true }`) reads what the words let through; it stays off by default until its false holds on fee and payment logistics (gap G26) are fixed.

## Models (bring your own)

Every check above is plain code; models never decide. Model-judged steps (near-duplicate review, nightly journal consolidation, quick-capture extraction, the check after each agent write, and the dashboard's `dashboard.ask` and `dashboard.edit`) produce review items or proposals for the owner. The one exception only tightens: an opt-in second-opinion classifier can make a fact more private, never less ([docs/aftercheck.md](aftercheck.md)). The provider is set per step in `rules/models.yaml` and defaults to Anthropic:

```yaml
default: { provider: anthropic, model: claude-sonnet-5-5 }          # key from ANTHROPIC_API_KEY
steps:
  upkeep.duplicates: { provider: openai-compatible, base_url: http://localhost:11434/v1, model: llama3.1 }
```

Steps are routed by role so routine work costs less. The executor steps (`capture.extract`, `sleep.consolidate`, `write.conflicts`, the relay's `relay.flag`, and the duplicates judge `upkeep.duplicates`, whose verdicts only reach the owner as merge suggestions) turn text into candidates, flags or suggestions that the deterministic checks or the owner then filter, so they run on `claude-haiku-5-5`. The `review` role (`claude-opus-5-5`) has no step; to run a step on the strongest model, give it its own line under `steps:`. `bun scripts/usage-day.ts --grow 31` prices one scripted day of these calls at each step's routed model and on Haiku. The dashboard's Ask and Edit stay on the default. Those role defaults apply only while the default provider is Anthropic. `roles: { executor: {...}, review: {...} }` in `models.yaml` moves a whole role (any provider), a step's own line under `steps:` still wins, and `routing: off` puts every step on the default. A role can't set `max_sensitivity`; only `default` or a step's own line decides what a step may send. `pocketbrain models` prints which model each step runs on and which line picked it.

Providers: `anthropic`, `openai`, `gemini`, `openai-compatible` (Ollama, vLLM, OpenRouter…) and `typesafe` (TypeSafe AI's Jev, which answers typed questions with probabilities instead of free text; key in `TYPESAFE_API_KEY`). With Jev, a near-duplicate is only reported as "same" when its confidence is at least 0.8. A step only sends notes at or below its `max_sensitivity` (default `personal`), never note bodies (except `dashboard.edit`, which rewrites the one note you asked about, and only when that note and every value in it are at or below the ceiling; nightly consolidation sends journal lines and capture sends your own captured text), and every verdict is logged with the model that gave it.

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
docs/              guides; history/ = design    scripts/           demo, smoke, public check
```

Working on the code as an agent? Start with [CLAUDE.md](../CLAUDE.md). The design records written before the code are in [docs/history/](history/) (section 0 of [architecture.md](history/architecture.md) is the agreed v1).

## Prior art

| Project | Built for | Access control |
|---|---|---|
| **pocketBrain** | a person using several hosted assistants | per-agent carve enforced in code, relay, tripwire, kill switches |
| [GBrain](https://github.com/garrytan/gbrain) | a power user running their own agents | OAuth scopes, opt-in private notes |
| [Basic Memory](https://github.com/basicmachines-co/basic-memory) | one user with a local client | none per agent |
| [Mem0 / OpenMemory](https://mem0.ai/blog/introducing-openmemory-mcp) | developers adding memory to an app | app-level toggles |
| [Letta](https://github.com/letta-ai/letta) | developers building stateful agents | per agent by construction |
| Notion via MCP | teams | per-integration page sharing |

An honest assessment of what is new and what is assembled, written on 2026-10-08: [docs/history/innovation-assessment.md](history/innovation-assessment.md).
