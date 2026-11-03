# Sleep, forgetting and explain

Two additions to upkeep. `pocketbrain sleep` is the nightly pass that makes the brain smaller and truer while nobody is using it. `pocketbrain explain <agent> [topic]` is the audit answer: what one agent holds about something, why, and who was handed it. Code: `src/sleep.ts`, `src/merge.ts`, `src/explain.ts`, `src/readlog.ts`.

## Nightly: `pocketbrain sleep`

One command for cron: it runs `upkeep` first (links, dates, freshness, rechecks), then four steps.

| Step | What it does | On its own? | Model? |
|---|---|---|---|
| Forget | Retires a fact nobody used, far past its shelf life | Yes, each one a revertable commit | No |
| Consolidate | Journal lines (episodes) become proposals for durable facts | No: inbox proposals only | Yes (`sleep.consolidate`), checked in code |
| Duplicates | The existing judge step over near-duplicate notes | No: review items | Yes (`upkeep.duplicates`) |
| Morning note | A few lines on top of the next digest | n/a | No |

Only the hub sleeps. On a replica (`rules/hub.yaml`, see [hub.md](hub.md)) the pass writes nothing and its morning line names the hub.

### Forgetting is not ending

Past its shelf life a fact is *unconfirmed*, not *false*. Jane's role, last confirmed 18 months ago, is probably still her role. Setting `valid_to` would write a claim about the world nobody made. So a forgotten fact moves to `history` with `retired: {at, by, why}` and no `valid_to`: the brain stops vouching for it, nothing more. It leaves every view and every cell (history is never served), and stays in the file and in git.

A fact is retired only when all of these hold:

1. It is older than **3x its shelf life** (stale is 2x; the gap is the "fade" window where freshness already labels it stale in every answer).
2. **Nobody used it for 90 days**: no agent was handed its note by a search, a read or a topic context pack, and no journal named the note.
3. The read log is **at least 90 days old**. On a new install "unread" means nothing, so nothing is forgotten; the morning note says how many facts are waiting.
4. It isn't **the owner's word**. A `confirmed-by-owner` fact is never retired; it comes back as "still true?".

**Two ways a fact ends, one place it goes.** An agent (or the owner) that knows a fact stopped being true uses the `retire` tool (`POST /v1/retire`): it gives the end date and a source, goes through the write path like any write, and the old value moves to history with `valid_to` and `ended_by` citing that source. The sleep pass has no end date and no source, only disuse, so it can't honestly go through that path: it would have to invent both. It writes the same history list with `retired` instead. `explain` lists every ended value from both paths, and the conflict steps' supersessions, with who ended it and why.

Each retirement is its own commit in a run. `pocketbrain undo --run <sleep run>` reverts them and writes suppressions so the next night doesn't retire them again. Saying a forgotten fact again (same value, same sources) revives it instead of being a silent no-op.

Notes without shelf-life facts (notes, procedures) that nobody read for 90 days go to an "archive?" list. They're never moved automatically.

**Limits.** Agents on the pasted-view transport read their whole view and leave no per-note trace; a whole-view pull never counts as using a note. Their use is invisible to forgetting, which is one more reason it waits for 3x shelf life.

### Consolidation: journals become proposals, never facts

Journals hold episodes, and only their author and the owner see them (write-quality.md). A model reads unread journal lines and lists the durable facts they state, each with the line number and the exact quote. Then code decides what survives, with the same check capture uses (`checkCandidate`): the quote must be in that line, the value must be what the line says, the attribute must exist for the type, and the entity is resolved like any write. What restates a known value is counted, not written.

Every surviving fact is an inbox proposal, in the format `inbox --accept` already reads, from the journal's author, citing the line's own sources plus `agent:journal/<agent>/<month>#<date>`. Its reason says **which agents would newly see it** if accepted: a journal is private to its author, a fact on a shared note isn't. A fact seen on several days or by several agents is proposed first; at most 8 a night, the rest wait.

**A journal is as sensitive as the most its author can read.** Town's view goes up to private, so Town's journal only goes to a model whose `max_sensitivity` is private (a local one). With the default hosted model, only trial agents' journals are read; the morning note says what was held back and why. A paused agent's journal waits. Lines are read once (`log/sleep-state.json`).

Captures aren't consolidated again: capture already extracts on arrival.

### Duplicates and `pocketbrain merge`

The judge step was already there; sleep runs it nightly and the morning note points at the command that carries out the owner's yes: `pocketbrain merge <keep> <drop>`. Rules only:

- a fact the kept note lacks moves across with its flags;
- the same value merges sources (conflict step 1); list items are unioned;
- a different value opens a dispute: merging never picks a winner;
- flags only tighten: facts from a more sensitive note keep that level, and its names and tags are not added (a name can be the secret, a tag can widen a slice);
- refused, before anything is written, unless every assistant sees both notes the same way (both or neither, nothing hidden on either but the same attributes; the resolver whole when a dispute would open), and when a carve of both notes for every agent before and after the merge shows any agent would read something it can't read today, when the notes are in different areas, when an exclude in `rules/policy.yaml` or `rules/slices.yaml` names the dropped note or one of its facts, while either note has an open dispute (a fact or a list item), or while OpenFGA hasn't confirmed every assistant's slices; see `docs/same-person.md`;
- the dropped note becomes a pointer (`status: merged`, `merged_into`); upkeep repoints links to it.

### Contradictions between twin notes

Projects and organisations with the same name, area and level fold into one page first (docs/fold-twins.md); what is left here is the rest. Before anyone merges, the night pass (upkeep, which the gardener's `upkeep_run` also runs) compares the twins upkeep lists as `possible-duplicate`: two people, orgs or projects with the same name or alias. When both hold the same attribute with different current values, from sources that share no ref, it opens one dispute packet (`origin: contradiction`) on the older note. The packet lists both values with their sources and dates, and the conflict order (stronger source, then newer) marks a `suggested` side. It never picks a winner and changes neither note. Only the owner sees its values and answers it (dashboard or digest): the resolver's view withholds both values and the other note, it can't settle it with evidence, and a reply it relays waits for the owner's confirmation. The answer is written to the packet's `fact_key`. If that fact changed since the packet opened, its current value goes to history and its level and `share_with` stay (an answer to any dispute only tightens those). While another dispute holds the same fact, the packet waits: that one is answered first. A packet left open after the owner answered the fact another way goes to the owner. The same pair with the same values is never opened twice, answered or not.

What is not a contradiction: a value that is a less specific form of the other ("Coordinator" and "Course coordinator"), the same source cited on both, a list or a date-only value.

The packet takes the stricter level of the two notes and facts, so a private twin keeps the values from the resolver. When the two notes sit in different areas, a side is shared with named agents only, or some agent can see one side but not the other, there is no packet, only a `contradiction` review line. The finding never names the other note or a value, and the gardener's `upkeep_run` returns a finding on a fact only when that fact itself is in its view.

## Audit: `pocketbrain explain <agent> [topic]`

```
pocketbrain explain town                       # the slice's shape and what town read
pocketbrain explain town "Maple Trust"         # every matching note, in or out, and why
pocketbrain explain muse people/sam-lee#phones # one fact
```

For each note matching the topic in the **whole** brain: in or out of the agent's slice and why (which slice selected it, or which rule kept it out: type not shared, above the ceiling, outside the slices, excluded by name), then each fact in or out and why (attribute not in slice, do-not-share, fact-level sensitivity), with value, source, verification and writer, the preview's leak flags, and who was handed the note (per agent, per operation, last date).

- **The owner's command only.** It names notes and values outside the agent's slice, so it's never an MCP tool or an API route.
- **In and out are today's rules; reads are history.** A read of a note that's out today is called out ("the rules changed since, or something to look into") rather than hidden.
- **The read log is hash-chained** like the write log. `explain` verifies it and says where the chain breaks if a line was edited or removed. Lines from before the chain are counted, not judged.

## Who read what: `pocketbrain reads <agent>`

```
pocketbrain reads town              # the last 7 days, newest first
pocketbrain reads town --days 30    # up to 90
pocketbrain reads town --json
```

Day by day (in `owner.timezone` from policy.yaml, else UTC), from the read log: the notes the agent was handed, with each note's area and how many times, the words of each search or topic with how many notes it found, whole-view pulls (`context_pack` with no topic, which name no note) and notes asked for and not given. The dashboard's agent page shows the same days under "What it read, day by day", after "What it looked for". Code: `src/whoread.ts`.

- **Unusual.** A day gets one line, "unusual: 3 of 4 notes outside its usual areas (personal)", when at least two of its notes, and at least half of them, sit in areas the agent wasn't handed any note from in the 28 days before. An agent with reads on fewer than 3 earlier days has no usual areas yet and is never flagged. It is a line to look at, not an alert: nothing is paused or changed.
- **Owner only**, like `explain`: never a tool or an API route. Search words are the agent's own, so control characters and line breaks are printed as spaces.
- A note deleted since shows as `(gone)` and counts as outside the usual areas.

## See as, on the dashboard

`explain` says why a note or fact is in or out. To see what an assistant is actually handed, open Who sees what (`/map`) and click the assistant. The search box there runs that assistant's own search (`previewSearch` in `src/core.ts`): the same snapshot (its cell when the hub serves cells), the same ranking and the same `[withheld]` and `[[redacted]]` marks. Each hit opens the note exactly as its read returns it (`previewRead`), and a note outside its view says what the assistant would be told ("no note … in your view"). A paused assistant shows its pause message. Looking here is not logged as the assistant's read, so it never shows up in `reads`, `explain` or the forgetting signal, and it raises no served-text alert. Only the owner's dashboard calls these functions; no agent door does (`test/see-as.test.ts`).

## Decisions recorded

- Forgetting retires, never ends, a fact; automatic only past 3x shelf life, unused 90 days, with 90 days of read log, never the owner's word; undo by run. **Automatic, decided by the owner (2026-10-08)** over asking first.
- Whole-view pulls don't count as use.
- Journal sensitivity is the author's ceiling; a model sees a journal only at or above it.
- Consolidation proposes; it never writes, and never refreshes `last_confirmed` from a model's reading.
- Merge never picks a winner, and a more sensitive duplicate never loosens into a less sensitive note.
- `explain` is owner-only; the read log is hash-chained.
