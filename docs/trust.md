# Can you trust the brain?

"I want to trust the data" (owner, 2026-10-25). This page says what that means in numbers, where
you see them, and what the hub does about each one on its own. Everything here is deterministic:
no model is asked, and nothing printed carries a value, a title, a note id or an address.

## What counts

Every fact still in force on an active note lands in exactly one of three buckets:

| Bucket | When |
|---|---|
| **Needs a look** | Any of: the source it cites no longer says it, or is gone (the hub's recheck flagged it); it is stale past its shelf life; it was a guess (the writer said `inferred`, nothing stands behind it, or only another assistant's passing word); it looks private (someone else's health, school, legal or money matters, or money words and amounts on any note) and an assistant below private can read it. |
| **Checked against its source** | Not in the first bucket, and either it is your word (you confirmed it, or wrote it, on the dashboard, in a text or by accepting a proposal), or the hub itself read the item it cites and found the value there since the value was recorded (a `source-confirm` line in `log/writes.jsonl`). A `verified-by-source` label alone is a claim, not a check: assistants and imports can set it. |
| **Not checked yet** | The rest. Most of these have an exact source the hub can read and will, a few a night; some have only a vague pointer (a Notion import) or an assistant's word. |

Two more lines say why the third bucket is what it is:

- **No live source**, by reason: only a vague pointer, only an assistant's word, nothing at all, or a source gone or changed; and how many of them are worth searching your mail for (not private, with words to search by).
- **Assistants behind**: per assistant that has checked in with `memory_check`, how many facts changed since it last confirmed what it holds (docs/memory-sync.md). Counted without logging anything.

## Where you see it

- `pocketbrain audit trust [--json] [--check N]` prints the whole report, and last week's numbers beside it (one row a day in `log/trust.jsonl`). `--check N` first reads N cited items, the ones checked longest ago first, and checks every fact citing each against the item's own words (still said: confirmed today; not said or gone: needs a look, with the reason). The value never changes.
- The dashboard's Settings page, at the end of the memory line ("Your memory: 383 facts, 12 changed this week."): "9 need a look" (or "Nothing needs a look").
- The nightly pass logs the same line (`trust:` in the hub log), and the probe flags it if the step fails (`trust` job).

## What the hub does on its own

- **Recheck** (already nightly, docs/gardener.md): due and stale facts, and fresh single-source facts assistants read, are checked at their cited item, 20 items a night, plus 10 more checked for still existing.
- **Backfill, nightly** (docs/sources-pull.md "Backfilling sources"): for every Gmail source, up to 20 facts with no live source are searched for in your mail; a mail that states the value and names the note becomes its source. Value unchanged, nothing from the mail kept, never a private value searched. It used to run only when you typed `pocketbrain sources backfill`. It starts report-only (the night log says how many could get a source) until `pocketbrain backfill on`.
- Anything that needs a look waits under the Brain's "Needs a look" (Still true, Change); nothing asks about it. Only a conflict is asked, on the home.

## A cited message must be one the hub read

A mail or calendar ref (`gmail:`, `gmail-thread:`, `gcal:`) counts only once the hub itself has read that item: every source pull, `verify_source` call and recheck records what it read, or found missing, in `log/refs-checked.jsonl` (`pocketbrain refs --load <file.json>` adds a batch by hand). The check is always on (2026-10-25; before, it ran only when that file existed, and on a real hub it never did). A write that cites a ref found missing is refused; one that labels a ref the hub hasn't read yet `verified-by-source` can't replace a value the brain holds until the hub has read it, so it waits in the inbox. A new fact goes in either way. A calendar ref names one version of an event (`gcal:<id>@<version>`); only the version the hub read counts, so a made-up or old version stays unchecked. A `gmail-thread:` ref is never read by the hub, so it never counts as checked.

The same holds on the hub's own filing path (audit v3, 2026-10-26). Only your own accept skips the check; when the hub files a capture or decides a held one, it checks the refs like any other write. The check covers every kind of ref the hub reads: mail, calendar, texts, meeting notes, documents and chat. When a write is weighed against a value the brain holds, a ref the hub has never read counts as the writer's own word, not as an exact source. A made-up mail id therefore can't outrank anything.

`last_confirmed` moves only when a write brings new evidence the hub read at its source (a ref in `log/refs-checked.jsonl`) or the owner's word (a message in the owner's registry, or an accepted card), or when the hub finds the value at its source. An assistant repeating a value in its own word, or citing what the record already cites, leaves it where it was: fresh means checked, not repeated.

## A tap is an approval, not your word

Tapping Yes on a card (or `pocketbrain inbox --accept`) settles that proposal: the value replaces the one it was about, without a second card. It is recorded on the fact as `approved:<date>/inbox/<file>`, shown as "you approved", and the fact keeps the rank of the source it cites (owner's choice, 2026-10-25). Before, a tap made the fact the owner's own word, the top rank, so an assistant's claim you said yes to could never be corrected by a message or calendar item later, and the trust audit counted it as checked. Now a stronger or newer source replaces an approved value by the usual steps, and an approval alone leaves a fact "not checked yet". What you type yourself (a message to the brain, or a correction) is still your word. Only the hub writes an `approved:` ref: an assistant citing one is refused (`approved_ref`). A proposal that claimed your word without citing your message loses that claim when you approve it. An address you approved on a card still counts as trusted for Same person?, standing and knowing who sent a mail. A proposal file, a journal line or a Notion import never brings an `approved:` ref of its own. Past its shelf life, an approved fact is put to sleep like any assistant's fact rather than asked about again (only your own word gets a "still true?" review). Taps from before this change were saved as your word (`owner:<date>/inbox/<file>`); when the hub starts, each becomes an `approved:` ref with the proposal's own verification, in one hub commit with a why (`rankOldTaps` in `src/write.ts`, G433). A fact that also cites your own word, a message of yours or your answer to a conflict, stays your word.
