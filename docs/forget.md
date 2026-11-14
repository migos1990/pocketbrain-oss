# Forget a person

Hiding someone from an assistant is a slice change. Some people ask for more: a friend, a former student, a relative whose health or school details ended up in your notes may ask you to take them out. `pocketbrain forget` does that, on your word only, with a short undo.

```
pocketbrain forget people/jane-roy          # shows what would go; changes nothing
pocketbrain forget people/jane-roy --yes    # does it
pocketbrain forget --undo people/jane-roy   # within 14 days: puts all of it back
```

## What goes

One commit, made as you (`Kind: owner-edit`, `Forgot-Person: <id>`), removes (only your own commits' `Forgot-Person:` and `Undid-Forget:` lines count, so an assistant's commit message can't hold or free a name, G602):

- **Their note.** From the next request no assistant can read, search or be handed it; it answers like a note that never existed. The cells rebuild on the new commit.
- **Every link to them**, label or anchor included (`[[people/jane-roy|Jane]]`, `[[people/jane-roy#emails]]`), in note bodies and fact values. Each becomes `[[redacted]]`, which is what assistants already see for a note outside their view. A note for someone whose id only starts the same (`people/jane-roy-2`) is left alone.
- **Their standing** in `rules/standing.yaml`.
- **Inbox items naming them**: pending and decided proposals under `inbox/`, by id or by a name that resolves to them (a capture that made their page by name, G601). The hub never makes their page again from an older forget's leftovers: at its start it doesn't put back a capture for a new page whose id you forgot, and filing waits for you on a new-page proposal by that name.
- **Settled disputes about their facts** (`disputes/*` whose fact key is theirs). A fact of theirs still in dispute stops the forget: settle it first.

And, outside git:

- **Their standing signals:** a dismissed suggestion, and the mail and text counts for their addresses (`log/standing/`). An address another person note also holds is kept.
- **Views:** every file under `views/` naming them, dated snapshots included, is deleted, and the current views are built again.
- **The restart cache:** `.cells/parse.json` drops every version of their note: the brain's own copies, each agent cell's copy, and any cached entry holding their id or one of their addresses. The dropped hashes are listed in `.cells/parse.drop`. Every process honours that file when it loads or saves the cache, so a running hub doesn't write them back.
- **Semantic search's vectors** (`~/.cache/pocketbrain/vectors/`, docs/semantic-search.md): the vectors of their note, and of every note whose link to them became `[[redacted]]`, are deleted on disk at once, whether semantic search is on or off. A hub that was running keeps a copy in memory only until its next background pass; `forget --undo` deletes the vectors of the redacted versions in turn.
- **Ask chats that name them** (your own chats on the Ask tab, kept beside the brain's git and never committed): each chat that names them by name, page id or address is deleted whole, and the command says how many. Nothing keeps a copy, so `--undo` does not bring a chat back, and says so (G763).
- **Read-only tokens' cells** (`.cells/.edge-reader/`, read by the hub and sealed for the edge). Bundles you already published with `pocketbrain edge publish` still hold them until you publish again; when any agent is enrolled for the edge, the command says so.

A person who was merged into, or replaced, them (`merged_into`, `superseded_by`) stops the forget. Undo that merge first, or forget that note too.

## What stays, and is said

The command lists the files it doesn't edit that still name them, by id, title or address:

- **Other notes that name them in plain text.** The plan shows these before you add `--yes`. A forget rewrites links, not prose: edit those notes yourself, since assistants that see them can still read the name or address. Someone else with the same name shows up in this list too.
- **The hash-chained logs** (`log/reads.jsonl`, `log/writes.jsonl` and their archive). Editing a line would break the chain that shows tampering.
- **Assistants' journals** and logs, relayed mail (`comms/`), handoffs and digests. These are other people's lines; edit them by hand if they must go.
- **Git history and backups made before the forget.** Restoring an older backup brings the person back. The command says so every time.

## Undo, for 14 days

`pocketbrain forget --undo <id>` reverts the forget's commit (note, links, standing, inbox, disputes) and puts back the local traces it kept in `.git/pb-forget/` (never committed, never in a backup).

Dated view snapshots from before the forget aren't brought back; the current views are built again.

It is refused when:

- a later edit touched the same lines (nothing is changed, and it says which commit to revert by hand);
- the note exists again;
- the forget is more than 14 days old.

After 14 days, the night's housekeeping deletes what the forget kept for its undo.

Owner only. On a replica, `forget` refuses before changing anything, so run it on the hub. The dashboard's "Forget" on a note page is the lighter tool: it removes the note file only, and its Bring back restores it.
