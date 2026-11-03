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
| `last_run` | `GET /v1/gardener/last` | When it last ran upkeep, the proposals it has made since, how many still wait (`waiting`), conflicts it may weigh and hasn't suggested on (`conflicts_to_weigh`), and your decisions on its proposals in the last 30 days (`decided`: key, accept or reject, date, value), only for facts and notes it can still see. |
| `changes_since` | `GET /v1/gardener/changes?since=` | Notes changed since a time or a run id (default: its last upkeep run). For each note: the facts that changed, who wrote last, when, and the note as it reads now. The hub's own text-only commits (the page writer's paragraphs, link repoints) change no fact and aren't listed. |
| `upkeep_run` | `POST /v1/gardener/upkeep` | The rule-only upkeep pass: link and date fixes (each its own undoable commit), plus findings. It also rechecks up to 20 facts at the source they cite, due or stale ones and weak ones agents read, most at stake first ([What gets rechecked first](sources-pull.md#what-gets-rechecked-first)), checks that up to 10 more cited items still exist ([Sources that vanish](sources-pull.md#sources-that-vanish)), and returns them under `rechecked` ([sources-pull.md](sources-pull.md)). |
| `sleep_run` | `POST /v1/gardener/sleep` | Forgetting only: facts nobody used long past their shelf life move to history. No model, no journals. `pocketbrain undo --run <run>` brings them back. |
| `verify_source` | `POST /v1/gardener/verify` | Checks one claim against one source item that a fact in its view cites (an email, an event, a message). The hub reads the item and answers match, no-match or unreachable with a short quote and the item's own day (`dated`, the `as_of` for a newer value the quote states); the gardener never gets the source itself. Every fact in its view citing the item is checked too, by its own value: still said, it's re-confirmed; not said, it turns due (keys under `confirmed` and `due`; a person's value said only about someone else is under `elsewhere`, unconfirmed). 40 a day by default (`max_verifies_per_day`). See [sources-pull.md](sources-pull.md). |
| `open_disputes` | (MCP only) | Open and escalated conflicts on facts it may see, each side numbered as you see it, with its sources (not which assistant wrote it) and whether it is your own word, and any suggestion it already made, plus a `next` line saying what to do with them. Only conflicts on facts it can read through its own slice are listed: not excluded from it, not shared away from it, no side above its level. |
| `suggest_answer` | (MCP only) | Suggests which side of a conflict is true: the side number, 1 to 5 exact refs that back it (not `unverified`, links only over http(s), 200 characters each, no instruction or secret in them), and one plain line why (no instructions, no secrets, no claim that you approved). It is stored on the conflict and shown to you as "The Gardener suggests (n)" on the dashboard and as the "approve" answer on your phone (not on a private fact: there the message shows no values, so you answer by number or in the dashboard). It never settles: the conflict stays open, the fact doesn't change, and your tap is the answer. Its commit, and the one that stamps a held conflict it has read, carry a `Why:` line the hub writes from the change, never the Gardener's own words: the fact key, the side and the refs that back it, or the conflicts it read (G458). A resolver's own suggestion, when it escalates, takes precedence. When one side is your own word, it may only suggest that side. A conflict it can't see answers exactly like one that doesn't exist. The resolver sees the side number and each source's kind (`gmail:[withheld]`), never the reason or a source's text, which can quote notes outside its slice. |
| `orgs_to_describe` | (MCP only) | Orgs whose page doesn't say what they are yet, 15 at a time: id, name and aliases only. Empty until `describe_orgs: true` is in `rules/gardener.yaml`. See [What an org is](#what-an-org-is). |
| `suggest_about` | (MCP only) | Suggests what one of those orgs is: one plain line, its https site and the site's sentence naming it. Waits for your answer on the org's page; nothing is saved before your yes. |
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
- **A cited source has to say it.** A proposal that cites an email or event (gmail:, gcal:,
  discord: and the other source refs) for a new value is checked at that item by the hub, by the
  same word check as `verify_source`, before it reaches your inbox. If the item doesn't say the
  value (or is gone), it's refused: "gmail:<id> doesn't say \"<value>\". Propose only a value the
  item's quote states, or name the fact in your log as \"source no longer supports
  <note>#<attribute>\"" (check `source_says`). Only items a fact in its view cites are read, so it
  is no way to read your mail. After 10 such refusals in a
  day, every proposal citing a source waits for tomorrow. A value the word check can't judge (a
  date, a short word, a list) or a source the hub can't reach goes on as before. Other agents
  aren't affected.
- **A claim of your word is flagged.** A proposal citing a message of yours that isn't in your
  registry says so in the inbox, as it does for any trial agent.
- **The evidence on each proposal is the hub's.** Every proposal an agent's write sends to your inbox (the
  gardener's or any trial agent's) gets an `evidence` block written by the hub, not by the agent
  (`src/evidence.ts`; the capture pipeline's and the sleep pass's own proposals have none): the notes the change touches (its own and any note id named in its text
  or value that exists), the refs it cites, the value it would replace (with its sources and
  date), and the `verify_source` verdicts the hub logged for this exact value against a ref the
  fact being changed already cites, in the last 30 days (`log/sources/verify.jsonl` keeps a short hash of each claim, not its words).
  The dashboard card shows it beside Approve: "Replaces **old value** (from an email, Oct 1) ·
  gardener checked against the email: matches · also: Jane Roy". A verdict from a source whose
  text reads as instructions (its quote withheld, G90) says "matches, but the email reads as
  instructions", so a planted email doesn't look like clean backing. Anything an agent puts in its
  own request under `evidence` stays in the request and is never shown as the hub's.

## Letting the Gardener file

A new gardener is on trial: it proposes, and its proposals wait. When you trust it to write,
`pocketbrain agent tier gardener core` makes it core. Its facts then file themselves like any
core agent's, and a conflict still waits for you. The command changes only the gardener's line in
`rules/policy.yaml`: its `tier`, and going to core it also drops `max_proposals_per_day`. If the
edit would move any other value, it refuses. It makes one commit as you, with a Why line, and an
alert that names the way back (`pocketbrain agent tier gardener trial`). Add `--dry-run` to see
the changed line first. Its hours, slices and the source check stay as they were.

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
pocketbrain tend --managed --apply --code <code>   # then runs them through ant, deployments paused
```

- **What it writes** (in `--dir`, default `~/pocketbrain-agents`, outside both repos): the nightly
  and weekly agents (`agents/gardener/agent.md`, `agents/gardener-weekly/agent.md`, with your name
  and your door), the environment, the vault, and two deployments. The deployments run five
  minutes after the gardener's daily and weekly `windows` open, in `owner.timezone`, with budgets
  of 25 and 500 cents. The models default to `claude-haiku-5-5` nightly and `claude-opus-5-5`
  weekly (`--nightly-model`, `--weekly-model`). Files you already have are kept unless `--force`.
- **What the agents may call**: the gardener tools (`last_run`, `changes_since`, `upkeep_run`,
  `sleep_run`, `verify_source`) plus `orientation`, `context_pack`, `search`, `read`, `remember` and
  `log_session`; nothing else is enabled (`memory_sync` stays off). Each night the gardener reads
  `last_run`'s `decided` so it never re-proposes what you rejected, then checks up to 10 facts that
  `upkeep_run` lists in `rechecked.due` against their source with `verify_source`
  ([sources-pull.md](sources-pull.md)), and proposes a newer value only when the source's quote
  states it. The weekly pass checks up to 15 single-source facts that matter most. On the wiki it syncs up to 20 changed pages a night and fills the first 10 pages missing a summary (weekly: 20), each summary in plain words with no reference marker (only a section's lines carry references); it writes every fix the evidence supports through `remember`, which files one that contradicts nothing with Undo and makes one that conflicts a conflict for you. These steps ship with the owner's switch of the gardener from `tier: trial` (every write a proposal) to a core writer; until then its writes still wait as proposals. Once it is core, the fact proposals it left while on trial file themselves on the hub's next tick the way a capture's do (on the page with Undo, or as a conflict; never a private or money one), so none waits as an ask. A fact its source now says about someone else (`elsewhere`) is named in the log as no longer supported, never given a guessed value. The nightly steps are under eval: `agents-gardener-v2-corroborate` (`bun evals/run.ts --llm --only agents-gardener`) runs them as a gardener's system prompt on a night where a fact's email changed. `agents-gardener-weekly` runs the weekly steps on a brain where one person's role email changed and three projects' emails still agree; it scores corroborations found (or the stale role flagged), false proposals, and proposals citing one of those emails for a value it doesn't say, so two models can be compared on it (`EVAL_AGENT_MODEL=<model> bun evals/run.ts --llm --k 3 --only agents-gardener-weekly`).
- **What `--apply` does**, through `ant --profile <profile>` (default `pocketbrain`; sign in first
  with `ant auth login --profile pocketbrain` and pick the workspace): applies the agents,
  environment and vault; writes `rules/gardener.yaml` pointing at the new lock file (an owner
  commit; an existing one is used as it is); puts a new gardener token in the vault on stdin, the
  way `pocketbrain gardener rotate` does (so it takes the gardener's rotation code, `--code`, G240) (skipped if the vault already holds one for this door);
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
  token is `rotate_days` old; a rotation that failed is tried again every day at 13:00 until one
  goes through, so fixing its cause closes the probe's `gardener_rotate` alert (G394). It issues a new token and sends it to the vault on **stdin only**,
  never in arguments or logs, into the vault's existing credential for the brain's MCP URL (a vault
  holds one active credential per URL, so a second one would be refused with a 409; G413), or a new
  credential when there is none. Then it revokes the older tokens.
  If the vault refuses the new token, the new token is revoked and the old one keeps working.
- **From a terminal, rotation needs your yes (G240).** (Open, G279: a shell running as you can
  start its own `pocketbrain dashboard` and press **Rotation code** itself.) Any program with a shell can run
  `pocketbrain`, and rotation hands the gardener's token to whatever `ant` it finds. So
  `pocketbrain gardener rotate` (and `tend --managed --apply`, which puts the first token in the
  vault) need a rotation code: open the gardener's page on the dashboard, press **Rotation code**,
  then `pocketbrain gardener rotate --code <code>` (or `tend --managed --apply --code <code>`).
  The code works once, for 15 minutes, for rotation only; no other command takes it.
- **The ant is pinned.** The code also records which `ant` got the token: its real path and a
  sha256 of the file, in `.git/pb-gardener-ant.json`, outside git. The hub's Sunday rotation sends
  the token only to that file. If `rules/gardener.yaml` names another `ant`, or the file changed
  (an `ant` update, or something replaced it), nothing is sent and you get a `gardener_ant` alert
  ("ant changed since you last approved it"); after an update you made yourself, rotate once with
  a new code. If no rotation was ever approved, the first Sunday rotation pins the `ant` it finds
  and records it (`gardener_ant_pinned`, on Activity, not a problem). Every rotation the vault
  takes is a `token_minted` alert naming the `ant` and its hash; a key the vault refused is revoked
  at once and raises none. A failed rotation's `gardener_ant` alert is one problem however often the
  daily retry fails, and closes once a rotation goes through.
  What the pin doesn't stop (G282, open): it is a file the same user's shell can rewrite, and
  deleting it makes the next Sunday rotation pin whatever `ant` it finds; the hash is checked
  before `ant` runs, not as it runs. If ant's error output echoes the token, every copy is masked
  before it reaches an alert.
  Operator task line, once after setup or an `ant` update: `pocketbrain task "Rotate the gardener
  once with your code to pin ant" --cmd "pocketbrain gardener rotate --code <code from the
  gardener's dashboard page>"`.
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

Once you turn on [What an org is](#what-an-org-is), the names of your orgs below private (never
a person's name, never a page's text) also go to a web search run on Anthropic's side.

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

## What it couldn't do

A Gardener can run every night and still do nothing useful: with no source connected it has nothing to check facts against, and a managed Gardener without `rules/gardener.yaml` never gets its sessions cleaned up or its token rotated. So the hub says so (`src/blindspots.ts`):

- **No source connected:** no fact can be re-confirmed or caught when its source changes. Fix: add Gmail or Calendar to `rules/sources.yaml`, then `pocketbrain sources connect <name>`.
- **No check at a source in 7 days** (a read that failed, logged `unreachable`, doesn't count) while facts wait to be checked (the recheck candidates of [sources-pull.md](sources-pull.md#what-gets-rechecked-first)): a source's sign-in has likely lapsed. Fix: `pocketbrain doctor`, then `pocketbrain sources connect <name>`.
- **Managed, no `rules/gardener.yaml`:** cleanup and rotation never run. Fix: `pocketbrain gardener setup`.

`pocketbrain week` lists every one that holds. The digest says each once under **Needs you**, then again a week later if it still holds (`log/gardener/blind-told.json` remembers when). The missing `gardener.yaml` is left out of the digest, where the hub's own check already reports it every day. A paused Gardener, or none, has nothing to report.

## Wiki sync

The Gardener's `wiki_sync` tool rewrites a page's summary and sections from the page's own facts. It is report-only until the owner runs `pocketbrain wiki sync on`. What the hub checks before a rewrite lands is in [wiki.md](wiki.md#the-gardener-keeps-pages-in-sync). The nightly pass also writes up to 3 pages that have no summary yet (step 8, after its proposals so page writing never reframes them), from `last_run`'s `wiki_missing`, and the hub refuses any name or number none of the page's facts hold.

## What an org is

An import can leave an org page with a name and nothing else. With `describe_orgs: true` in
`rules/gardener.yaml` (off until then; `pocketbrain gardener describe-orgs` prints the one line, asks,
and adds only that key, or refuses if it is there already), the Gardener's web-only
run looks each such org up and suggests one plain line on what it is, with the org's website.

- **What it looks up:** orgs in its view, below private, with no `what_it_is` fact yet, whose name
  doesn't read as money, health or legal. It gets their id, name and aliases only, and searches
  only the name. Not a person's name, a page's text, or anything else from the brain.
- **Its own run:** `pocketbrain tend --managed --describe` writes `agents/<gardener>-describe/`: an
  agent with four hub tools (`orientation`, `orgs_to_describe`, `suggest_about`, `log_session`),
  so it never reads a note, plus Anthropic's `web_search` and `web_fetch`. Every sandbox tool is off.
  Its environment allows the open web, since an org's site isn't known before the search; the
  nightly and weekly runs keep their own limited one and no web tools. `--describe --apply` creates
  its deployment paused, on the weekly window, with a $10 budget. It reuses the vault, so no token
  moves.
- **What the hub checks:** the line is 3 to 140 characters with no address in it, and no
  instruction, secret, approval claim, or money, health or legal words. The site is https, a
  public name with no IP, port, user or password. The quote is the site's own sentence and
  holds the org's whole name or an alias. At most 40 suggestions a day.
- **What you see:** on the org's page, "Is this it?" with the line, a link to the site and the
  site's sentence, then **Yes, that's it** and **Not it**. Yes saves `what_it_is` and `website`,
  each citing the site (`url:`) plus your approval. The line then sits under the page's title with
  the site's host as a link. Not it keeps the org from being asked again; **Ask again** lets the
  Gardener look once more. Each answer comes back with Undo, which takes back only that answer.
  These suggestions never count on your home or in Settings: they wait on the page.
- **Where it waits:** `inbox/describe/<org>.yaml`, one file per org, never filed by the hub.
