# The decision deck (removed)

The deck, its cards (Still the plan?, Past its date?, Does this replace?, proposal groups), the spot check, Ask and the "N to decide" count were removed after outside review v5: the owner keeps the home (`/home`), a page (`/p/<id>`) and the settle screen (`/settle/<id>`), and is asked only about conflicts.

What stayed moved:

- The hub's own filing (a capture's or source's fact files itself with Undo, a contradiction is filed as a conflict, an outside assistant's unanswered proposal expires) and "Conflicts wait for the Gardener": [filing.md](filing.md), code in `src/filing.ts` and `src/gardener-hold.ts`.
- Conflicts: [owner-home.md](owner-home.md) (`ownerConflicts`, `inboxConflicts`).
- A past date is an upkeep `past-date` finding; a stale fact stays under the Brain's "Needs a look".
- No assistant may be named `auto-decide` or `hub`: those names mark the hub's own commits (G426, `src/rules.ts`).

The design as it was is in git history.
