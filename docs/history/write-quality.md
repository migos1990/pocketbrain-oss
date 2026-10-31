# pocketBrain: write quality

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

> Status: all four questions in section 8 decided by Louis on 2026-10-08. Written from the "Write quality" thread. Builds on [architecture.md](architecture.md) section 0 (agreed v1), especially 0.6 (rules, owners, idempotency, conflicts). Nothing here changes those decisions; it fills the gap they leave: **what stops agents filling the brain with noise, so upkeep isn't just cleanup.**

## 0. The short version

Most noise in the Notion brain isn't agents being careless. It's agents writing **episodes** (what happened in a chat today) into a place built for **facts** (what is true and will be needed again), because there is nowhere else to put them. A hard gate on "is this worth remembering" would mostly stop them writing at all.

So v1 does three things, in this order:

1. **Give episodes their own place.** Each agent gets a `journal/<agent>/` area that is cheap to write, never compiled into other agents' views, and expires. The brain proper (`people/`, `projects/`, `decisions/`, `money/`, `notes/`) only takes things that pass the worth-it test in section 2.
2. **Check the shape, not the judgement.** A write is accepted if it has the minimum fields in section 3 and those fields are *checkably real* (a source that looks like a Gmail id, a calendar id, a `phonemsg-` id or a URL, and a source type that matches it). No LLM decides worth on the write path.
3. **Overflow goes to `inbox/`, never to the floor.** Budgets in section 4 are soft: past the line, writes become proposals instead of being refused. The only hard refusals are secrets, rules-folder writes, malformed writes and oversize appends.

The instruction block in section 5 can be pasted into each assistant **in Phase 0, this week**, before any code exists.

---

## 1. What the Notion brain actually shows

Read through the Notion MCP on 2026-10-08 (start page, Agent comms, and a sample of rows in People, Projects and Research and notes). The SQL query quota hit `usage_limit_reached` again, so this is a sample by page fetch, not a full census.

| # | Pattern | Real example | Why it's noise | What fixes it |
|---|---|---|---|---|
| N1 | **Running log in one row** | *Text conversation topics (Vamprose)*: one Research row, 25 dated chat summaries, 22 fingerprint lines in 5 days, still growing | Nobody will query it; every agent that reads the view pays for all of it; one `Review after` date for 25 unrelated items | Episodes go to `journal/`; size cap on appends (N1 → section 4) |
| N2 | **Echo of agent chatter** | Same log records Louis's chats *with Instinct* (Gmail cleanup, flight tracking, AgentMail setup), written by Town | Instinct already knows these; Town copying them makes a second, weaker copy with Town as author | "Don't record another agent's conversation; that agent owns it" (section 5) |
| N3 | **Ephemeral detail** | "Boarding began as scheduled"; live flight altitude and heading; "meet around 11:00 for coffee" | True for hours, useless after; adds read cost forever | Worth-it test, question 2 (section 2) |
| N4 | **"Nothing happened" entries** | "No reply from Louis yet in this window", "No further detail shared", "No new action items noted" | Records an absence; can't be used, can go stale | Instruction: don't write absences; a pending item is a `next_step` fact on a project or nothing |
| N5 | **Source type laundering** | *Robin Castell*: Source type "a text received from Louis", Source "Instinct memory note entities/people/robin-brightpath" | An agent's own memory is presented as Louis's word, which is the top precedence rank in 0.6 step 5. This is the most dangerous pattern because conflict resolution trusts it | Source type must match the reference's shape (check `source_matches_type`, section 3) |
| N6 | **Vague sources** | "Vamprose knowledge wiki", "contact record, Gmail" (Instinct's 2026-10-04 fix-up request lists 27 affected rows) | Unrecheckable, so upkeep can never verify or retire it | Source must be a resolvable reference or `observation` (section 3) |
| N7 | **Wiki dumps / syntheses** | *Louis profile overview (Vamprose wiki)*: a synthesis whose Source is "UNVERIFIED synthesis … no single exact reference" | Restates facts that already live on sourced rows; when one changes, the summary silently goes stale | Summaries are views, not writes: compiled at build time from facts, never stored |
| N8 | **Third-party sensitive detail** | A third party's sensitive school request; an unidentified contact's phone number and travel; a flight booking reference | High exposure, low reuse; ends up in other vendors' context windows | `third_party_sensitive` check and the "never" list (section 2) |
| N9 | **Duplicates** | Muse's 6 duplicate Agent capabilities rows (2026-10-04) | Same thing twice | Already covered: `fact_key` + entity resolution (0.6). Listed here for completeness |
| N10 | **Burst posting** | Muse posted 7 proposals in Agent comms within the same minute (15:38 EDT, 2026-10-07) | Fine content, but a burst like this is what a looping agent looks like too | Burst budget (section 4), overflow to inbox |
| N11 | **Mangled writes** | Literal `n- ` and `nVamprose` where newlines were lost in Lisbon trip and Text topics rows | Breaks parsing, looks like content | Schema/format check: Markdown must round-trip; refuse control-character junk |
| N12 | **Three fact key formats** | `note:text-conversation-topics`, `project:lisbon-trip-2026-10`, `instinct\:people\:robin-castell` | Keys that don't match can't dedupe | One format, `<id>#<attribute>`, derived not typed (0.6, memory-shape.md) |
| N13 | **Provenance bloat inside the content** | Fingerprint columns with 20+ lines; "Added by Vamprose (date)" blocks inside page bodies | Audit trail mixed into the fact, paid for on every read | Fingerprint lives in git history, not the file. Views strip it |

**What the sample also shows that's good**, and must not be lost: the Lisbon trip row is well sourced (Gmail ref, calendar event id, quoted text), Town re-checks its claims against a live source ("checked against Town's live routine list today"), and agents already label unverified material honestly. The rules work when there's a place for each kind of thing; the noise clusters where there isn't.

---

## 2. What counts as worth remembering

### The test

A write belongs in the brain (not the journal) if **all three** are yes:

1. **Reuse:** would Louis or *another* agent act differently in a future conversation if it knew this?
2. **Shelf life:** will it still be true, or still matter, in two weeks? (If it has a shelf life shorter than that, it's a `next_step` or a calendar entry, not a fact.)
3. **Not already somewhere better:** is this the first or best copy? A fact that lives in Gmail or the calendar is worth storing only as a *pointer plus the decision or relationship it implies*, not as a transcription.

This is guidance in `rules/RULES.md`, not an enforced check. It can't be checked mechanically, and an LLM judge on the write path was dropped from v1 for good reasons (architecture 0.3). It's enforced *indirectly* by where things land (section 3) and by the read-based cleanup in section 6.

### Where each kind of write goes

| Kind | Examples | Goes to | In other agents' views? |
|---|---|---|---|
| **Durable fact** (shelf-life type) | a person's role and org, a project's owner and next step, a recurring bill, a schedule | `people/`, `projects/`, `money/` as `facts:` keys (0.1) | Yes, with freshness |
| **Decision** | "Declined Initech offer, 2026-09-22", "Signing bonus treated as cash" | `decisions/` | Yes |
| **Preference or standing rule from Louis** | "'approved' is the one-word trigger for Instinct", "drafts only, never send" | `notes/louis/` as facts, source = his message id | Yes |
| **Relationship context** | how Louis knows someone, what they last discussed *if it changes what to do next* | the person's file, one dated line in a `context:` list, newest 5 kept | Yes |
| **Episode** | "talked to X about Y today", flight progress, a coffee plan, a chat summary | `journal/<agent>/YYYY-MM.md` | **No.** Only the author and Louis see it |
| **Synthesis / profile** | "Louis profile overview" | not written; compiled into the top of each view at build time from facts | Yes, as part of the view |
| **Coordination** | proposals, requests between agents | `comms/` (0.1), with its own retention | Per policy |

The journal is the release valve. It costs nothing to write, it keeps the agent's own continuity (which is what Town's text log is really for), and **upkeep can promote** a journal line into a fact when it sees the same thing twice or when it matches the worth-it test plainly (a new role, a decision). Promotion goes through the normal write path, so it's sourced and deduped.

Retention (decided by Louis, 2026-10-08): journal files older than **60 days** are moved to `archive/journal/` by upkeep (still in git, out of every view). Louis can say "keep" on any line, which promotes it.

### Never stored (enforced where checkable)

- Secrets: passwords, API keys (including `sk-ant-`, `sk-proj-` and `github_pat_` keys), private keys (PEM blocks, age keys), access tokens (pocketBrain agent tokens, JWTs), card numbers, SINs/SSNs, PINs and door, alarm or gate codes (also written as `PIN 4821`, `password - …` or `code de la porte 4821`), recovery codes, full account numbers, booking or confirmation codes. *(Check: `no_secret_shapes`. What it knowingly lets through, such as `pw: …` or a bare 40-character secret, is a table in `test/ceilings.test.ts`.)*
- Northfield student information; Civic Aid SharePoint content. *(Existing rules; checkable only by path/area and keyword, so mostly guidance.)*
- **Third parties' health, education, legal or financial situation**, and anything about minors beyond a name and relationship. *(Check: `third_party_sensitive`, keyword-based, sends to `inbox/` rather than refusing, because false positives are likely.)*
- Unidentified people by phone number alone.
- Another agent's conversation with Louis (that agent records it in its own journal if at all).

---

## 3. Minimum fields for a write to be accepted

### Every write

| Field | Rule | Check name |
|---|---|---|
| `kind` | one of `fact`, `decision`, `note`, `journal`, `comms` | `schema_valid` |
| `area` | an area the policy knows; own area → direct, other area → `inbox/` | `own_area` (0.6) |
| `source_type` | one of: `louis_message`, `email`, `calendar`, `document`, `web`, `call`, `agent_observation`, `import` | `schema_valid` |
| `source_ref` | **resolvable** for every type except `agent_observation`: `phonemsg-…` id, Gmail message/thread id, calendar event id, URL, file path, or a `call:YYYY-MM-DD:with` stub | `source_resolvable` |
| `source_type` ↔ `source_ref` | the ref's shape must match the type: a `louis_message` needs a `phonemsg-` id (or another channel id Louis uses); an `email` needs a Gmail id (`gmail:<id>`, or `gmail:<account>/<id>` from a pulled mailbox) or a pulled `mail:` ref; a `document` may cite a pulled text, Discord, Granola, Slack, Drive or Zoom ref; a ref that names an agent's memory must be `agent_observation` | **`source_matches_type`** (new, fixes N5) |
| author | stamped by the write path from the agent's identity, never typed | (0.5) |

`agent_observation` is allowed on purpose (see 6.1). It is forced to `verification: self_reported`, ranks *below* every other source in conflict resolution, and is shown as such in views.

### Facts (shelf-life types: person role/org, money, schedules, project next step)

As in 0.1 `facts: { key: { value, as_of, source, verification } }`, plus:

| Field | Rule |
|---|---|
| `fact_key` | `<id>#<attribute>`, derived from the file path, never typed (architecture 0.6 and [memory-shape.md](memory-shape.md)); entity resolution before create |
| `as_of` | **required**: when it became true (event time), not when written. Copies inherit the original's `as_of` |
| `review_after` | optional; defaults by type from `checks.yaml` (e.g. role 180 days, next step 14 days, bill amount 30 days) |

### Decisions

`decision`, `date`, `source` (must be `louis_message` or a document he signed off). An agent's *recommendation* is not a decision; it goes to `comms/` or the journal.

### Notes

Title, body, `source`. Size cap: a note over **8 KB** or a write that appends a **sixth dated entry** to a list-shaped note is refused with "split into journal or a new note". This is what stops N1 at the door, and it's the one hard size gate.

### Journal

Only `kind: journal`, date, and a one-line source. No `fact_key`, no `facts:`. Never compiled into other views, so the bar is low on purpose.

### What a refusal looks like

Every refusal or inbox diversion returns the check name and a one-line fix ("`source_matches_type`: ref `entities/people/…` is your own memory; use `agent_observation` or cite the email"). Agents fix and retry; the idempotency keys (0.6) make the retry safe.

---

## 4. Budgets and rate limits

**Challenge first:** the brain is about 67 rows and four agents write irregularly. A plain per-agent rate limit would mostly bite on the good days (Town importing a week of email after a trip) and teach agents that writing fails. Rate limits only earn their place against two things: **runaway loops** and **one note swallowing the view**. So:

| Budget | Default (per agent) | Past the line | Why |
|---|---|---|---|
| No-op writes (same key, same value) | **unlimited, free** | n/a | They only refresh `last_confirmed`; punishing them punishes re-checking |
| New `fact_key`s created per day, own area | core: **25**; trial: **5** | further writes go to `inbox/` as proposals, not refused | Bounds growth without stopping work; Louis sees a "Town created 40 new facts" line in the digest |
| Writes per minute (any kind) | **10** | the rest queue to `inbox/`; a burst of 3× in a row pauses the agent's writes and pings Louis | Catches loops (N10 pattern, but harmful) |
| Appends to one note | **5 dated entries**, **8 KB** | refused with "split" (section 3) | Stops running logs (N1) |
| Journal | **unlimited** | n/a | It's the release valve; size is handled by retention |
| `comms/` posts | **10/day** | rest to `inbox/` | Keeps the log readable without blocking a real proposal |

All numbers live in `rules/checks.yaml`; only Louis changes them. Trial agents (Muse today) are propose-only anyway (0.6), so their budget mainly limits how much lands in Louis's inbox.

**No token or byte budget on the whole brain.** When a view nears 50k tokens, that is the existing trigger for FTS5 (0.1), and the read-based cleanup in section 6 is the real pressure valve.

---

## 5. What each agent's instructions should say

Part of the per-vendor instruction block (0.1, [18]). Same core for every agent; the last part differs. Written to work **now, in Phase 0** (pasted views, write-backs logged by hand), and unchanged when the write path exists.

```
## Writing to pocketBrain

Before you write, ask: would Louis or another agent act differently next
month if they knew this? If not, put it in your journal, or don't write it.

Write a FACT when something durable changes: a person's role or org, a
project's owner or next step, a money amount or due date, a schedule.
One fact per key. Say when it became true (as_of) and cite the exact source:
the phonemsg id, Gmail id, calendar event id, or URL.

Write a DECISION only when Louis decided something. Cite his message id.
Your recommendation is not a decision.

Everything else that happened (a chat, a trip update, a coffee plan, a
summary of a conversation) goes in your journal, one line, dated. Your
journal is yours; other agents don't see it.

Never write:
- secrets, booking codes, account numbers;
- someone else's health, school, legal or money situation, or details about
  children beyond name and relationship;
- another agent's conversation with Louis (it records its own);
- "nothing happened" entries ("no reply yet", "no further detail");
- summaries of facts that already exist (views build those);
- Northfield student information or Civic Aid SharePoint content.

Sources: say where it actually came from. If it came from your own memory
or inference, the source type is agent_observation, even if Louis told you
originally and you no longer have the message id.

If a write is refused, the reply names the rule and the fix. Fix and retry.
If it went to the inbox, that's fine; Louis or the area owner will decide.
```

Per-agent addition (examples, to be confirmed against `policy.yaml`):

- **Town:** "Your areas are `teaching/` and `volunteer/`. Your daily sync imports from your wiki and Gmail: one source, one fact; re-importing the same source is a no-op, so don't worry about re-running it. Your text-conversation topics belong in your journal, not in `notes/`."
- **Instinct:** "Your area is `personal/`. You are the resolver (0.6): when you settle a dispute, cite the evidence that settled it."
- **Muse (trial):** "Everything you write is a proposal. Batch related proposals into one `comms/` post rather than one post each."

---

## 6. Challenges: gates I rejected or softened

### 6.1 "No source, no fact" (the current Notion rule) → kept, with an escape hatch (decided by Louis, 2026-10-08)
Taken literally, it blocks the most useful thing an agent learns: Louis's preferences and habits observed over many chats, which have no single message id. Today that pressure is exactly what produces N5 (agents mislabel their memory as "a text from Louis" to satisfy the rule). **Fix:** `agent_observation` is a legal source type, honestly labeled, ranked lowest, and shown as self-reported. The rule becomes "no *false* source", which is checkable, instead of "no source", which agents route around.

### 6.2 A "worth remembering" classifier on the write path → rejected
An LLM judging each write would be the LLM auditor that v1 dropped, would silently lose good writes, and agents can't fix a refusal they can't understand. Worth is handled by **where things land** (journal vs brain), **size caps**, and **read-based cleanup** (6.6), all deterministic.

### 6.3 Hard rate limits that refuse → softened to overflow
Refusals teach agents to stop writing. Overflow to `inbox/` keeps the write and shows Louis the volume. The only hard stops: secrets, `rules/` writes, malformed writes, oversize appends, and the loop circuit-breaker (3 consecutive bursts).

### 6.4 Requiring `facts:` keys on every note → kept as v1 decided (shelf-life types only)
Agreed in 0.1, restated because write-quality pressure will push to extend it. Requiring structured keys on prose notes makes agents stop writing notes. Don't.

### 6.5 Near-duplicate blocking (similarity) → rejected for the write path
Exact `fact_key` dedupe plus entity resolution (0.6) catches real duplicates. Similarity matching would block legitimate updates ("CTO" vs "VP" looks similar) and needs embeddings v1 doesn't have. Upkeep can flag near-duplicates for Louis in the digest instead.

### 6.6 What I'm proposing instead of more gates: cleanup driven by reads
The hash-chained read log already exists in v1 (0.1 Safety). Use it: **a non-shelf-life note that no agent has read in 90 days** goes to an "archive?" list in the weekly digest; one tap archives it (git move, reversible). Shelf-life facts are handled by freshness instead. This is the measure that actually matters: noise is what nobody reads, and the brain learns that from use, not from a gate guessing at write time.

### 6.7 The third-party sensitivity check → inbox, not refuse
Keyword detection of health/school/legal topics about other people will have false positives ("Emma's teacher" in a scheduling fact). Sending to `inbox/` keeps the write and asks Louis once; a refusal would push agents to reword around it.

---

## 7. How to know it's working

Add five numbers to the daily or weekly digest (cheap, all from git and the read log):

| Metric | Healthy | Says what |
|---|---|---|
| Share of writes that were no-ops | rising over time | agents re-confirm instead of duplicating |
| Writes diverted to inbox / refused, by check name | low and falling | which rule agents keep tripping (fix the instruction, or the rule) |
| `agent_observation` share of new facts | stable, under ~30% | if it climbs, agents are guessing; if it's zero, they're laundering (N5) |
| Notes not read in 90 days | small | the actual noise level |
| Journal lines promoted to facts | non-zero | the journal is feeding the brain, not just absorbing it |

**Phase 0 version (no code):** during the zero-code week, add one column to Louis's log: "write-backs the agent wanted, and would it pass section 2's test?" That tells us whether the journal split matches reality before we build it.

---

## 8. For Louis (each answerable in a word)

1. ~~**Town's text-conversation log**: move it to Town's private journal?~~ **Decided (Louis, 2026-10-08): journal.** Town stops writing it to shared notes; the import moves the existing Notion row into `journal/town/`.
2. ~~**Third parties' sensitive details**: keep out of the brain entirely?~~ **Decided (Louis, 2026-10-08): keep out.** Writes that look like they contain them go to `inbox/` (6.7).
3. ~~**Agent observations as a source** (6.1): allow, labeled and ranked lowest?~~ **Decided (Louis, 2026-10-08): allow**, as `agent_observation`, self-reported, ranked lowest.
4. ~~**Journal retention**: 60 days, then archive?~~ **Decided (Louis, 2026-10-08): 60 days**, then upkeep moves entries to `archive/journal/`.
