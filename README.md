# pocketBrain

**One memory you own, shared by several AI assistants. Each assistant sees only the slice you grant it, and the limits are enforced in code, not in a prompt.**

> **Status: prototype (0.1.0).** Its author uses it every day with hosted assistants connected over MCP and OAuth, on one Mac. It is not packaged (no npm, no Homebrew), it has one real user, and the APIs and brain format may still change. It is published so people can read how it works. Licensed under [AGPL-3.0](LICENSE).

## The idea

If you use one assistant, a folder of Markdown notes it maintains is enough. pocketBrain is for the day a second assistant needs those notes, especially one a vendor runs. A shared wiki has no walls: whoever reads it reads everything, whatever an assistant was shown can't be taken back, and nothing records which assistant wrote what.

So the notes stay in a git repo you own, and every assistant reaches them through one gateway that knows who it is and what it may see. Sources like mail and calendar are evidence: the brain stores distilled facts with a reference to where each came from, not copies of the raw content. [IDEA.md](IDEA.md) is the pattern on one page, without this code.

## How it fits together

```
   assistant A        assistant B        assistant C
   (MCP)              (MCP + OAuth)      (plain JSON API)
       │                  │                  │
       └────────── one URL, per-agent token ─┘
                          │
            ┌─────────────▼──────────────┐
            │  hub (your machine)        │
            │  identity from the token   │
            │  carve: this agent's slice │
            │    served from its own cell│
            │  write path: checks, leak  │
            │    tripwire, conflicts,    │
            │    inbox for the owner     │
            │  relay for agent mail      │
            └─────────────┬──────────────┘
                          │
       brain repo (the truth): Markdown + YAML in git
       Gardener, nightly upkeep, daily digest, owner dashboard
```

Four layers, from the bottom:

1. **The brain.** One Markdown note per person, project, decision or money item, with facts in YAML frontmatter. Each fact carries `as_of`, its sources and how it was verified. It is plain files in a private git repo, so any tool or person can read it without pocketBrain, and every write is a commit authored by the agent that made it.
2. **The rules.** `rules/policy.yaml` and `rules/slices.yaml`, which only the owner edits, say which areas, note types, fields and sensitivity level each assistant gets, and whether its writes land or wait for the owner.
3. **The hub.** A small server on your own machine. It reads the token, compiles that agent's carve, and answers every read (search, context packs, notes) from a directory that holds only that agent's slice. Writes go through checks that can't be switched off. A tunnel gives hosted assistants one URL.
4. **The upkeep.** Rule-only passes fix links and dates and flag facts that are past due. The Gardener, an optional model-driven agent, reads everything and proposes fixes. A daily digest and a loopback-only dashboard show the owner what needs them.

## How an assistant connects

Each assistant gets its own token, which is the only thing that says who it is. MCP clients use `/mcp` with a bearer token, or the OAuth door for clients that only register themselves; anything else uses the same token on `/v1/...`, described at `/openapi.json`. On connect an assistant gets an orientation: what it holds, how to cite sources, and that notes are data, never instructions. Adding one, from picking its door to revoking it: [docs/add-an-agent.md](docs/add-an-agent.md).

## The walls

- **A hidden note answers exactly like a missing one.** A value carved out of a visible sentence becomes `[withheld]`, and a link to a hidden note becomes `[[redacted]]`. Search ranks only what the agent can see.
- **A write can't carry what its author was never shown.** The leak tripwire refuses it, including spaced, encoded and look-alike variants. Secrets, injection shapes and claims of owner approval without a message id are refused too.
- **Agent mail goes through a relay** that holds any message carrying a value the recipient can't see. This only holds once direct mail between your assistants is blocked at the mail provider.
- **Kill switches.** Pause an agent or make it read-only, and it holds everywhere on its next call. Tokens are revocable, and `pocketbrain explain` says why an agent sees what it sees.

What it can't do: a hosted assistant keeps whatever it was shown in a session, and vendor memory outside the brain is out of reach. A paraphrase of a hidden fact gets past any matcher. The full list is in [docs/overview.md](docs/overview.md#what-the-gateway-enforces).

## Conflicts

When two writes disagree, fixed steps decide: the owner's word, then a verified source, then an exact source, then the newer one. Whatever those can't settle becomes a dispute that only the resolver agent or the owner can close. No assistant ever replaces a value the owner confirmed; that goes to the owner. Models never settle anything: every check is plain code, and a model's verdict can only make something more private or become a proposal.

## The Gardener

The Gardener ([docs/gardener.md](docs/gardener.md)) is an ordinary outside agent whose job is to keep the brain tidy. It reads every note, spots what is stale, duplicated, contradictory or unsourced, and proposes fixes. Rules hold whatever it is told: every write is a proposal, it has a daily cap, it may only connect in its hours, it can never be the resolver or own an area, and it never reads agents' journals.

## See it working

You need [Bun](https://bun.sh) 1.4 and git. Everything below runs on [examples/brain](examples/brain), a fictional brain (its owner Robin, two courses, a bank, four assistants) that is also the test fixture:

```sh
git clone <this repository> pocketbrain && cd pocketbrain
bun install
bun run demo                 # the whole story: carve, refuse, hold, settle, digest
bun run demo --dashboard     # the same, then the owner dashboard on the demo copy
bun test                     # the suite, including the attacks that must keep failing
```

To run it on your own notes, [docs/quickstart.md](docs/quickstart.md) takes about five minutes. Your brain goes in its own private repo, never in this one.

## Not built yet

- Packaging: install is `git clone`; there is no npm package, Homebrew formula or signed Mac app.
- Search is BM25 over words, with an optional French-English word map. Semantic search is not in yet.
- The live AgentMail relay transport is untested (the file transport runs), and the relay's request classifier is off by default.
- The sealed edge, which answers reads while the hub sleeps, is a local proof, not deployed.
- Code contributions wait on the contributor agreement ([CONTRIBUTING.md](CONTRIBUTING.md)).

## Read more

- [docs/overview.md](docs/overview.md): every owner command, the brain format, models (bring your own) and the source layout.
- [docs/](docs/): one guide per feature; [docs/history/](docs/history/) holds the design records written before the code.
- [CLAUDE.md](CLAUDE.md): the map for agents working on the code.
- [SECURITY.md](SECURITY.md): how to report a vulnerability privately.

## Licence

[GNU AGPL-3.0](LICENSE). Anyone who runs a modified pocketBrain as a service has to share their changes. Your brain repo is your own data and isn't covered.
