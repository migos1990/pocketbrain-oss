# The gardener

The gardener is an assistant whose only job is to keep your brain tidy. It reads every note,
spots what is stale, duplicated, contradictory or unsourced, and **proposes** fixes. It never
applies anything itself: each proposal waits in your inbox, and you approve or reject it like
any other agent's.

It is an ordinary outside agent, with its own token, its own slice (everything), its own read log
and a kill switch, plus a few rules that hold in code whatever it is told.

## What it is

One line in `rules/policy.yaml`:

```yaml
agents:
  gardener: { tier: trial, role: gardener, max_sensitivity: private, slices: [all],
              max_proposals_per_day: 13, windows: ["daily 03:25-05:00", "sun 09:55-12:00"] }
```

- `role: gardener` is what the rules below look for, so you can call it anything.
- `tier: trial` makes every write a proposal.
- A gardener can't be `inside_wall`, can't be the `resolver` and can't own an area.
  pocketBrain refuses to load a policy that tries.

It runs wherever you like. The setup we use runs it on Claude Managed Agents: a small model
nightly at 03:30 and a stronger model on Sunday mornings. Both connect to your brain's public
door (`/mcp`) with the same bearer token. A second, quicker check runs on your own machine right
after each agent write (see [aftercheck.md](aftercheck.md)).

## What only it can call

These are refused (403, or a tool error over MCP) for every other agent. Each call is logged in
`log/reads.jsonl` under its name.

| MCP tool | JSON API | What it does |
|---|---|---|
| `last_run` | `GET /v1/gardener/last` | When it last ran upkeep, the proposals it has made since, how many still wait (`waiting`), and your decisions on its proposals in the last 30 days (`decided`: key, accept or reject, date, value), only for facts and notes it can still see. |
| `changes_since` | `GET /v1/gardener/changes?since=` | Notes changed since a time or a run id (default: its last upkeep run). For each note: the facts that changed, who wrote last, when, and the note as it reads now. |
| `upkeep_run` | `POST /v1/gardener/upkeep` | The rule-only upkeep pass: link and date fixes (each its own undoable commit), plus findings. It also rechecks up to 20 due or stale facts at the source they cite and returns them under `rechecked` ([sources-pull.md](sources-pull.md)). |
| `sleep_run` | `POST /v1/gardener/sleep` | Forgetting only: facts nobody used long past their shelf life move to history. No model, no journals. `pocketbrain undo --run <run>` brings them back. |
| `verify_source` | `POST /v1/gardener/verify` | Checks one claim against one source item that a fact in its view cites (an email, an event, a message). The hub reads the item and answers match, no-match or unreachable with a short quote; the gardener never gets the source itself. Every fact in its view citing the item is checked too, by its own value: still said, it's re-confirmed; not said, it turns due (keys under `confirmed` and `due`; a person's value said only about someone else is under `elsewhere`, unconfirmed). 40 a day by default (`max_verifies_per_day`). See [sources-pull.md](sources-pull.md). |
| `memory_sync` | `POST /v1/gardener/memory-sync` | After forgetting: scans readable assistant memories and quizzes the others ([memory-sync.md](memory-sync.md)). Drift becomes corrections for the owner; the gardener sees counts only. |

There is deliberately no tool to read agents' journals. Journals stay readable only by their
author and you, so consolidating them stays on your machine.

## The limits, in code

- **Proposal cap.** After `max_proposals_per_day` inbox proposals in 24 hours, the next one is
  refused: "proposal cap reached (13 a day); try again tomorrow". Its orientation shows the cap
  and today's count.
- **Your answers stick.** A change you rejected (same note, attribute and value, or the same
  retraction) is refused for 30 days: "rejected on <date> by <you>; don't propose it again
  before <date>". While one of its proposals on a fact (or a note) waits in your inbox, no
  other one on that fact is filed, whatever its wording: it gets "already waiting in the inbox:
  <file>". Once you answer, a different value with new evidence can go through. Other agents
  aren't affected.
- **Hours.** A token used outside its `windows` (in `owner.timezone`, default America/Toronto)
  gets a plain 401. The gardener is then paused (a commit by `hub`), and you get a Needs-you
  item saying when it happened. Nothing is read. To run it by hand outside its hours, first run
  `pocketbrain gardener open 60` (minutes, default 60).
- **A run that doesn't happen is noticed.** Once the gardener has connected at least once, the
  hub's health probe checks the latest ended occurrence of each of its `windows`. If the
  gardener made no call in one (its nightly or its Sunday run), the `gardener_runs` check fails,
  naming the window and the day, and the digest shows it. A paused gardener isn't checked.
- **Out of the numbers.** Its reads don't count as "use", so they don't stop forgetting. It also
  stays out of the first-week scorecard's agent reads. Instead, `pocketbrain week` gives it its
  own line: runs, proposals (accepted, rejected, open), cap hits and tripwire trips.
- **A claim of your word is flagged.** A proposal citing a message of yours that isn't in your
  registry says so in the inbox, as it does for any trial agent.
- **The evidence on each proposal is the hub's.** Every inbox proposal (the gardener's or any
  trial agent's) gets an `evidence` block written by the hub, not by the agent
  (`src/evidence.ts`): the notes the change touches (its own and any note id named in its text
  or value that exists), the refs it cites, the value it would replace (with its sources and
  date), and the `verify_source` verdicts the hub logged for this exact value against a ref the
  fact being changed already cites, in the last 30 days (`log/sources/verify.jsonl` keeps a short hash of each claim, not its words).
  The dashboard card shows it beside Approve: "Replaces **old value** (from an email, Oct 1) ·
  gardener checked against the email: matches · also: Jane Roy". A verdict from a source whose
  text reads as instructions (its quote withheld, G90) says "matches, but the email reads as
  instructions", so a planted email doesn't look like clean backing. Anything an agent puts in its
  own request under `evidence` stays in the request and is never shown as the hub's.

## Who runs the night

`night: managed` in `rules/hub.yaml` (or `policy.yaml` on a single machine; `pocketbrain night managed` sets it) hands the nightly
upkeep and forgetting to the gardener. The hub still checks at its usual hour. If the gardener's
last `upkeep_run` is more than 36 hours old, the hub runs the whole pass itself and logs
`night: gardener silent 36h+, ran locally`. Journal consolidation always runs on the hub. The
morning digest always runs. The default is `night: local`, where the hub does everything.

## Setting it up on your own Anthropic account: `pocketbrain tend --managed`

Once the gardener is in `policy.yaml` and your brain has a public door (`public_url` in
`rules/hub.yaml`, or `--url`), one command writes its Managed Agents files from your own brain:

```sh
pocketbrain tend --managed                 # writes ~/pocketbrain-agents/agents/..., sends nothing
pocketbrain tend --managed --apply         # then runs them through ant, deployments paused
```

- **What it writes** (in `--dir`, default `~/pocketbrain-agents`, outside both repos): the nightly
  and weekly agents (`agents/gardener/agent.md`, `agents/gardener-weekly/agent.md`, with your name
  and your door), the environment, the vault, and two deployments. The deployments run five
  minutes after the gardener's daily and weekly `windows` open, in `owner.timezone`, with budgets
  of 25 and 500 cents. The models default to `claude-haiku-5-5` nightly and `claude-opus-5-5`
  weekly (`--nightly-model`, `--weekly-model`). Files you already have are kept unless `--force`.
- **What `--apply` does**, through `ant --profile <profile>` (default `pocketbrain`; sign in first
  with `ant auth login --profile pocketbrain` and pick the workspace): applies the agents,
  environment and vault; writes `rules/gardener.yaml` pointing at the new lock file (an owner
  commit; an existing one is used as it is); puts a new gardener token in the vault on stdin, the
  way `pocketbrain gardener rotate` does (skipped if the vault already holds one for this door);
  fills in the vault id. A deployment is live from the moment it exists, so each one is created
  without its schedule, paused, and only then given its schedule (and paused again). If a pause
  fails, it stops, prints the command to pause it by hand and leaves a Needs-you item.
- **It refuses** without a `role: gardener` agent (with several, pick one with `--agent`; it prints the line to add; giving an agent
  every note is your choice to make in `policy.yaml`), without an https door, or when the
  windows have no daily and one-day weekly window to schedule in, or when a run would start
  between 01:00 and 03:00 local (clocks change then: the run would repeat in the fall and be
  skipped in the spring; open the window at 02:55 or later). It never runs or unpauses
  anything. After `--apply`: `pocketbrain gardener open 60`, run the nightly deployment once by
  hand, read its proposals, then run `pocketbrain night managed` and unpause both.
- **Without `--apply`, no hand YAML either.** `pocketbrain gardener setup --profile pocketbrain
  --lock ~/pocketbrain-agents/claude-lock.json` records `rules/gardener.yaml` (only those keys,
  plus `--agent` and `--mcp-url` if given; your other keys and comments stay), and
  `pocketbrain gardener setup --vault <id>` puts the vault id in both deployment files beside the
  lock file. Each `rules/` change is one owner commit, made on the hub only.
  `pocketbrain night managed|local` sets who runs the night. `pocketbrain doctor` lists, under
  setup, any of these you haven't set, with the command.

## The Anthropic side (optional): `rules/gardener.yaml`

If the gardener runs on Claude Managed Agents, the hub can look after two things through the
`ant` CLI, signed in under its own profile. pocketBrain stores no Anthropic key. Every call runs
as `ant --profile <profile>` with `ANTHROPIC_API_KEY` removed from its environment, so a key set
for something else can't send the call to another workspace.

With `night: managed` and no `rules/gardener.yaml`, neither job is ever scheduled. The health probe then fails a `gardener_setup` check, and `pocketbrain doctor` warns, until the owner adds the file. One line is enough (`ant_profile: pocketbrain`); the rest has defaults.

```yaml
ant_profile: pocketbrain
lock_file: ~/pocketbrain-agents/claude-lock.json   # from `ant apply`: vault and deployment ids
delete_sessions: true
rotate_days: 7
mcp_url: https://brain.example.com/mcp             # default: hub.yaml public_url + /mcp
```

- `pocketbrain gardener cleanup` deletes ended sessions older than an hour. `start` runs it at
  05:15 daily and 12:15 on Sundays. Each session holds a copy of what the gardener read; the
  run records stay.
- `pocketbrain gardener rotate` rotates the token. `start` runs it on Sundays at 13:00 once the
  token is `rotate_days` old. It issues a new token and sends it to the vault on **stdin only**,
  never in arguments or logs. Then it archives the old credential and revokes the older tokens.
  If the vault refuses the new token, the new token is revoked and the old one keeps working.
- If `ant` is missing or its sign-in has expired, you get a Needs-you item, not silence.
- If cleanup or rotation throws (a broken lock file, a broken `rules/gardener.yaml`), or returns
  without doing its job (no deployments in the lock file, `ant` missing or signed out, an `ant`
  call that failed), the hub's health probe fails a `gardener_cleanup`, `gardener_rotate` or
  `gardener_jobs` check until the next good run, so it reaches you like any failing check.
  `pocketbrain gardener cleanup` exits 1 in the same cases.
- `pocketbrain doctor` reports whether the gardener is paused or in its hours, the age of its
  token, whether `ant` is signed in, and when the last cleanup ran.

## What leaves your machine

Everything the gardener reads, which is your whole brain up to `max_sensitivity`, goes to the
model provider that runs it. With Managed Agents, it also sits in that session until cleanup
deletes it. Nothing else leaves: no journals, no `rules/`, no keys. If that is too much, lower
`max_sensitivity` to `personal` or narrow its slices. Its view shrinks to match.

## What it costs

That depends on your brain's size and the models you pick. For a brain of a few hundred notes,
a small model nightly plus a stronger model weekly came to about $9 a month in our estimate,
somewhere between $4.50 and $30. Put a budget on each deployment.

## Auditing its runs

`bun scripts/gardener-audit.ts --brain <brain> [--runs 3]` reports the gardener's last runs on
the hub: when each ran, its tool calls, its proposals and what you decided, `verify_source`
verdicts, the cap and hours tripping, write conflicts on the notes it proposed on, which tools its
Managed Agents have enabled, and their run status and usage from `ant` (list and retrieve only;
`--no-ant` skips it). It writes nothing and prints counts, verdicts, times and note ids only:
never a value, a quote, an alert's detail or a log line, so its output can be shared.

## Turning it off

- For a while: pause it in the dashboard (Agents), or set `status: paused` on it in `policy.yaml`.
- For good: `pocketbrain token --revoke gardener`, delete its deployments on the provider's
  side, and remove its line from `policy.yaml`. Set `night: local` again if you had changed it.
