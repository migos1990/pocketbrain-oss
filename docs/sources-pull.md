# Source pulls

The brain stays current by reading the places the owner already works in: Gmail labels, calendars, Drive docs and Discord channels (Slack and Zoom work the same way for owners who use them). Agents still write what they learn. The pull fills the gaps when they don't, and it catches facts that went stale. The design and its reasoning are in the project's sources-pull note. This page covers what the code does (`src/pull.ts`).

## Facts, not copies

pocketBrain is a portable memory layer, not a mirror of the owner's mailbox or chats. A pulled item's text is held in memory only while its facts are extracted. Secrets are blanked first, and an item that looks like an injection is refused with a `source_held` alert, so nothing is sent to a model. The brain keeps:

- the facts, in its plain Markdown notes, each citing the item's ref;
- a capture record in `inbox/captures/` with the ref and what came of it, but not the text, the subject or title, or the value of any candidate that didn't become a proposal (dropped ones are listed by status, type and attribute);
- proposals that name the fact and its ref.

The few words a proposal was drawn from (at most 200 characters) help the owner keep or drop it, so
they wait beside the open proposal, outside git (`.git/pb-quotes/`, code: `src/quotes.ts`), and show
on the owner's text and card only. They are deleted when the proposal is decided. The proposal
file, its decided copy, commits, the digest and the model log (`log/judgments.jsonl` keeps the
extracted facts, never their quotes) don't hold them; a source check of an agent's link keeps only
its verdict and ref in the proposal, never the sentence (G98). A brain that isn't a git repo keeps
them in `.pb-quotes/`, which ignores itself, and `undo --run` stages only what it reverts (G94).
Once Instinct has sent a text, a text was replaced, or every item it asked about was decided, its
words are cleared from `textline/outbox/` and it is no longer served (G95).

Proposals made before quotes moved out of git kept them at the end of their reason. The digest
moves each open one's quote beside it and strips the quote from open and decided proposal files,
in one hub commit (G97). Git history still holds those older lines; only a history scrub, the
owner's call, removes them.

The text stays in the source. `verify_source` reads it there, one item at a time, when a claim needs checking. If no extraction model is available, the item is not stored. It waits in the source's state and is tried again on the next pass.

## The rule: the hub pulls, the gardener tends

- **The hub** reads each listed source on its own schedule and feeds new or changed items through the capture path. Secrets are blanked, injection shapes are held, and limits apply. Then a model extracts the facts and code checks them. Every fact the pull changes (a source added, a fact turned due) gets its hash-chained line in `log/writes.jsonl`, agent `hub`.
- **The gardener** has no connector to any source. At night it works on what the pull left: facts marked due, and proposals that clash.
- **The owner** approves proposals in the digest or the dashboard. Nothing else needs them.

## rules/sources.yaml (owner only)

```yaml
consent: 2026-10-12          # the day the owner agreed (YYYY-MM-DD, on or before today); without it only fixtures run
poll_minutes: 15             # how often `start` pulls (default 15)
sources:
  mail:
    kind: gmail              # gmail | gcal | gdoc | zoom | slack
    where: [Label_school]    # allowlist: labels, calendars, folders, meeting series, channels
    area: work               # where new notes from this source land
    max_per_day: 30          # items read per day (default 30), counted across the day; the rest waits for the next day
  work-mail:                  # one source per mailbox: each has its own allowlist, cursor and grant
    kind: mail               # gmail | mail (IMAP, Outlook, iCloud: keyed by Message-ID)
    account: work            # named in refs: mail:work/<message-id>, gmail:<account>/<id>
    where: [INBOX]
  texts:
    kind: imessage           # iMessage/SMS from ~/Library/Messages/chat.db, read only, never leaves the Mac except to extraction
    where: ["+15145550123", "chat123456789012345678"]  # handles or chat_identifiers, never display names
    # private by default: texts are mostly other people's words
  talks:
    kind: granola            # recorded conversations; Granola's local cache on the Mac, read only
    every_minutes: 1440      # low volume: once a day
    # private by default, like texts
  team-discord:
    kind: discord            # read only: the hub never posts
    where: ["#dev", "#product"]  # only these channels
    silent_after_hours: 168  # quiet channels: a week of nothing before the probe calls it silent (default 72; 0: never)
    area: side-project
  meetings:
    kind: zoom
    min_sensitivity: private # Zoom defaults to private: transcripts are mostly other people's words
  cal:
    kind: gcal
    fixture: cal.json        # a JSON file in the source's own shape (tests, dry runs)
```

Only the items listed under `where:` are read. Messages under four words ("ok", "thanks!") are never sent to the model.

The `consent:` line is the day the owner agreed, as an ISO date (`2026-10-12`, optionally followed by a note such as `2026-10-12 by text`). A value that isn't a date (`no`, `pending`) or a date after today is not consent: live sources stay off and the pull says why in a `source_failed` alert.

`max_per_day` counts items stored per source per calendar day, across every pass of that day (the count and its day are kept in `log/sources/<name>.json`). An item past the cap is not marked seen: it waits, untouched, and is read on a later day. While anything waits, the source's own cursor stays where it was, so a live source returns the item again.

If extracting one item fails (the model's answer is unusable, or anything throws), that item is counted as failed in the pass and the rest of the pass goes on; the state is saved. The item is tried again on the next passes, at most 3 times in all, then skipped with a `source_item_failed` alert to the owner.

### Forwarded mail

A mailbox that auto-forwards into another needs no connector of its own. The receiving source lists it under `forwarded:`, matched on the addresses the mail was delivered to: `Delivered-To` and `X-Forwarded-For`, which Gmail adds on receipt and on forwarding. `To` and `X-Forwarded-To` are written by the sender and never pick a rule. Each address is compared whole: `@school.example` matches that domain exactly (not `school.example.evil.test`), and a full address matches only itself:

```yaml
  mail:
    kind: gmail
    account: primary
    forwarded:
      - { to: "@school.example", account: school, area: school, min_sensitivity: private }
```

A matching item keeps the receiving ref (`gmail:primary/<id>`), and its capture and proposals record `forwarded_from: school`. Its facts land in that rule's area, at the higher of the two sensitivity floors. When several rules match, the one with the highest floor wins, so a header can never lower an item's floor.

## What happens to each item

| The model finds | The pull does |
|---|---|
| A value the brain already holds | If every word of the value is in the item (whole words) and the item, its channel, thread or subject names who or what the fact is about, adds the source to that fact (replacing an older version of the same item) and sets `last_confirmed`, committed as `hub`. It never raises `verification` and never clears a `recheck`: those stay the owner's. No proposal. |
| A new or different value | An inbox proposal citing the exact source, at the source's sensitivity floor or higher. Its `source_type` follows the ref: `email` for Gmail and mail, `calendar` for Google Calendar, `document` for the other sources. The usual conflict order applies when it is accepted (an item older than the fact it changes becomes a dispute). At most `capture.max_proposals` (default 10) per item; the rest are listed as over the cap. If the same value is already waiting in `inbox/` from another pulled item, that proposal gains this item's ref instead of a new one. If it waits from another kind of source or another agent, this item gets its own proposal, and the owner sees both as one card (docs/capture.md, One card per fact). |
| Nothing it can ground in the text | Nothing. The capture file records why. |

Refs carry the source's version: `slack:<team>/<channel>/<ts>@<edited ts>`, `gcal:<event>@<etag>`, `gdoc:<file>@<revision>`, `zoom:<meeting>@1`, `discord:<channel>/<message>@<edited time or 1>`, `gmail:<id>` or `gmail:<account>/<id>`, and `mail:<account>/<message-id>`, `imessage:<guid>@<edit time or 1>`, `granola:<note id>@<updated time>` (emails never change, so they carry no version). All rank as `exact` sources.

## When a source moves

On every pass the hub compares each item's version with the one it saw last (`log/sources/<name>.json`). An edited, deleted or cancelled item turns every fact citing the old version **due**: `review_after` is set to today, and `recheck: { why: "source changed" | "source gone", ref, at }` says why. No model decides this. The value stays as it is, and the fact shows as due in reads and in "Needs a look" until the owner decides. A later pull that repeats the value adds its source but doesn't clear the recheck.

## The gardener checks claims through the hub

The gardener has no mailbox, calendar or search. When a fact rests only on a link an agent cited (`gmail:<id>`, `gcal:<id>`), the gardener calls `verify_source` (MCP) or `POST /v1/gardener/verify` with the ref and the claim. The hub answers only for a ref that a fact in the gardener's own view cites, so the tool can't be used to read the mailbox. It reads that one item through the same allowlist and answers:

- `match` or `no-match`, with a sentence of the item (at most 200 characters, secrets blanked). The sentence can be the subject line, and it is text a model reads, so it is checked for injection shapes (`findInjection`) whole, before it is cut. One that reads as instructions is never returned: the verdict still comes back, the `why` says "quote withheld: reads as instructions (…)", and `log/sources/verify.jsonl` records the shape's label, never the text. The same holds for the `source_check` quote the hub writes into an agent's proposal. The check is code, not a model: every number in the claim must appear in the item, and at least 60% of its words. When the source's floor (its `min_sensitivity`, the private default for texts, Zoom and Granola, or a `forwarded:` rule's) is above the gardener's level, the verdict comes back without the quote.
- `unreachable`, with the reason: the source isn't listed, the item is outside the allowlist, there's no consent line, or live reading isn't built yet for that kind.

Calls are capped at `max_verifies_per_day` on the gardener's policy entry (default 40) and logged in `log/sources/verify.jsonl`.

Each read also corroborates. Every fact in the gardener's view (never one hidden from it on its own: above its level, shared with another agent only, or excluded by name) on an active note that cites the item is checked against the item's own words, by the fact's own value (never by the claim the gardener sent). If the item still says it, the fact gets `last_confirmed` today and loses any recheck that item raised. If the item no longer says it, or is gone, the fact turns `due` today with a `recheck:` naming the item and why. The value itself never changes. The answer lists those fact keys under `confirmed` and `due`, and the hub commits the change as `hub` (`Kind: pull`), one hash-chained line per fact in `log/writes.jsonl`. Values the word check can't judge are left alone: an ISO date, a value with no word of three letters or more, a list or an object. A person's fact is confirmed only by a sentence of the item that names that person: "Sam takes over as course coordinator" doesn't confirm Jane as course coordinator. A value said only about someone else is left alone (neither confirmed nor due), its key is listed under `elsewhere`, and the answer's `why` tells the gardener to check whether it changed.

## Upkeep rechecks due facts at their source

The nightly pass (the hub's own, or the gardener's `upkeep_run`) also rechecks, with no model, facts that are `due` or `stale` and cite an item the hub can read. It checks at most 20 items a pass, each corroborating as above, and logs each as agent `hub` in `log/sources/verify.jsonl`. A fact already flagged by that item is skipped, so it doesn't spend a check every night; it waits for you or for a new value. When the gardener runs it through `upkeep_run`, it picks and touches only facts in the gardener's view and returns only their keys under `rechecked` (`confirmed`, `due`); the hub's own night log line counts everything it checked. On a replica nothing is rewritten: the hub rechecks on its own pass.

The hub also checks agents' link-only inbox proposals itself after each pull pass. Each such proposal gets a `source_check:` with the verdict, which the digest shows next to it. A `no-match` raises a `source_mismatch` alert. Proposals from pulls are skipped, because their quote was already checked against the text.

## Standing signals

Each new mail or text item inside a source's allowlist also adds one line of counts to `log/standing/contacts.json` (who wrote, whether the owner answered, how fast; never text). `pocketbrain standing suggest` turns those into tiers for the owner to approve. See `docs/standing.md`.

## Running unattended

- `pocketbrain start` pulls every `poll_minutes`.
- `pocketbrain sources list` shows the sources and the consent line. `pocketbrain sources pull [<name>]` runs one pass by hand.
- Every call to Google or Discord gives up after 20 seconds (`PB_HTTP_TIMEOUT_MS` changes it), and the pass fails like any other. Pulls share one queue with agent writes, so a source that never answers must not hold that queue.
- A hub stopped mid-extraction (a restart, a power cut) leaves the item's capture record `pending`, with only its ref. The capture pass leaves such a record alone, and the next pull removes it and extracts the item again from the fetched text, instead of skipping it as a duplicate (`test/restart-recovery.test.ts`).
- A source that fails (an expired token, a missing consent line, an unreachable API) becomes a `source_failed` alert, once a day per source and reason, so it shows in the digest.
- The digest has a "Pulled from sources" line: items read, facts confirmed, proposals, notes turned due, and failing sources.
- `pocketbrain week` has two rows for this. "Sources: read / confirmed / proposed" and "Sources: errors caught / pulls failed" sit next to "Stale / due / disputed handed out", so the error trend is visible.

Texts rank as `exact`, never as the owner's word. That holds even for messages the owner sent: those were said to someone else, not to the brain. The older `imsg:` refs are messages the owner sent to the brain itself, and they still count as the owner's word. Reading chat.db needs Full Disk Access for the process that runs `pocketbrain start` (System Settings, Privacy & Security, Full Disk Access).

For Granola notes, extraction keeps decisions, commitments and dates and drops the chatter. The live reader is meant to use Granola's local cache on the Mac (`~/Library/Application Support/Granola/cache-v3.json`, read only). That path and its shape are to be confirmed on the Mac before it is built.

## Live Gmail, Calendar and Drive

Gmail, Google Calendar and Google Drive are read directly by the hub, each with its own read-only scope and token, through the owner's own Google OAuth client. Nothing goes through an assistant or a third-party connector.

1. **Google client, once (by hand).** In Google Cloud Console: a project, the Gmail API, the Google Calendar API and (for Drive) the Google Drive API enabled, an OAuth consent screen for the owner's own account, and an OAuth client of type "Desktop app". Its id and secret go in the keys folder as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (one value per file, `chmod 600`). While the consent screen is in "Testing", Google expires the refresh token after 7 days; publishing it "In production" for personal use avoids that (Google shows an "unverified app" screen once).
2. **Sign in.** `pocketbrain sources connect <source>` opens Google's sign-in on the Mac with only the `gmail.readonly` scope (`calendar.readonly` for a `gcal` source, `drive.readonly` for a `gdoc` source). The redirect comes back to a one-shot listener on 127.0.0.1 (PKCE). The refresh token is saved as `GMAIL_REFRESH_TOKEN_<ACCOUNT>` (or `GCAL_REFRESH_TOKEN_<ACCOUNT>`, `GDRIVE_REFRESH_TOKEN_<ACCOUNT>`) in the keys folder and never printed. If the source has `address:`, a different Google account is refused and nothing is saved (for Calendar, the primary calendar's owner is checked; for Drive, Drive's signed-in user).
3. **Consent.** Nothing is read until the owner's `consent:` line is in rules/sources.yaml.
4. **Dry run.** `pocketbrain sources pull <source> --dry-run` reads and extracts, then prints counts per account and area (safe to paste). `--show` adds the facts (not for pasting). It writes nothing: no cursor, capture, proposal, fact change, alert or run line.
5. **Running.** `start` pulls on its schedule. The first pass lists the last `backfill_days` (default 2) under the `where:` labels; every later pass reads Gmail's history from the stored historyId (`log/sources/<source>.json`), asked per `where:` label, so only new and deleted messages under those labels are listed and fetched. Mail outside the allowlist that still comes back is marked seen (its id only) and never fetched again, so unsolicited mail can't hold up the labelled mail behind it. A cursor too old for Gmail's history falls back to a week's listing. At most 100 messages are read per pass: the first pass keeps the newest, later passes leave the rest for the next one.
6. **Calendar.** Each listed calendar (`where:`, default `primary`) keeps a sync token in the cursor. The first sync keeps only events updated in the last `backfill_days` or starting in the next 60 days; later syncs return only changed events, skipping those already read at the same version, so more than 100 changes are worked through pass by pass. A cancelled event turns the facts citing it due. An expired sync token starts a fresh sync.
7. **Drive.** The `consent:` line must name Drive (consent for Gmail and Calendar doesn't extend to it). `where:` lists folder ids and is required: a `gdoc` source with no folders is refused, never the whole Drive. Only files directly in a listed folder are read (not subfolders). Google Docs are exported as plain text and `.txt`/`.md` files read as they are; PDFs, Sheets and anything else are skipped. The cursor keeps the newest `modifiedTime` per folder: the first pass lists files changed in the last `backfill_days`, later passes only what changed since, at most 50 files per pass. Refs are `gdoc:<file id>@<version>`, Drive's own version number, so an edit turns the facts citing the old version due. A file moved to the trash is noticed when it was also edited, or when `verify_source` reads it; `drive.readonly` can't see the rest of the trash cheaply.

A token whose scope is anything more than its one read-only scope is refused, not used. An expired or revoked token becomes a `source_failed` alert ("run pocketbrain sources connect again"), never a crash. `verify_source` on a `gmail:`, `gcal:` or `gdoc:` ref fetches that one message, event or file by id. For Drive, the file's folders are checked against `where:` before any of its text is read.

One Gmail source can cover mailboxes that auto-forward into it: see "Forwarded mail" above.

## Live Discord, texts and Granola

Every one of these needs the `consent:` line, and `--dry-run` works the same way.

- **Discord.** A bot of the owner's, with only View Channel and Read Message History on the listed channels and the Message Content intent turned on. Its token is `DISCORD_BOT_TOKEN` in the keys folder. The hub only ever sends GET: it never posts, reacts or edits. `where:` lists channel ids, or names (`"#dev"`) with `guild:` set to the server id. A name that matches more than one channel in the server (Discord allows that across categories) is refused with a `source_failed` alert naming the ids; list the id instead. Each pass re-reads the last 50 messages of each channel, so an edit is seen, plus anything newer than the cursor (the last message id per channel).
- **Texts.** The Mac's Messages database (`~/Library/Messages/chat.db`, or `path:`), opened read only. The allowlist is part of the query, so a thread that isn't listed is never read into memory. `where:` lists handles (phone or email) or a thread's `chat_identifier` (`chat…`, from the `chat` table). A display name is refused with an error saying what to list instead: anyone in a group chat can set its name, and names aren't unique. Newer macOS keeps the text only in `attributedBody`, which is decoded. The cursor is the last row; the last 200 rows of the listed threads are re-read so an edit or an unsend is seen. The process running `pocketbrain start` needs Full Disk Access. The text channel's own thread is never read, even when it is listed: the hub's texts to the owner (the `imessage` transport's `to`, or the Twilio `from` number in `rules/escalation.yaml`) quote proposals and sources, so reading them back would let a fact confirm itself. Phone handles match by their last ten digits.
- **Granola.** The desktop app's local cache (`~/Library/Application Support/Granola/cache-v3.json`, or `path:`), read only. Its `cache` field is a JSON string holding `state.documents`; a cache in another shape fails with a `source_failed` alert instead of a guess. The cursor is the newest `updated_at`.

`verify_source` reads one Discord message, one text or one Granola note the same way.

## Is the brain filling?

A brain nobody fills is a brain nobody consults. `pocketbrain fill [--days 7]` (code: `src/fill.ts`)
measures the capture pipeline the way the owner feels it, per source (the scheme of each fact's
first ref: `granola`, `gmail`, `gcal`, `discord`, `imessage`, `doc` for the mailbox and drop folder,
`agent` for an agent's capture, `unknown` for a card with no ref):

- **proposed**: capture proposals made in the window (an agent's own trial-tier proposal doesn't count);
- **kept / dropped / open**: what the owner did with them, and the keep rate;
- **re-confirmed**: facts a pull confirmed without asking anyone (`source-confirm` in `log/writes.jsonl`);
- **owner minutes**: from `log/owner-time.jsonl`, as in `pocketbrain week`. When you answered these facts' cards on the decision deck, the seconds on those cards (`log/deck.jsonl`, rows marked `capture`) are graded instead, shown as "min on the deck": they are the review itself ([decision-deck.md](decision-deck.md#the-morning-swipe)).

It grades the window against the self-filling targets: 50 proposed facts a week, 85% kept, at most
2 owner minutes a day. A source dropped more than 15% of the time (5 decisions or more) is named, so
the owner narrows it in `rules/sources.yaml` before it costs more taps. It reads files and logs
only and prints counts, never a value; `--json` prints the same numbers as JSON.

The morning digest opens its "Pulled from sources" section with the same numbers in one line:

```
- Filling: 23 proposed in 7 days (target 50), 88% kept, 4 re-confirmed; silent: gmail-personal (72h)
```

### Silent sources

A pull that quietly stops looks exactly like a quiet week. Once `rules/sources.yaml` has the consent
line, every listed source is watched from its `silent_after_hours` (default 72) after its first pass: if it has made no capture
proposal and re-confirmed no fact in that time (its runs in `log/sources/runs.jsonl`, proposals whose
refs carry its scheme and account, `source-confirm` lines), it is **silent**. The health probe's job
checks then fail a `fill` check that names it, which becomes one `hub` alert and a Needs-you line in
the digest until the source produces again; the digest's fill line names it too. A source that
errors already raises `source_failed`; this catches the one that runs fine and finds nothing (an
allowlist that no longer matches, a label renamed, a token scoped to an empty folder).

A failing check breaks the real-use streak ([real-use-bar.md](real-use-bar.md)), so a channel that is quiet by nature gets its own wait: `silent_after_hours: 168` on that source waits a week, and `0` stops watching it.

`pocketbrain week` carries a **Fill quality** section built from the capture cards the owner decided that
week (`fillQuality` in `src/fill.ts`; an agent's own proposals aren't counted): per source, cards
**accepted**, **edited** (accepted, then on or after that day the owner changed that fact's value on the
dashboard or marked it never right; a "Still true", a note-text edit or a sensitivity change doesn't
count) and **rejected**, and the acceptance rate, which
counts only clean accepts. Under it, **seconds per card**: the week's owner minutes over every card
decided, since owner time isn't logged per card. A source under **70% accepted over 5 or more cards**
gets a "Turn down <source>" line: narrow its `where:` or lower its `max_per_day`.

## Not built yet

- **Live fetchers for Slack and Zoom.** Gmail, Calendar, Drive, Discord, texts and Granola are live (above). The others stop with "live fetching isn't built yet".
- **The meeting packet.** This joins a calendar event, its Zoom meeting, the Slack thread that shared the link, and the attached doc.
