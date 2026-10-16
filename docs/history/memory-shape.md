# pocketBrain: memory shape (what a fact looks like on disk)

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

> Status: draft, 2026-10-08. Owned by the "Memory shape" thread. It implements [architecture.md](architecture.md) section 0 (agreed v1), mainly 0.1 "Unit of fact" and 0.6 (rules, owners, idempotency, conflicts). Where this spec forces a change to 0.6, the change is listed in section 9 and was sent to the architecture thread. Validated against 9 real rows read from Notion on 2026-10-08, one or more from every non-empty database (section 8).

---

## 1. Summary

- **One Markdown file per thing** (a person, an org, a project, a decision, a note, a money item, an agent capability). Plain YAML frontmatter, Markdown body, `[[wiki-links]]`. Readable by Obsidian, Basic Memory and GBrain without pocketBrain.
- **The file path is the id.** `people/sam-okafor.md` has id `people/sam-okafor`. Ids never change. Renames go in `aliases`.
- **Shelf-life facts live in frontmatter under `facts:`**, one record per attribute, each with its own `as_of`, `sources`, `verification` and author. The fact key is `<id>#<attribute>`, for example `people/robin-castell#role`. It is derived from the location, never typed.
- **Prose stays prose.** Notes and decisions carry note-level `sources` and `updated`. Claims inside prose get their sources as Markdown footnotes.
- **Nothing is deleted.** A replaced value moves to `history:` with a `valid_to`. A replaced or merged file gets `status: superseded` or `merged` and a pointer.
- **Computed things are never stored**: freshness, source rank, and default review dates are computed when a view is built, so they can't go stale on disk.

## 2. Folder layout

```
brain/
  people/        one file per person            people/sam-okafor.md
  orgs/          one file per organisation      orgs/brightpath.md
  projects/      one file per project           projects/northfield-course-101-fall-2026.md
  decisions/     one file per decision          decisions/2026-09-22-initech-offer-declined.md
  notes/         notes and procedures           notes/louis-communication-style.md
  money/         accounts, comp, checklists     money/savings-room.md
  agents/<agent>/ one file per capability        agents/town/notion-second-brain-sync.md
  rules/         RULES.md, policy.yaml, checks.yaml, standing.yaml   (Louis only)
  disputes/      one file per open or closed conflict   disputes/c-0007.md
  inbox/         proposed writes waiting for an owner or Louis
  comms/         dated agent posts: comms/<day>/<message id>.md (message_id keeps the raw id); an id with characters other than
                 letters, digits, - and _ gets them as _ plus a short hash of the original; a name
                 another message already holds gets -2, -3
```

**Folders are by type, not by area.** Area (`teaching`, `personal`, `side-project`, `work`, `volunteer`, `cottage`) is a frontmatter field. Reasons: a person or org is often relevant to several areas, links must not break when an area changes, and the Notion mapping and GBrain both organise by type. Ownership checks read the `area` field, so **changing `area` on an existing file is always a cross-area write** and goes to `inbox/` for Louis. (This changes the `teaching/: town` path syntax in 0.6; see section 9.)

## 3. Common frontmatter (every file)

```yaml
---
id: people/robin-castell             # = path without .md; never changes
type: person                         # person | org | project | decision | note | procedure | money | capability
title: Robin Castell
aliases: [Rob Castell]               # other names; used by entity resolution
area: personal                       # owner is looked up in rules/policy.yaml
sensitivity: personal                # public | personal | private | secret (see 6)
status: active                       # active | ended | superseded | merged
created: 2026-10-04
updated: 2026-10-04                  # last change to anything in the file
by: instinct                         # who created it; stamped by the write path
sources: [instinct-mem:entities/people/robin-brightpath]   # note-level sources for the prose
tags: []
legacy: { notion: 00000000aaaa0000bbbb0000cccc0001, fact_key: "instinct:people:robin-castell" }
---
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Lowercase slug path. Collision: add `-2`. Never reused, even after `merged`. |
| `type` | yes | Decides which attributes are expected and their merge rule (`rules/checks.yaml`). |
| `title`, `aliases` | title yes | Entity resolution matches on title, aliases, and identifying facts (email, phone, handle). |
| `area` | yes | One area per file. Determines the owner. |
| `sensitivity` | yes | Floor for everything in the file, body included. |
| `status` | yes | `superseded` needs `superseded_by`; `merged` needs `merged_into`. |
| `created`, `updated`, `by` | yes | Written by the write path. Agents never type `by`; it comes from the identity of the caller (the gateway token later, the git author in v1). |
| `sources` | yes for notes, decisions | Note-level provenance. See section 5. |
| `supersedes` / `superseded_by` / `merged_into` | when relevant | File-level chains only. Facts don't need `supersedes` (section 4.4). |
| `legacy` | importer only | Notion page id and old `Fact key`. Lets the Notion import and Town's sync stay idempotent against the old keys. |

## 4. Facts

### 4.1 Where facts are required

From 0.1: `facts:` is required only where values have a shelf life. The per-type lists live in `rules/checks.yaml` (section 7). Today:

| Type | Expected fact attributes |
|---|---|
| person | `role`, `org`, `relationship`, `emails` (list), `phones` (list), `last_contact` |
| org | `kind`, `website` |
| project | `status`, `next_step`, `due`, `schedule_changes` (list) |
| money | `balance` or `amount`, `due`, `status` |
| capability | `status`, `schedule`, `tools` (list) |
| decision | `outcome` (single; see 4.6) |
| note, procedure | none. Prose plus note-level `sources` and `updated`. |

Anything else may also be a fact. An attribute not declared for its type is accepted as single-valued with the default merge, and the daily digest lists it so Louis can declare or drop it.

### 4.2 A single-valued fact

```yaml
facts:
  role:
    value: COO & CFO
    as_of: 2026-09-18                 # event time: when this became true or was observed true
    sources: [gmail:0000aaaa1111bb01] # first = original; later confirmations are appended
    verification: verified-by-source  # confirmed-by-louis | verified-by-source | self-reported | unverified
    confidence: stated                # stated | inferred   (default stated; omit when stated)
    by: town                          # stamped by the write path
    recorded: 2026-10-04              # when it entered the brain
    last_confirmed: 2026-10-04        # optional; bumped by a same-value write
```

| Field | Required | Meaning |
|---|---|---|
| `value` | yes | Scalar or a small map. Normalized before comparison (section 4.5). |
| `as_of` | yes | ISO date; partial dates allowed (`2026`, `2026-10`). Add `as_of_approx: true` when the date was estimated, for example by the Notion importer. |
| `sources` | yes | One or more source refs (section 5). "No source, no fact" is a check. |
| `verification` | yes | Same four values as Notion. |
| `confidence` | no | `inferred` marks agent inference. Notion's `Confidence: Unverified` maps to `verification: unverified`, not here. |
| `by`, `recorded` | yes | Written by the write path. |
| `last_confirmed` | no | Last same-value write. Feeds freshness. |
| `sensitivity` | no | Raises the level for this one fact above the file's level, never lowers it. |
| `review_after` | no | Only to override the per-type shelf life. |
| `dispute` | when disputed | Conflict id, see 4.7. |

### 4.3 A list fact

Lists are sets of items. Each item carries its own provenance, so "a second email address" never conflicts with the first. (Illustrative values; Notion stores no emails today.)

```yaml
facts:
  emails:
    items:
      - value: rob@brightpath.example
        as_of: 2026-09-18
        sources: [gmail:0000aaaa1111bb01]
        verification: verified-by-source
        by: town
        recorded: 2026-10-04
      - value: rob.castell@mail.example
        as_of: 2025-03
        as_of_approx: true
        sources: [instinct-mem:entities/people/robin-brightpath]
        verification: self-reported
        by: instinct
        recorded: 2026-10-04
        valid_to: 2026-06-30          # ended items stay, marked
```

An item's identity is its **item key**: the normalized value by default, or a declared key field for map-valued items (for `schedule_changes`, the session number; see example 8.2). The fact key of an item is `<id>#<attribute>[<item key>]`.

### 4.4 History and supersede

When a single value is replaced, the old record moves under `history:` with `valid_to` set to the new value's `as_of`, and the step from 0.6 that decided it (illustrative values):

```yaml
history:
  role:
    - value: VP Finance
      as_of: 2025-03
      valid_to: 2026-09-18
      sources: [gmail:0000cccc...]
      verification: verified-by-source
      by: instinct
      recorded: 2026-10-04
      ended_by: { step: 4, at: 2026-10-08, by: reflect }   # 0.6 step number, when, and who applied it
```

When the owner says a replaced value was never right (the dashboard's "It was never right" after an edit), its `ended_by` gains `correction: true` and the right value takes the old one's `as_of`: a fix, not a change in the world. History shows it as corrected.

No fact-level `supersedes:` is needed: the attribute key is the same, so the chain is simply `history.<attr>` in date order followed by `facts.<attr>`. Notion needed `Supersedes` because each new value was a new row with a new key. File-level `supersedes` stays for decisions that replace decisions and for merged duplicates.

### 4.5 Write semantics (what makes repeat writes harmless)

Every writer calls one operation: `assert(id, attribute, value, as_of, sources, verification)`, plus `retract(id, attribute, item_key?)` to end a value or a list item. There is no update or delete.

1. **Resolve the entity.** By `id` if given; otherwise match on title, aliases and identifying facts. Ambiguous match goes to `inbox/` as "new or same as X?". (0.6, unchanged.)
2. **Normalize the value** with the attribute's normalizer from `checks.yaml`: trim and case-fold names, E.164 phones, lowercase emails, ISO dates, `CAD 1234.00` style amounts, collapse whitespace.
3. **Hash.** `write_hash = sha256(fact_key, normalized value, as_of, sorted sources)`. A write whose hash already appears on the record or in its history is a no-op with no commit. This is what makes Town's daily sync and Muse's retries safe.
4. **Compare with the live value and apply the attribute's merge rule:**

| Merge rule | Used for | Same value | Different value |
|---|---|---|---|
| `replace` (default for single) | role, org, status, next_step | Append new sources, bump `last_confirmed`, keep the earliest `as_of`. No conflict. | Run the 0.6 conflict steps 3 to 7. |
| `set` (default for lists) | emails, phones, tools, schedule_changes | Same item key: merge sources, as above. | New item key: add the item. Never a conflict. |
| `max` | last_contact | Keep the later date. Older values are dropped as no-ops, not conflicts. | Same. |
| `append` | an interaction log, if one is ever needed | Same hash: no-op. | Append. |

5. **Run the checks** in `rules/checks.yaml` (source present, area ownership, no secrets, and so on).
6. **Commit** under the writer's identity, or write the proposal to `inbox/`.

`retract` sets `valid_to` on the live value or list item. A retraction needs a source like any assert.

### 4.6 Decisions

A decision is prose, plus a small fixed frontmatter: `decided_on`, `options` (list of strings), and one fact, `outcome`. A reversed decision is not edited. A new decision file is written with `supersedes: decisions/<old>`, and the old file gets `status: superseded` and `superseded_by`. This keeps "what did I decide in September" answerable.

### 4.7 Disputed facts

When 0.6 step 7 is reached, the live record is not overwritten. It gains a `dispute` id and a `candidates` list. Illustrative: the second candidate is what a careless reading of the 2026-10-05 CoursePortal reminder in 8.2 would assert.

```yaml
facts:
  next_step:
    dispute: c-0007
    candidates:
      - { value: "Session 6 moved to Sun 2026-10-11 12:00-15:00", as_of: 2026-09-28, sources: [gmail:0000aaaa1111bb03], verification: verified-by-source, by: town, recorded: 2026-10-04 }
      - { value: "Session 6 held Mon 2026-10-05 as planned", as_of: 2026-10-05, sources: [gmail:0000aaaa1111bb05], verification: verified-by-source, by: town, recorded: 2026-10-07 }
```

`disputes/c-0007.md` holds the conflict packet the resolver sees: both candidates, the steps already tried, the resolver's notes, and the outcome. When Louis answers, his reply becomes the winning record with `verification: confirmed-by-louis` and his message id as source; the losing candidates move to `history` with `ended_by: { step: 7, ... }`; `dispute` and `candidates` are removed. Views show both candidates with `freshness: disputed` until then.

### 4.8 What is computed at build time, never stored

| Computed | From |
|---|---|
| `freshness` (`current / due / stale / disputed`) | `as_of`, `last_confirmed`, per-type shelf life, `dispute` |
| `review_after` default | `as_of` or `last_confirmed` plus shelf life from `checks.yaml` |
| source rank (for 0.6 step 5) | `verification`, `confidence`, and the source scheme's class (section 5) |
| "who changed what when" (Notion's Fingerprint) | git log |

Storing these would recreate Notion's drift: the `Review after` dates and fingerprints were typed, so they were wrong or broken in the rows read for this spec (section 8.9).

A `stale` or `due` label asks for a re-check, not deletion. Agents are told (orientation rule 5, the `context_pack` tool description) that a stale fact they can open the source of gets checked there and written back with that source, or retired if it ended; one that can't open the source says the fact may be out of date and doesn't ask another assistant. The agent episode `agents-stale-reverify` (`bun evals/run.ts --llm --only agents`) checks it.

## 5. Sources

A source ref is `scheme:id`. One fixed list of schemes; each scheme has a class used for ranking.

| Scheme | Example | Class | Normalization |
|---|---|---|---|
| `imsg` | `imsg:phonemsg-00000000000000000000000000` | louis (when the sender is Louis) | as given |
| `louis` | `louis:2026-10-08/project-chat` | louis | Louis typing directly in a trusted session |
| `gmail` | `gmail:0000aaaa1111bb01` | exact | **`m1.<base64>` refs decode to the hex id**: `m1.MDAwMGFhYWExMTExYmIyMA` is `gmail:0000aaaa1111bb20`. Both forms occur in Notion today. |
| `gmail-thread` | `gmail-thread:0000aaaa1111bb09` | exact, weaker than a message | as given |
| `gcal` | `gcal:evt1.bG91aXM...` | exact | as given |
| `doc` | `doc:drive/1AbC...`, `doc:town-library/work-advisory` | exact if it names one file, vague otherwise | |
| `url` | `url:https://...` | exact | strip tracking params |
| `call` | `call:2026-07-17/sam-okafor` | exact if dated | |
| `notion` | `notion:00000000aaaa00...` | as strong as what the page cites | importer only |
| `town-wiki`, `instinct-mem`, `town-routine` | `instinct-mem:entities/people/robin-brightpath` | agent memory (vague) | |
| `agent` | `agent:town` | self-description | for capabilities only |
| `unverified` | `unverified` | none | allowed only with `verification: unverified` |

**Lineage (Notion's "Original source lineage").** When a value was copied from another agent's memory, the source entry is a map: `{ ref: gmail:0000aaaa..., via: instinct-mem:entities/people/robin-brightpath }`. The `as_of` is the original's, not the copy's, so copies never count as "newer" (0.6 step 4).

**Source rank** for 0.6 step 5, computed: `confirmed-by-louis` or a `louis`-class source is 5; `verified-by-source` is 4; any exact-class ref is 3; agent memory or a vague ref is 2; `confidence: inferred` is 1; `unverified` is 0.

**Prose sources.** Claims in a body cite their own source with a Markdown footnote: `Seance 4 was cancelled and recorded.[^g1]` and at the end `[^g1]: gmail:0000aaaa1111bb06`. A claim with no source cites `[^u]` defined as `[^u]: unverified`. Footnotes are plain GFM and render in Obsidian and GitHub.

## 6. Sensitivity

`public | personal | private | secret`, as in README 4.1.

- The file's `sensitivity` is the floor for the whole file, body included. A single fact may be raised (`sensitivity: private` on one record); nothing can be lowered.
- **If a value is more sensitive than the file, it must be a frontmatter fact or a separate file.** Prose can't be partially filtered when views are compiled.
- Notion `Sensitive: checked` maps to `private`. Money and compensation files are `private` by type default.
- `secret` is reserved for `age`-encrypted files later. In v1 a check refuses any write marked `secret`, matching the Notion rule that passwords, account numbers and the like are never stored.
- Source refs can carry personal data (the `gcal:evt1...` ids embed Louis's email in base64). Refs inherit the sensitivity of the fact they support.

## 7. Rules files

Only Louis edits `rules/` (0.6). Formats:

**`rules/RULES.md`** (guidance, compiled into every view): one level-2 heading per rule, with a stable id and a metadata line.

```markdown
## rule:no-em-dashes · Never use em dashes when writing as Louis
Kind: guidance · Since: 2026-10-04 · Source: imsg (undated, per notes/louis-communication-style) · Applies to: all agents

Never use em dashes, on any surface.
```

**`rules/policy.yaml`**: agents, aliases, tiers, areas and owners, resolver.

```yaml
agents:
  instinct: { tier: core, aliases: [Instinct] }
  town:     { tier: core, aliases: [Town, Vamprose, "Vamprose / Town"] }   # Notion uses all three
  claude:   { tier: core, aliases: [Claude] }
  muse:     { tier: trial, aliases: [Muse] }
  reflect:  { tier: core, inside_wall: true }
areas:
  personal:     { owner: instinct }
  teaching:     { owner: town }
  side-project: { owner: claude }
  work:         { owner: instinct }
  volunteer:    { owner: town }
  cottage:      { owner: instinct }
resolver: instinct
```

**`rules/checks.yaml`**: the enforced checks switched on, plus per-type attribute settings (cardinality, merge rule, normalizer, item key, shelf life, default sensitivity).

```yaml
checks: [schema, source_present, own_area, area_change_needs_louis, no_secret_shapes,
         approval_needs_message_id, fact_key_derivable, no_agent_in_ids, rules_read_only, as_of_not_future]
types:
  person:
    sensitivity: personal
    attributes:
      role:         { merge: replace, normalize: text, shelf_life: 180d }
      org:          { merge: replace, normalize: link, shelf_life: 180d }
      relationship: { merge: replace, normalize: text, shelf_life: 365d }
      emails:       { merge: set, normalize: email, shelf_life: 730d }
      phones:       { merge: set, normalize: e164, shelf_life: 730d }
      last_contact: { merge: max, normalize: date }
  project:
    attributes:
      status:           { merge: replace, shelf_life: 30d }
      next_step:        { merge: replace, shelf_life: 14d }
      due:              { merge: replace, normalize: date }
      schedule_changes: { merge: set, item_key: session, shelf_life: until_date }
  money:
    sensitivity: private
    attributes:
      balance: { merge: replace, normalize: money, shelf_life: 30d }
      amount:  { merge: replace, normalize: money }
  capability:
    attributes:
      status:   { merge: replace, shelf_life: 90d }
      schedule: { merge: replace, shelf_life: 90d }
      tools:    { merge: set, shelf_life: 90d }
```

**`rules/standing.yaml`**: precedence rules Louis creates from an escalation answer (0.6, "standing rule"). They name **source classes, never agents**:

```yaml
- id: standing:teaching-schedule-registrar
  when: { type: project, area: teaching, attribute: schedule_changes }
  prefer: [gmail from registrar or course coordinator, gcal, town-wiki]
  source: imsg:phonemsg-0000...   # Louis's reply that created it
  since: 2026-10-09
```

## 8. Validation: real Notion rows converted

Nine rows were read on 2026-10-08 with the Notion MCP page fetch. (SQL and row queries hit Notion's `usage_limit_reached` again, so rows were read one page at a time; the Receipts database is empty.) Money and compensation values are replaced with `[redacted in spec]` because this file may be committed to GitHub later; the real files would keep them at `private`.

### 8.1 People: Sam Okafor (written by Town)

Notion: `Fact key: person:sam-okafor`, `Role: Professional networking contact`, `Org:` empty, `Relationship: Discussed an agent harness for business operations; met 2026-07-17`, `Last contact: 2026-07-17`, `Related project: Agent Harness for Business Operations (Sam Okafor)` (text), `Date: 2026-10-04`, `Valid from:` empty.

```markdown
---
id: people/sam-okafor
type: person
title: Sam Okafor
area: side-project
sensitivity: personal
status: active
created: 2026-10-04
updated: 2026-10-04
by: town
sources: [gmail:0000aaaa1111bb02]
legacy: { notion: 00000000aaaa0000bbbb0000cccc0005, fact_key: "person:sam-okafor" }
facts:
  relationship:
    value: professional networking contact
    as_of: 2026-07-17
    sources: [gmail:0000aaaa1111bb02]
    verification: verified-by-source
    by: town
    recorded: 2026-10-04
  last_contact:
    value: 2026-07-17
    as_of: 2026-07-17
    sources: [gmail:0000aaaa1111bb02]
    verification: verified-by-source
    by: town
    recorded: 2026-10-04
---
Met on 2026-07-17 (10:00 to 10:45 EDT) to discuss an agent harness for business operations; Sam sent the invitation.[^g1] See [[projects/agent-harness-for-business-operations]].

[^g1]: gmail:0000aaaa1111bb02 (Google Calendar notification)
```

Didn't fit: Notion's `Role` held a relationship type, so it moved to `relationship`; `role` and `org` stay absent rather than invented. The area is a guess (side-project, from "Claude: building stuff"); the importer marks guesses for Louis.

### 8.2 Projects: Northfield COURSE 101, Fall 2026 (Instinct row, three appended Town sections)

The Notion row holds about ten claims with different sources and verification states, from two agents, in one body. It is not one fact.

```markdown
---
id: projects/northfield-course-101-fall-2026
type: project
title: Northfield COURSE 101, Fall 2026
aliases: [Intro to Systems, COURSE 101]
area: teaching
sensitivity: personal
status: active
created: 2026-10-04
updated: 2026-10-07
by: instinct
sources: [gmail-thread:0000aaaa1111bb10, gmail:0000aaaa1111bb04]
legacy: { notion: 00000000aaaa0000bbbb0000cccc0002, fact_key: "instinct:projects:northfield-course-101-fall-2026" }
facts:
  status:
    value: active
    as_of: 2026-08-24
    sources: [gmail:0000aaaa1111bb04]
    verification: verified-by-source
    by: instinct
    recorded: 2026-10-04
  schedule_changes:
    items:
      - value: { session: 4, original: 2026-09-21, change: cancelled, note: recorded; link on Canvas 2026-09-25 }
        as_of: 2026-09-21
        sources: [unverified]
        verification: unverified
        by: town
        recorded: 2026-10-04
      - value: { session: 6, original: 2026-10-05, change: moved, new: "2026-10-11 12:00-15:00", room: B-200 }
        as_of: 2026-09-28
        sources: [gmail:0000aaaa1111bb03, gmail:0000aaaa1111bb06]
        verification: verified-by-source
        by: town
        recorded: 2026-10-04
  next_step:
    value: Teach session 6 on Sun 2026-10-11, 12:00-15:00, room B-200
    as_of: 2026-09-28
    sources: [gmail:0000aaaa1111bb03]
    verification: verified-by-source
    by: instinct
    recorded: 2026-10-04
---
Hybrid synchronous course, Mondays 18:45 to 21:45, 2026-08-24 to 2026-11-30.[^g1] Course logistics only; no student information is stored here.

- CoursePortal still listed 2026-10-05 as "Cours" on the morning of 2026-10-05, although the session had moved.[^g2] Open, see [[disputes/c-0007]] if it isn't just a stale table.
- The course content repo is teacher-only; student answers come from the course MCP.[^u]
- Publishing the Zoom link in CoursePortal only works locally in Louis's signed-in browser.[^u]

[^g1]: gmail:0000aaaa1111bb04 (Morgan Tessier, 2026-06-25)
[^g2]: gmail:0000aaaa1111bb05 (CoursePortal reminder check, 2026-10-05)
[^u]: unverified
```

Didn't fit, and what the format caught:
- **Both Notion rows say "Oct 6 session moved"; 2026-10-06 is a Tuesday and the course runs on Mondays.** Town's later note calls it "Oct 5 (seance 6)". Keying `schedule_changes` items by session number instead of date makes the two spellings collide on the same key, so the error surfaces instead of producing two items. The import should flag this for Louis rather than silently pick 10-05.
- The same move is also a Notion **Decision** row (8.3). In the new format it lives once, here, and the decision file is merged.
- Notion `Next step` mixed a fact and a date into prose; it is still prose here, but now dated and sourced.
- `Valid from: 2026-10-04` in Notion is the day Instinct added the provenance columns, not when anything became true (same on every row read). The importer takes `as_of` from the cited source's date instead.

### 8.3 Decisions: Northfield Oct 11 session move

```markdown
---
id: decisions/2026-09-28-teaching-oct-11-session-move
type: decision
title: Northfield Oct 11 session move
area: teaching
sensitivity: personal
status: merged
merged_into: projects/northfield-course-101-fall-2026
created: 2026-10-04
updated: 2026-10-08
by: instinct
sources: [unverified]
legacy: { notion: 00000000aaaa0000bbbb0000cccc0008, fact_key: "instinct:decisions:teaching-oct-11-session-move" }
---
Imported from Notion as a topic with no details ("Details not supplied; unverified"). The facts are in [[projects/northfield-course-101-fall-2026]] under `schedule_changes`, session 6.
```

Didn't fit: a decision with no decision date, no options and no outcome is a duplicate pointer, not a decision. Its Notion source was "Louis's message asking Town to read the pages", which supports nothing in the row; that's the kind of source the `source_present` check should reject (a ref must be about the claim, which only a human or the resolver can judge, so the importer marks it `unverified`).

### 8.4 Decisions: 2026-09-22 Initech offer, declined (sensitive)

```markdown
---
id: decisions/2026-09-22-initech-offer-declined
type: decision
title: Initech offer, declined
area: personal
sensitivity: private                 # Notion Sensitive: checked
status: active
created: 2026-10-04
updated: 2026-10-04
by: instinct
decided_on: 2026-09-25               # final answer; Notion's Decision date 09-22 was the first "not as it stands"
options: ["Accept", "Counter [redacted in spec]", "Clean pass"]
sources: [imsg:2026-09-22..2026-09-25, gmail-thread:0000aaaa1111bb09]
legacy: { notion: 00000000aaaa0000bbbb0000cccc0004, fact_key: "instinct:decisions:2026-09-22-initech-offer-declined" }
facts:
  outcome:
    value: Declined; stays at Globex
    as_of: 2026-09-25
    sources: [gmail:0000aaaa1111bb07, imsg:2026-09-22..2026-09-25]
    verification: confirmed-by-louis
    by: instinct
    recorded: 2026-10-04
---
Offer for Senior Director at Initech, [redacted in spec].[^m1]

Why Louis passed: lower total compensation; less liquid equity; timing; a conversation at Globex.[^m1]

- 2026-09-21: Chris Varga confirmed HR would send the offer.[^g1]
- 2026-09-22: Louis said he couldn't accept it as it stood.[^g2]
- 2026-09-25: final answer, stays at Globex; Chris proposed keeping in touch.[^g3]

[^m1]: imsg:2026-09-22..2026-09-25 (Instinct memory: knowledge/decisions)
[^g1]: gmail:0000aaaa1111bb12
[^g2]: gmail:0000aaaa1111bb11
[^g3]: gmail:0000aaaa1111bb07
```

Didn't fit: the Instinct source is a date range of iMessages, not message ids. The format allows it (`imsg:<range>`) but ranks it as vague until ids are filled in; this applies to most Instinct rows, which cite "Louis's messages" or Instinct memory paths.

### 8.5 People + Orgs: Robin Castell (Instinct row, Town corrections)

```markdown
---
id: people/robin-castell
type: person
title: Robin Castell
aliases: [Robin, Rob (Brightpath)]
area: personal
sensitivity: personal
status: active
created: 2026-10-04
updated: 2026-10-04
by: instinct
sources: [instinct-mem:entities/people/robin-brightpath]
legacy: { notion: 00000000aaaa0000bbbb0000cccc0001, fact_key: "instinct:people:robin-castell" }
facts:
  role:
    value: COO & CFO
    as_of: 2026-09-18
    sources: [gmail:0000aaaa1111bb01]
    verification: verified-by-source
    by: town
    recorded: 2026-10-04
  org:
    value: "[[orgs/brightpath]]"
    as_of: 2026-09-18
    sources: [gmail:0000aaaa1111bb01]
    verification: verified-by-source
    by: town
    recorded: 2026-10-04
  relationship:
    value: close friend
    as_of: 2026-09-15
    as_of_approx: true
    sources: [{ ref: imsg:unknown, via: instinct-mem:entities/people/robin-brightpath }]
    verification: self-reported
    by: instinct
    recorded: 2026-10-04
---
On 2026-09-18 Louis introduced him to his Initech contacts.[^g1] Louis also connected him with Globex contacts and arranged a personal product order.[^u]

[^g1]: gmail:0000aaaa1111bb14 ("Connecting dots"), gmail:0000aaaa1111bb13 ("Brightpath opportunity")
[^u]: unverified
```

and `orgs/brightpath.md` with `aliases: [Brightpath Running]`. Didn't fit: Notion `Org: Brightpath (Brightpath Running)` is free text with an alias in parentheses, so orgs become entities. `Relationship` mixed a stable relationship with one-off events; the events moved to the body. Town correcting Instinct's row (surname, role) was an edit to another agent's row in Notion; under 0.6 it would be a direct write only if Town owned `personal`, otherwise a proposal.

### 8.6 Research and notes: Louis communication style (Town wiki dump)

```markdown
---
id: notes/louis-communication-style
type: note
title: Louis communication style
area: personal
sensitivity: personal
status: active
created: 2026-10-04
updated: 2026-10-04
by: town
sources: [{ ref: gmail:0000aaaa1111bb08, via: town-wiki }]
verification: unverified            # note-level, from Notion Confidence: Unverified
legacy: { notion: 00000000aaaa0000bbbb0000cccc0007, fact_key: "note:louis-communication-style" }
---
## Language
Matches the recipient: French with Northfield and local French-speaking contacts, English with English-speaking contacts.

## Length and tone
Most replies are one line ... (prose kept as is)

## Sign-offs
"Cheers, L." most common.[^g1]

Rules for agents writing as Louis moved to [[rules/RULES#rule:no-em-dashes]] and [[rules/RULES#rule:linkedin-tone]].

[^g1]: gmail:0000aaaa1111bb08
```

Didn't fit: **two of Louis's hard rules ("never use em dashes", LinkedIn tone) live inside an unverified note.** Rules belong in `rules/RULES.md`, which only Louis edits; the importer proposes them there and Louis confirms. Notes also need a note-level `verification` field, which isn't in the common frontmatter yet; this spec adds it as optional for notes.

### 8.7 Agent capabilities: Notion Second Brain sync (Town)

```markdown
---
id: agents/town/notion-second-brain-sync
type: capability
title: Notion Second Brain sync
area: town                           # an agent's own capabilities are its own area
sensitivity: personal
status: active
created: 2026-10-04
updated: 2026-10-04
by: town
sources: [town-routine:0000routine1111aaaa2222bbbb3333]
legacy: { notion: 00000000aaaa0000bbbb0000cccc0003, fact_key: "capability:vamprose:notion-second-brain-sync" }
facts:
  status:   { value: active, as_of: 2026-10-04, sources: [agent:town], verification: self-reported, by: town, recorded: 2026-10-04 }
  schedule: { value: daily, as_of: 2026-10-04, sources: [agent:town], verification: self-reported, by: town, recorded: 2026-10-04 }
  tools:
    items:
      - { value: notion, as_of: 2026-10-04, sources: [agent:town], verification: self-reported, by: town, recorded: 2026-10-04 }
      - { value: town-wiki, as_of: 2026-10-04, sources: [agent:town], verification: self-reported, by: town, recorded: 2026-10-04 }
      - { value: imessage, as_of: 2026-10-04, sources: [agent:town], verification: self-reported, by: town, recorded: 2026-10-04 }
---
Copies new or changed facts from Town's wiki (plus topic-level iMessage summaries) into the brain, and pulls new brain facts back into Town memory. Possible overlap: [[agents/instinct/notion-logging]].
```

Didn't fit: Notion's Agent capabilities uses a High/Medium/Low confidence scale; it maps to `verification: self-reported` because an agent describing itself can't verify itself. The `Agent` select says "Vamprose / Town" while `Author agent` says "Vamprose": aliases in `policy.yaml` solve this. **This capability will need rewriting once Notion is frozen**: its target moves from Notion to the brain's write path, and its writes must carry `source_ref` per fact so reruns are no-ops.

### 8.8 Money: savings room, unresolved (sensitive)

```markdown
---
id: money/savings-room
type: money
title: Savings contribution room
area: personal
sensitivity: private
status: active
created: 2026-10-04
updated: 2026-10-04
by: instinct
sources: [imsg:2026-09-29, imsg:2026-10-01]
legacy: { notion: 00000000aaaa0000bbbb0000cccc0006, fact_key: "instinct:money:2026-10-01-savings-room-unresolved" }
facts:
  room_remaining:
    dispute: c-0003
    candidates:
      - { value: "CAD [redacted in spec]", as_of: 2026-10-01, sources: [imsg:2026-10-01], verification: self-reported, confidence: inferred, by: instinct, recorded: 2026-10-04, note: "if the advisor figure is the Jan 1 tax-agency number" }
      - { value: "CAD [redacted in spec]", as_of: 2026-10-01, sources: [imsg:2026-10-01], verification: self-reported, confidence: inferred, by: instinct, recorded: 2026-10-04, note: "if it already nets contributions" }
---
The tax agency's online account is authoritative. Not confirmed that the requested transfer landed.[^m1]

[^m1]: imsg:2026-10-01
```

Didn't fit: the row is an **open question with two conditional answers**, not a fact. The format expresses it as a dispute whose candidates carry a `note` (added as an optional field), and because it is `private`, 0.6 says the resolver never decides it: it goes straight to Louis. The row's name embeds a date (`2026-10-01 savings room, unresolved`); dates and statuses come out of ids so the file survives being resolved.

### 8.9 Patterns across all rows

| Notion pattern | Where seen | Format answer |
|---|---|---|
| `Fact key` is per row and often agent-prefixed (`instinct:people:…`, `capability:vamprose:…`), in four different styles | every row | Keys derive from path + attribute; agent names are banned from ids (`no_agent_in_ids` check). Old keys kept in `legacy` for import idempotency. |
| One row holds many facts from several agents, sources in body text | 8.2, 8.4, 8.5 | Shelf-life facts to frontmatter, the rest to prose with footnotes. **Import can't be fully mechanical** (see 10). |
| `Valid from` = date the provenance columns were added (2026-10-04), not event time | every row with it | Importer ignores it for `as_of`; uses the source's date, else `Date` with `as_of_approx: true`. |
| `Date` means different things per row (logging date, meeting date, decision date) | 8.1, 8.5 | Not imported as a field; mapped case by case to `as_of`, `decided_on` or `last_contact`. |
| `Supersedes` empty on every row read | all | Expected: Notion appended inside rows instead. Fact history starts at import. |
| Gmail ids in two encodings (hex and `m1.<base64>`) | 8.2 vs 8.1 | Normalized to hex, so the same email can't count twice. |
| Source type wrong for the ref (`an email` for a calendar event; `a document` for a calendar event in the same row) | Lisbon trip row, 8.2 | Source type is dropped; the scheme in the ref is the type. |
| Fingerprint corrupted (literal `n` instead of newlines on the Lisbon trip row, 2026-10-08) | Lisbon trip row | Fingerprint is git history, never typed. |
| Confidence and Verification overlap (`Unverified` in both); capabilities use High/Medium/Low | all | `confidence` is only stated/inferred; `verification` carries the rest. |
| Rules written inside notes | 8.6 | Moved to `rules/`, Louis confirms. |
| Free-text links (`Related project`, `Org`) | 8.1, 8.5 | Wiki links to entity ids. |

## 9. What this forces in architecture.md 0.6

Sent to the "High-level architecture" thread, which accepted all eight and applied them to architecture.md 0.6 on 2026-10-08. None of these change a decision Louis made; they change how 0.6 is written down.

1. **`fact_key` is `<id>#<attribute>`, not `area:entity:attribute`.** Putting the area in the key means a key changes when an area changes, which breaks "stable key". The 0.6 example `people:01JA…:role` also uses a type (`people`), not an area. Area stays as a field and decides ownership only.
2. **0.6 says `fact_key` "reuses Notion's Fact key". It can't.** Notion keys are per row, not per attribute, and include the author agent, so Town and Instinct writing the same fact would get two keys. Old keys are kept as `legacy` for import only.
3. **Area owners are by field, not by folder.** `teaching/: town` becomes `areas: { teaching: { owner: town } }`, and changing a file's `area` is always a proposal to Louis (new check `area_change_needs_louis`).
4. **The standing-rule example contradicts "agent identity is never a factor".** "Town's wiki beats Instinct for Northfield schedules" ranks agents. Standing rules must name source classes ("registrar email > calendar > Town wiki"), which `rules/standing.yaml` enforces.
5. **Cardinality isn't enough; attributes need a merge rule.** `last_contact` needs `max` (an older date is a no-op, not a step-7 dispute), and logs need `append`. `checks.yaml` per-type settings become `merge / normalize / item_key / shelf_life`.
6. **Step 4 ("newer as_of supersedes") must not fire on estimated dates.** Most imported facts will have `as_of_approx: true` because Notion's dates were logging dates. An approximate `as_of` loses to an exact one at the same rank and can never trigger an automatic supersede against one.
7. **Prose can't carry freshness or sensitivity.** 0.1 already keeps notes as prose; 0.6's conflict steps therefore only ever apply to frontmatter facts. A contradiction inside prose is found by the upkeep loop and raised as a proposal, never auto-resolved.
8. **The resolver's conflict packet is the `disputes/c-NNNN.md` file**, which gives the short conflict id Instinct puts in its text to Louis a home on disk.

## 10. Hand-offs to the other open gaps

- **Bootstrapping:** the import is two passes. Pass 1 is mechanical: one file per row, frontmatter from columns, body copied, `legacy` set, everything `as_of_approx`. Pass 2 is a reviewed extraction of shelf-life facts out of the bodies (the Notion start page lists 27 rows that Town appended sections to). Pass 2 is where duplicates like 8.3 and errors like the Oct 5/Oct 6 date get caught.
- **Write quality:** the merge rules and the `write_hash` stop repeats; they don't stop noise. A candidate check for that thread: a fact needs a declared attribute or Louis's confirmation, and notes need at least one exact source.
- **Exit:** because ids are paths, links are `[[path]]`, and sources are plain strings, the brain opens as-is in Obsidian, Basic Memory and GBrain. A GBrain import would lose only the per-fact frontmatter semantics, not the data.
