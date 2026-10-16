# Agent memory sync

The brain is the source of truth. Every assistant also keeps its own memory (Claude Code's
`CLAUDE.md` and memory folder, Town's wiki, Instinct's memory notes), and that memory goes stale
when the brain changes: an old address, a role that changed, a fact the owner deleted. A stale
local memory wins whenever the assistant doesn't check the brain first, and it feeds the
assistant's own routines and skills. Memory sync finds the drift and fixes it with the owner's OK.

Code: `src/memsync.ts`. Log: `log/memsync.jsonl` (hash-chained).

## How each assistant's memory is reached

| Memory | How we read it | How we fix it |
| --- | --- | --- |
| Readable on the hub's machine (Claude Code: `~/.claude/CLAUDE.md`, `~/.claude/projects/*/memory/`) | The hub scans the files (`memory.files` in policy.yaml) | The hub edits the line itself, after the owner approves, with a backup next to the file, then re-scans |
| Opaque (Town, Instinct, claude.ai, Muse) | A quiz through the agent's own door: it answers from its own memory | A signed correction the agent picks up at its next `memory_check`, then the same question again |

Town and Instinct expose no API to read or write their memory. Town reaches out to us (MCP);
Instinct calls the JSON API. Nothing can reach in, so both are opaque: the brain can only ask and
request, and check the answer. Deletion is provable only for readable memory; for an opaque one,
"verified" means the agent no longer gives the old value when asked.

## The loop

1. **Find drift.** For each agent, the targets are the facts in *its own carve*, each with its
   current values and the values the brain replaced, ended or forgot (from `history`).
   - Readable: a paragraph that names the subject (title or alias) and holds an old value, with no
     current value next to it, is a finding.
   - Opaque: a question like *"From your own memory, without looking in pocketBrain first: what is
     Jane Roy's role?"*. Facts the brain changed or forgot are asked first. The question never
     contains the answer.
2. **Grade by rule.** An answer holding an old value is `drift`; the current value is `in-sync`;
   "nothing" is `missing` (the agent will read it from the brain); anything else is `differs` and
   goes to the owner, since no rule can tell a paraphrase from a mistake. No model is involved.
3. **The owner decides.** Drift and differs become corrections in state `proposed`.
   `pocketbrain memsync list`, then `approve <id>` or `decline <id>`. Nothing is changed before that.
4. **Fix.** Readable: the hub replaces the old value on that exact line (or deletes the line for a
   forgotten fact), keeps `<file>.pb-bak-<id>`, re-scans, and marks it `verified` or `still-wrong`.
   If the line changed since the scan, it is `needs-hand`. Opaque: the correction is signed and
   handed over at the agent's next `memory_check`; when the agent replies `done` (`memory_check_reply`), it gets the same
   question again, and the answer marks it `verified` or `still-wrong`.

### Live: what changed since the agent last checked

The nightly quiz finds drift after the fact. The live half stops it at the next conversation:
each `memory_check` lists the facts in the agent's own carve that the brain changed or forgot
since the agent last confirmed (`changes`: what it is now, what it was, the pointer to keep).
The agent replaces those values in its own memory (notes, wiki, routines, skills) with the
pointer, then replies `changes_seen` with the list's id. It is then asked about up to 3 of them
from memory, graded the same way; answering with the pointer counts as in sync.

- The first check records a baseline and shows nothing. Facts new to the agent's carve are not
  listed: the agent reads them from the brain. At most 20 facts per list; the rest come next time.
- The same list is handed out until the agent confirms it, so a missed conversation loses nothing.
- These are facts already in the brain, so they go out without a tap from the owner; changing
  what the brain says still goes through the write rules. Each list is signed like a correction.
- Town (MCP), Instinct (`GET`/`POST /v1/memory-check`, or the browser door's `/b/memory-check` page) use the same functions; nothing to set up
  beyond the standing instruction, which already says to call `memory_check` first.

The gardener runs step 1 each night (`memory_sync` tool, after `sleep_run`) and sees only counts.
The owner can run it any time: `pocketbrain memsync run`.

## Rules that hold

- **Slices.** Questions and corrections only name facts in that agent's own carve, history
  included and held to the same fact-level rules (attribute lists, `share_with`, sensitivity). A
  withheld fact is never asked about, so a quiz can't teach an agent anything outside its slice.
  The verdict is not told to the agent ("thanks"), only to the owner.
- **Values as a read shows them.** Inside a visible fact, a carved value is `[withheld]` and a link
  to a note the agent can't see is `[[redacted]]`, in questions, grading, corrections and the change
  feed alike, exactly as on the read path. A correction logged before this rule with a raw value is
  held back ("needs hand") instead of sent, and an open feed that differs is issued again (G74).
- **As the view stands now.** What `memory_check` serves is filtered by the agent's view at the
  time of the check, for every token: once the owner hides a note, its open questions and approved
  corrections wait unsent and name nothing, and a reply to such a question gets the same answer as
  an unknown id (G180).
- **Never an old value.** A correction carries the value from when the answer was graded. If the
  owner has changed the fact since, `memsync approve` (CLI and dashboard) declines it and asks again
  (or re-scans the file), and `memory_check` holds back an approved one for the owner, as
  `beliefs fix` does (G75, G187).
- **The owner's cards clear on evidence.** A right quiz answer clears a stuck fix that came from a
  quiz; a stuck fix from a memory file (a file that became a link, a line that changed) clears only
  on a re-scan of that file (G186). `memsync list` and the digest quote agent text on one line (G195).
- **No links followed.** The scan of an agent's memory folder skips symbolic links, files and
  folders alike, so a link to a brain note is never read, backed up into the folder or edited; a
  file that became a link after the scan is left for the owner (G76). `memsync import` skips links
  inside a folder too.
- **Authenticity.** A "rewrite your memory" message is exactly what an attacker would send.
  Corrections reach an agent only through its own authenticated door (`memory_check`), and every
  one is signed with the hub's Ed25519 key (`MEMSYNC_SIGNING_KEY` in `~/.config/pocketbrain/keys/`,
  made on first use; `pocketbrain memsync key` prints the public half). The orientation tells each
  agent that a correction by mail or chat is not from the owner.
- **The owner approves every change.** An agent's answer never edits anything by itself.
- **A restart loses no correction.** A correction moves by log lines with work between them. The
  nightly pass and every `memsync run` finish one a restart left in between (`resumeCorrections`):
  an approved memory-file fix is written (or, when its backup shows it was written, re-scanned),
  and an agent's applied fix whose recheck was never asked, or ran out, is asked again. One that
  can't be finished goes to the owner as "needs hand".
- **Isolation.** An agent can only answer its own questions and acknowledge its own corrections.
  A paused agent is not quizzed; a read-only agent can read its check but its reply is refused (a reply writes); the gardener has no `memory_check`.

## The other direction: an agent's source is fresher than the brain

Sync runs both ways. In a live run an agent answered a question about a project from Gmail, not
the brain, because the brain's note was stale. In sample-brain terms: Course A's note still said
"Grade the midterm", while Jane Roy's email thread showed the midterm reviewed and Robin's
go-ahead to print it. The agent tried to fix the note and was refused: a fact saying the owner
approved something must cite the owner's message, and it only had its own view-email link.
The changes:

- **A view-email link is a Gmail id.** `normalizeRef` turns a bare link into a `url:` ref, and a
  link carrying `m1.<id>` (Town's `view-email?eid=m1.…`) into `gmail:<hex id>`, the exact message.
- **An approval seen in an exact source becomes a proposal.** "The owner approved X" citing an
  email or a link goes to the owner's inbox instead of being refused; the owner's one tap makes it
  the owner's word. With only the agent's own word, it is still refused.
- **A fix from a link the hub can't open becomes a proposal** (check `link_only_source`, always
  on). A Slack permalink, a Gmail or Outlook web link: the write goes to the owner's inbox with the
  link, for one tap, instead of being refused or committed on the agent's word. Exact ids
  (`gmail:<id>`, Town's view-email link, which carries one) still commit by the usual rules.

## Bringing memory in

Before syncing, the brain should hold what the assistants already know. Memory import
(`src/memimport.ts`) runs it through the capture pipeline, so nothing new decides anything:

| Whose | How | Cited as |
| --- | --- | --- |
| Claude Code | `pocketbrain memsync import claude` (its `memory.files`, or give paths) | `agent_observation`, by claude |
| claude.ai | Export its memory, then `pocketbrain memsync import claude <export.json or .md>` | `agent_observation`, by claude |
| Town, Instinct | `pocketbrain memsync ask town`: at its next `memory_check` it gets `tell_me`, and replies with `memory_dump` | `agent_observation`, by that agent |
| The owner | `pocketbrain memsync import me <notes folder>` | `owner_message` |

Each chunk (under `capture.max_bytes`, cut at paragraph breaks) is stored as a capture: secrets
removed, injection shapes held, the same text twice a no-op. A model lists candidate facts with
their quotes; the checks drop anything the text doesn't say, skip values the brain already holds,
and turn changes and new facts into inbox proposals naming the old value. Nothing is committed
until the owner accepts. Extraction uses the hub's model key, `ANTHROPIC_API_KEY` in `~/.config/pocketbrain/keys/` (step
`capture.extract`, an executor step on `claude-haiku-5-5` by default; `rules/models.yaml` can pick another); without one, captures wait and the
hub's capture pass picks them up. Notion was imported earlier (`pocketbrain import-notion`).

## Pointers, not copies

Importing memory is a one-time bootstrap. Ongoing, an assistant should not keep its own copy at
all: the brain is the memory, and the assistant reads it on every turn and writes through it.

- **Standing instruction.** Each agent is told to call `memory_check` with its orientation, to save
  lasting facts with `remember` (citing the link when that's all it has), and to keep only a
  pointer ("in pocketBrain") in its own memory. Re-paste it into each hosted assistant after a
  change (the text is in `docs/agent-instructions.md`).
- **Swap copies for pointers** (readable memory only): `pocketbrain memsync pointers <agent>` finds
  lines holding a value the brain holds now, next to its subject, and proposes replacing the value
  with `in pocketBrain (<note id>)`. Nothing changes until the owner approves; then the line is
  edited with a backup and re-checked.
- **Brain first:** `pocketbrain memsync brainfirst [days]` lists each agent's writes made without
  reading that note (or searching) in the 24 hours before: the agent answered from its own memory
  or another source, not the brain. Owner-only, from the read and write logs; no model.
- **Drift, not re-import:** the nightly quiz keeps finding stale facts in what the agent remembers;
  a fact the agent has and the brain lacks comes in as one small proposal, never a bulk dump.

## Drift report

`pocketbrain memsync report <agent>` reads an agent's memory files (Claude Code's `CLAUDE.md` and
memory folder, from `memory.files`) line by line against the brain, for the owner:

| Section | A line that | What happens |
| --- | --- | --- |
| Contradicts the brain | names a note in the agent's view and one of its facts ("Jane's phones: …", "Course A next step: …") with a value the brain doesn't hold | a correction to the brain's value, waiting for the owner |
| Stale | holds a value the brain replaced or forgot (the scan above) | a correction, waiting for the owner |
| The brain lacks | names a note in the agent's view and a fact the note doesn't have ("Jane Roy's birthday is March 3") | listed; `memsync import <agent>` brings it in as proposals |

Each line has its `file:line`; contradicts and stale lines also show the brain's value and its
sources. A line about a fact outside the agent's view is only counted, never shown or corrected,
and the brain's value in a correction is what the agent's own read shows (`[withheld]`,
`[[redacted]]`). A line that agrees with the brain, a pointer ("in pocketBrain"), or anything that
names no note in the agent's view is left alone. `--json` prints the whole report. Running it again
proposes nothing new for lines already waiting. Matching is by rule, not by a model: a fact phrased
another way ("Jane coordinates the course now") is caught only by the quiz or the scan.

## Setup

```yaml
# rules/policy.yaml
agents:
  claude:
    memory: { files: ["~/.claude/CLAUDE.md", "~/.claude/projects/-Users-me-pocketbrain/memory"] }
```

Agents without `memory.files` are quizzed. Their standing instructions should say to call
`memory_check` at the start of a conversation (the orientation already does).

## Where the owner sees them

The morning digest lists, under "Needs you", every correction waiting for `memsync approve` or
`memsync decline` (what the agent's memory says and what the brain says), and every approved one
the hub couldn't apply to the file, to fix by hand. Declined, delivered and verified ones stay out.

## Belief radar

The exam grades each assistant; the radar shows each fact. `pocketbrain beliefs` prints one row
per fact in any assistant's carve, with what the brain says now and one cell per assistant that
can see it (code: `src/beliefs.ts`):

| Cell | Means |
| --- | --- |
| in sync | its last answer matches the brain, or its correction was verified |
| drift / differs | its last answer holds an old value, or something the rules can't match |
| fixing | a correction is approved, delivered or applied, or its re-check question is open |
| asked | a question is waiting for its next `memory_check` |
| doesn't remember | it answered "nothing" (it reads the brain instead, which is fine) |
| you said fine | the owner declined the correction |
| never asked | no evidence yet |

Every stored answer is graded again against the brain as it reads today, so when the owner
changes a fact, every assistant that had the old value turns red at once, without a new quiz.
Red rows come first; `--red` shows only those, `--agent <name>` one column, `--json` all of it.

`pocketbrain beliefs fix <key>` is the one tap: it approves every correction waiting for that
fact that still says what the brain says now in that assistant's view (one graded before the owner
changed the fact is declined and the assistant asked again, so a removed value never goes out) (each signed and handed over by memory sync as usual), asks every assistant that was never
asked or whose last answer no longer matches, re-scans readable memories, and leaves paused
assistants alone. A re-scan can find this fact stale in a readable memory; that correction is
approved in the same step (it is the fact you asked to fix), while anything the scan finds for
other facts waits for you as usual. Running it again does nothing new. It only uses memory sync's own functions, so
every rule above still holds: an assistant is only asked about facts in its own carve, and
nothing is served to an agent that it didn't already get from `memory_check`. The radar itself is
owner-only, like `explain`.

### Quiz budget

Each question costs a turn of the assistant's own model, so the radar's questions have a budget:
at most 10 per assistant in any 7 days by default (`--per-week` sets another number). The budget
goes to the facts most worth asking about first: facts the assistant was never asked about, then
the person's standing (inner, close, known; priority only, never access), then how often
assistants read the note in the last 30 days, then the oldest answer. A fact answered in the last
30 days, or with an open question or a correction in flight, is left out.

```sh
pocketbrain beliefs plan                 # what each assistant would be asked next, and what's left this week
pocketbrain beliefs plan --ask           # ask them now, through memsync's own quiz (each assistant's own carve)
```

The gardener's nightly `memory_sync` is unchanged (3 questions per assistant per pass) until the
owner turns the budget on for it. Code: `src/quizplan.ts`.

## Memory exam

Sync fixes drift one fact at a time. The exam says, per assistant, how it is doing overall:
`pocketbrain exam [agent] [--days 7]` (code: `src/exam.ts`). It reads the logs only (no model,
nothing served to an agent) and grades four things over the window:

| Question | From | Counts against it |
| --- | --- | --- |
| Does its own memory agree with the brain? | quiz verdicts in `log/memsync.jsonl` | a stale answer (fail until its correction is verified); questions unanswered for a day (watch: it isn't calling `memory_check`); answers that differ (watch) |
| Does it take the brain's changes? | live change lists in `log/memsync.jsonl` | changed facts it hasn't confirmed for a day (watch: its memory may still hold the old values) |
| Does it read the brain first? | `brainFirst` over the read and write logs | over a quarter of its writes with no read before (watch) |
| Does it cite? | `log/writes.jsonl` | writes refused for their source (watch) |
| Does it stay in its slice? | `log/reads.jsonl`, `log/alerts.jsonl` | asks for notes outside its view (watch); a leak alert (fail) |

"Nothing" from memory is not held against an agent: keeping no copy is what brain-first asks.
Grades are pass, watch, fail, or no data. The report (`digest/exam-<date>.md`) names fact keys
and counts, never a value; each run adds one line to `log/exam.jsonl`.

- **When:** `start` runs it weekly, before the Sunday digest (or the first digest after a week
  without one). The digest shows the grades under Numbers, and an agent that failed under Needs
  you. The first line under Numbers is the one-line scorecard (`src/scorecard.ts`): the latest
  exam's pass count and the latest switch-day score (`docs/switch-day.md`), each with its day. Run it any time; `--quiz` first asks each assistant fresh questions, graded when it next
  calls `memory_check`. The command exits 1 when an agent fails.
- **On the dashboard:** the Agents table has a Memory exam column (the grade, with why on hover),
  and each agent's page has a Memory exam section with the counts and stale fact keys, live over the
  last 7 days.
- **Before a change reaches the real agents:** the agent eval suite has memory episodes
  (`bun evals/run.ts --llm --only agents-memory`): a real model with a stale note in its own
  memory must answer from the brain, report its memory honestly to `memory_check`, apply a signed
  correction, and cite `agent:<name>` for something the owner told it in chat.

## Soak

`bun scripts/memsync-soak.ts` runs 14 simulated days on the sample brain with two fake assistants
holding memories of their own: one on MCP (keeps pointers), one on the browser door (keeps values,
offline three days). The owner edits, forgets and approves; one memory drifts back to an old
value; one writes a replaced value back into the brain; one fix sits in a routine the agent can't
edit; the hub restarts. It reports days to converge, owner cards (and minutes), and anything
wrong left in a memory or the brain. `test/memsync-soak.test.ts` holds the bar.

What it found, and what changed:

- An agent writing back a value the brain had already replaced, on its own word, opened a
  dispute for the owner. Now it is refused as `replaced_value` ("your own memory is stale"),
  without saying what the value is now. A checkable source still makes it a real change.
- A fix the agent couldn't apply was proposed again each time the quiz found the same drift
  (a second card). Now a stuck fix stands for that drift, and it clears itself once the agent
  answers right.

## On the dashboard

Corrections waiting for the owner are cards in Needs you, with Approve and Decline (the same as
`memsync approve|decline`). A fix the agent couldn't apply, or still gets wrong when asked again,
shows as "memory fix stuck" with a link to that assistant.

## Not built yet

- The belief radar on the dashboard (the CLI and the digest only for now).
- Town's wiki is readable only through Town; if Town ever exposes it (or exports it on a routine),
  it becomes a readable memory.
- Facts the agent learned elsewhere and the brain never had are out of scope: the quiz only asks
  what the brain knows.
