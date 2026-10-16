# Where a fact came from

Every fact in the brain cites its sources and keeps its earlier values, and the hub logs every write. `why` puts that together for one fact, so you or an assistant can see where a value came from, which source backs it and how strong that source is, before relying on it.

## For you

```
pocketbrain why people/jane-roy#role          # plain text
pocketbrain why people/jane-roy#role --json
```

On the dashboard, every fact on a note page has a **Where from** link (`/why/<note>?fact=<attribute>`).

You see everything:

- **Now:** the current value (every item of a list, both answers of a dispute), how strong its backing is, the date it holds from, who added it and when, when a source check last confirmed it, and each cited source.
- **Before:** earlier values from the note's history and ended list items, with when they ended.
- **Writes:** every write the hub logged on that fact (`log/writes.jsonl`): who, with which token kind, and the outcome: committed, inbox, disputed, refused or held, the conflict step that decided it and the checks it failed.

The strength is the same ranking the write path and disputes use (`sourceRank` in `src/sources.ts`), in words: the owner's word, checked at its source, an exact source, a vague source, inferred, relayed by another assistant, or no backing source.

## For an assistant

The `why` tool (MCP) and `GET /v1/why?key=<note id>#<attribute>` give an assistant the same answer for a fact in its own view, and nothing beyond what its read already shows:

- A fact it can't see (its note is outside its slice, the attribute is cut, the fact is above its level or shared with others only) answers exactly like one that doesn't exist: `no fact … in your view`.
- No earlier values: an assistant's read never shows history (a cell holds none), so `why` doesn't either.
- Only its own writes from the log (a proposal the owner later accepts is logged under its name, so it can see `inbox` then `committed`). Who else wrote the fact, how often and when, how a dispute went and what checks their writes met are not in its read, so they aren't here.
- On the records, other assistants are named "another assistant". Its own name and the owner's stay.
- A value or source holding a word it only sees as `[withheld]` shows `[withheld]` here too.
- A dispute says the fact is in dispute, without the dispute's id (its read of the note names it).
- Each call is logged in the read log (`op: why`) like any read.

`why` is a hub tool: the sealed edge (docs/edge.md) has no write log, so there it answers that it needs the hub.

## Where it lives

`src/why.ts` builds the answer; `core.why` (agents) and `core.ownerWhy` (the CLI and dashboard) pick the caller's view.
