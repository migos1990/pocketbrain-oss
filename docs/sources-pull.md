# Source pulls

The brain stays current by reading the places the owner already works in: Gmail labels, calendars, Drive docs and Discord channels (Slack and Zoom work the same way for owners who use them). Agents still write what they learn. The pull fills the gaps when they don't, and it catches facts that went stale. The design and its reasoning are in the project's sources-pull note. This page covers what the code does (`src/pull.ts`).

## Facts, not copies

pocketBrain is a portable memory layer, not a mirror of the owner's mailbox or chats. A pulled item's text is held in memory only while its facts are extracted. Secrets are blanked first, and an item that looks like an injection is refused with a `source_held` alert, so nothing is sent to a model. The brain keeps:

- the facts, in its plain Markdown notes, each citing the item's ref;
- a capture record in `inbox/captures/` with the ref and what came of it, but not the text, the subject or title, or the value of any candidate that didn't become a proposal (dropped ones are listed by status, type and attribute). It also keeps `name_keys`: a short hash of each run of capitalised words in the item, never the words, so the page writer can link a page to the other pages its source names (docs/wiki.md, "Every page gets text");
- proposals that name the fact and its ref.

The few words a proposal was drawn from (at most 200 characters) help the owner keep or drop it, so
they wait beside the open proposal, outside git (`.git/pb-quotes/`, code: `src/quotes.ts`), and show
to the owner only: in the text channel's line for that proposal, and on its dashboard card (loopback,
owner sign-in). When the proposal is rejected they are deleted. When it files (by the owner or the
hub), they are kept for the owner's page (owner's choice 2026-10-27, G451): still outside git, at
most 200 characters, one file per source item in `.pb-kept-quotes/` in the brain folder named by a hash of its ref, holding the words of each fact drawn from it. That folder is owner-only (0700, files 0600) and ignored by git, so no commit carries it but the encrypted backup does, as it does the brain's other untracked files; quotes an older hub kept in `.git/pb-kept-quotes/` (outside the backup) move there on first read (audit v5, midday).
The hub also keeps them when it reads a cited item for any reason (a recheck, `verify_source`) and finds a fact's value in it: the sentence that says it (for a person, one that names them), checked like any quote and never kept when it reads as instructions. Each night it reads up to `WORDS_PER_PASS` (10) cited items whose words were never kept, newest fact first, for that alone (`keepSourceWords` in `src/pull.ts`); an item read in the last 30 days that didn't give its words waits (real-brain north star, 2026-10-30: 5 pages citing mail showed only the hub's text; G515).
The owner's page (`/p/<id>`) shows them folded under the reference that cites that item ("What
the source said"), so they open on a tap. No assistant tool, carve, log, digest or commit reads
them, and the old note page doesn't show them. The digest's sweep deletes the words of an item no
fact, history line or conflict in the brain cites any more. The proposal
file, its decided copy, commits, the digest and the model log (`log/judgments.jsonl` keeps the
extracted facts, never their quotes) don't hold them; a source check of an agent's link keeps only
its verdict and ref in the proposal, never the sentence (G98). A brain that isn't a git repo keeps
them in `.pb-quotes/`, which ignores itself, and `undo --run` stages only its reverts and `rules/suppressions.yaml` (G94).
Once Instinct has sent a text, a text was replaced, or every item it asked about was decided, its
words are cleared from `textline/outbox/` and it is no longer served (G95).

Proposals made before quotes moved out of git kept them at the end of their reason. The digest
moves each open one's quote beside it and strips the quote from open and decided proposal files,
in one hub commit (G97). Git history still holds those older lines; only a history scrub, the
owner's call, removes them.

One opt-in exception: a calendar marked `upcoming: true` also keeps its coming events' titles, places and start times, outside the brain (see [What's next from the calendar](#whats-next-from-the-calendar)).

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
    kind: gmail              # gmail | gcal | gdoc | zoom | slack | contacts (see Contacts)
    where: [Label_school]    # allowlist: labels, calendars, folders, meeting series, channels
    area: work               # where new notes from this source land
    max_per_day: 30          # items read per day (default 30), counted across the day; the rest waits for the next day
    # skip_bulk: false       # mail: also read list, bulk and machine-sent mail (skipped by default)
    new_notes_per_day: 3     # new notes proposed per day (default 3); the rest wait in inbox/held and file the next day
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
    upcoming: true           # answer next_* facts live from coming events (What's next from the calendar)
```

Only the items listed under `where:` are read. Messages under four words ("ok", "thanks!") are never sent to the model.

The `consent:` line is the day the owner agreed, as an ISO date (`2026-10-12`, optionally followed by a note such as `2026-10-12 by text`). A value that isn't a date (`no`, `pending`) or a date after today is not consent: live sources stay off and the pull says why in a `source_failed` alert.

Mail sent to a list or by a machine is never read for facts: a `List-Unsubscribe`, `List-Id`, `Precedence: bulk|list|junk` or `Auto-Submitted` (other than `no`) header, a sender address no person writes from (no-reply, do-not-reply, receipts, orders, billing, invoices, payments, notifications, alerts, mailer-daemon, postmaster, bounces; owner's phone 2026-10-29: Apple receipts filled Waiting on you, G506), or Gmail's Promotions, Social or Forums tab. It is marked seen and never sent to the model (owner's phone, 2026-10-25: a social network's notification became a card). `skip_bulk: false` on a source reads it again.

`max_per_day` counts items stored per source per calendar day, across every pass of that day (the count and its day are kept in `log/sources/<name>.json`). An item past the cap is not marked seen: it waits, untouched, and is read on a later day. While anything waits, the source's own cursor stays where it was, so a live source returns the item again.

If extracting one item fails (the model's answer is unusable, or anything throws), that item is counted as failed in the pass and the rest of the pass goes on; the state is saved. The item is tried again on the next passes, at most 3 times in all, then skipped with a `source_item_failed` alert to the owner.

### Forwarded mail

A mailbox that auto-forwards into another needs no connector of its own. The receiving source lists it under `forwarded:`, matched on the addresses the mail was delivered to: `Delivered-To` and `X-Forwarded-For`, which Gmail adds on receipt and on forwarding. `To`, `Cc` and `X-Forwarded-To` are written by the sender, so they never pick the rule's account. Each address is compared whole: `@school.example` matches that domain exactly (not `school.example.evil.test`), and a full address matches only itself:

```yaml
  mail:
    kind: gmail
    account: primary
    forwarded:
      - { to: "@school.example", account: school, area: school, min_sensitivity: private }
```

A matching item keeps the receiving ref (`gmail:primary/<id>`), and its capture and proposals record `forwarded_from: school`. Its facts land in that rule's area, at the higher of the two sensitivity floors. When several rules match, the one with the highest floor wins, so a header can never lower an item's floor.

Mail can belong to a forwarded account yet carry none of its delivery addresses. That happens when Gmail fetches the account by POP or sends as it, or when someone writes to that address and Gmail gets a copy. Then only `To` or `Cc` names the domain. A rule named only there still gives the item that rule's area and floor. Its capture records `addressed_to: school`, and the ref and account stay the receiving source's. The rule's floor joins the source's floor and any delivery rule's, and the highest one counts. So a sender can raise an item's floor by naming an address, but can never lower it. A sender can also move their own mail's facts into a named rule's area. Those facts are still proposals for you.

## New notes: a few a day

A mailbox names many people and things the brain doesn't hold yet, and each one used to become a "Start the note X" proposal: one source proposed 74 in a week and buried the deck. Now a source proposes at most `new_notes_per_day` new notes a day (default 3), counted across the day's pulls, open or already decided. The rest are written as usual but into `inbox/held`, which the deck doesn't show, with their quotes kept. A second fact about a new note goes where its first one went, so a held person's facts stay together. A fact about a note the brain already holds (by title or alias) is never held, whatever the count. Nothing stays parked past a day: the next day's first pull of that source moves every new note held on an earlier day into the inbox, in one hub commit with a `Why:` line, and the hub files them on its tick like any other. They keep their own day, so they don't use up the new day's share. A cap is a queue, never an ask: `north-star --brain` counts a held note as an ask only once it has waited past its day: the source's first pull of the next day ran and didn't move it, or a whole day went by with no pull (the day each source last ran the release is hub state in `.git/pb-held-release.json`). Just after midnight, before that pull, yesterday's overflow is still a queue (G453). `pocketbrain inbox more [n]` moves the oldest n held new notes, with all their facts, at once. Your own captures are never capped.

## What happens to each item

| The model finds | The pull does |
|---|---|
| A value the brain already holds | If every word of the value is in the item (whole words) and the item, its channel, thread or subject names who or what the fact is about, adds the source to that fact (replacing an older version of the same item) and sets `last_confirmed`, committed as `hub`. It never raises `verification` and never clears a `recheck`: those stay the owner's. No proposal. |
| A new or different value | An inbox proposal citing the exact source, at the source's sensitivity floor or higher. Its `source_type` follows the ref: `email` for Gmail and mail, `calendar` for Google Calendar, `document` for the other sources. The usual conflict order applies when it is accepted (an item older than the fact it changes becomes a dispute). At most `capture.max_proposals` (default 10) per item; the rest are listed as over the cap. If the same value is already waiting in `inbox/` from another pulled item, that proposal gains this item's ref instead of a new one. If it waits from another kind of source or another agent, this item gets its own proposal, and the owner sees both as one card (docs/capture.md, One card per fact). |
| Nothing it can ground in the text | Nothing. The capture file records why. |

Refs carry the source's version: `slack:<team>/<channel>/<ts>@<edited ts>`, `gcal:<event>@<etag>`, `gdoc:<file>@<revision>`, `zoom:<meeting>@1`, `discord:<channel>/<message>@<edited time or 1>`, `gmail:<id>` or `gmail:<account>/<id>`, and `mail:<account>/<message-id>`, `imessage:<guid>@<edit time or 1>`, `granola:<note id>@<updated time>` (emails never change, so they carry no version). All rank as `exact` sources.

## Who sent it

For mail and texts the capture records only `sender: known` or `sender: unknown`, never the address (`src/sender.ts`). Known means an address a person page (yours included) holds on your word or on a source the hub checked and found: a pull marks the items it read, the nightly recheck the rest (`log/refs-checked.jsonl`). An assistant's own "verified-by-source" on a mail id nobody read never makes an address known (G615). A mail the hub read vouches only for the address it came from: the read records the hash of its sender beside the ref (an unsalted sha256, so never the address in plain text, though a short one such as a phone number can be guessed back from it; the log is the owner's own), so citing a real mail never makes some other address known (G643); a contact card vouches for its addresses only on a record the hub filed from it. A ref read before this was kept vouches for no address until it is read again; your own word still counts. Standing and whom you have written to never count: standing sets priority, never trust (CLAUDE.md invariant 14). `unknownSenderWait` is the rule the filing step applies: a fact from an unknown sender that is private (money, health, legal included) is saved under the serving hold instead of filing for your assistants (G454): no assistant gets it until you tap Show on your home, and the record says `sender: unknown` (never the address), so the home says where it came from. A different value from an unknown sender is weighed like any other: a newer one from an as-strong source updates (with Undo), anything else is a conflict the Gardener weighs first, and the live value stays meanwhile. Anything else files as usual. The save path itself marks the hub's own accept of such a fact this way, whoever runs it. A capture the write path refuses because its value is one the capture agent was never shown (`leak_tripwire`) is dropped from the inbox: the refusal already alerted you, so the alert is the only thing that asks. Captures from before this check have no `sender` and are treated as before.

## When a source moves

On every pass the hub compares each item's version with the one it saw last (`log/sources/<name>.json`). An edited, deleted or cancelled item turns every fact citing the old version **due**: `review_after` is set to today, and `recheck: { why: "source changed" | "source gone", ref, at }` says why. No model decides this. The value stays as it is, and the fact shows as due in reads and in "Needs a look" until the owner decides. A later pull that repeats the value adds its source but doesn't clear the recheck. When the gone item was the fact's only source, the fact also stops claiming `verified-by-source`: it becomes `unverified`, and its `note` keeps "verified-by-source until <day>: source gone (<ref>)". A later read that finds the item saying the value again raises it back.

## The gardener checks claims through the hub

The gardener has no mailbox, calendar or search. When a fact rests only on a link an agent cited (`gmail:<id>`, `gcal:<id>`), the gardener calls `verify_source` (MCP) or `POST /v1/gardener/verify` with the ref and the claim. The hub answers only for a ref that a fact in the gardener's own view cites, so the tool can't be used to read the mailbox. It reads that one item through the same allowlist and answers:

- `match` or `no-match`, with a sentence of the item (at most 200 characters, secrets blanked). The blanking runs on the whole item before it is cut into sentences, and every `-----BEGIN …-----` to `-----END …-----` block (a key, a PGP block, a certificate; to the end when it never ends) is removed first, so no line from inside one can be the sentence, and the claim is matched against that text only (G194). The sentence can be the subject line, and it is text a model reads, so it is checked for injection shapes (`findInjection`) whole, before it is cut. One that reads as instructions is never returned: the verdict still comes back, the `why` says "quote withheld: reads as instructions (…)", and `log/sources/verify.jsonl` records the shape's label, never the text. The same holds for the `source_check` quote the hub writes into an agent's proposal. The check is code, not a model: every number in the claim must appear in the item, and at least 60% of its words. When the source's floor (its `min_sensitivity`, the private default for texts, Zoom and Granola, or a `forwarded:` rule's) is above the gardener's level, the verdict comes back without the quote.
- `no-match` with "source gone" when the item was deleted, cancelled or removed, or isn't at the source any more (Gmail, Calendar and Drive answer "not found"); with several accounts listed for the kind, only when none has it.
- `unreachable`, with the reason: the source isn't listed, the item is outside the allowlist, there's no consent line, or live reading isn't built yet for that kind. An item the hub already read and captured from that source counts as inside the allowlist whatever its labels are now, so archived mail can still be checked; an item a pull only skipped as outside the allowlist (marked seen, never read, no capture record) stays closed (G457).

Calls are capped at `max_verifies_per_day` on the gardener's policy entry (default 40) and logged in `log/sources/verify.jsonl`.

Each read also corroborates. Every fact in the gardener's view (never one hidden from it on its own: above its level, shared with another agent only, or excluded by name) on an active note that cites the item is checked against the item's own words, by the fact's own value (never by the claim the gardener sent). If the item still says it, the fact gets `last_confirmed` today and loses any recheck that item raised. If the item no longer says it, or is gone, the fact turns `due` today with a `recheck:` naming the item and why. The value itself never changes. The answer lists those fact keys under `confirmed` and `due`, and the hub commits the change as `hub` (`Kind: pull`), one hash-chained line per fact in `log/writes.jsonl`. Values the word check can't judge are left alone: an ISO date, a value with no word of three letters or more, a list or an object. A person's fact is confirmed only by a sentence of the item that names that person: "Sam takes over as course coordinator" doesn't confirm Jane as course coordinator. A value said only about someone else is left alone (neither confirmed nor due), its key is listed under `elsewhere`, and the answer's `why` tells the gardener to check whether it changed.

## Upkeep rechecks due facts at their source

The nightly pass (the hub's own, or the gardener's `upkeep_run`) also rechecks, with no model, facts that are `due` or `stale` and cite an item the hub can read. It checks at most 20 items a pass, most at stake first (below), each corroborating as above, and logs each as agent `hub` in `log/sources/verify.jsonl`. A fact already flagged by that item is skipped, so it doesn't spend a check every night; it waits for you or for a new value. When the gardener runs it through `upkeep_run`, it picks and touches only facts in the gardener's view and returns only their keys under `rechecked` (`confirmed`, `due`); the hub's own night log line counts everything it checked. On a replica nothing is rewritten: the hub rechecks on its own pass.

The hub also checks agents' link-only inbox proposals itself after each pull pass. Each such proposal gets a `source_check:` with the verdict, which the digest shows next to it. A `no-match` raises a `source_mismatch` alert. Proposals from pulls are skipped, because their quote was already checked against the text.


### What gets rechecked first

With more candidates than the pass can read, the items behind facts with the most riding on them go first (`recheckCandidates` in `src/pull.ts`):

1. facts that rest on one source (two versions of the same mail are one source),
2. then facts backed weakly: self-reported, relayed by another assistant, inferred, or a vague source,
3. then the facts your assistants read most in the last 30 days (`log/reads.jsonl`; the gardener's own reads don't count),
4. then stale before due.

A fact that isn't due yet is also a candidate when it rests on one source, an assistant read its note in the last 30 days, and nothing confirmed it in that time (never your own word, and never one an item already flagged). So a weak fact that gets used is checked about once a month instead of waiting for its shelf life to run out.

The week report (`pocketbrain week`) has a **Corroboration** line: of the live values on notes your assistants read that week, how many rest on two or more sources.

### Sources that vanish

The candidates above leave out fresh facts nobody reads, so a mail deleted or an event cancelled behind one of those would go unseen until its shelf life ran out. Each pass therefore also checks that up to 10 more cited items still exist (`sampleRefs` in `src/pull.ts`): items cited by live facts in view that the pass didn't already read, the ones checked longest ago (or never) first, so over the nights every cited item gets a turn. This is an existence check only. An item still there changes nothing and is logged `present`; an item gone at its source turns every fact citing it due with `recheck: { why: "source gone" }`, as a pull does (above), and is logged `gone`. Nothing is deleted. A fact already flagged by that item doesn't put it back in the sample. The night log line counts these items apart from the rechecked ones.
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
5. **Running.** `start` pulls on its schedule. The first pass lists the last `backfill_days` (default 2) under the `where:` labels; every later pass reads Gmail's history from the stored historyId (`log/sources/<source>.json`), asked per `where:` label, so only new and deleted messages under those labels are listed and fetched. Mail outside the allowlist that still comes back is marked seen (its id only) and never fetched again, so unsolicited mail can't hold up the labelled mail behind it. A cursor too old for Gmail's history falls back to a week's listing. At most 100 messages are read per pass; the rest wait for the next one. A first listing with more waiting stores `list:<historyId>` as the cursor: the next pass lists again, skipping messages already read, and once the listing is done history starts from the historyId taken before it began, so nothing that arrived meanwhile is missed.
6. **Calendar.** Each listed calendar (`where:`, default `primary`) keeps a sync token in the cursor. The first sync keeps only events updated in the last `backfill_days` or starting in the next 60 days; later syncs return only changed events, skipping those already read at the same version, so more than 100 changes are worked through pass by pass. A first sync with more than 100 recent events keeps no sync token until they are all read. A cancelled event turns the facts citing it due. An expired sync token starts a fresh sync.
7. **Drive.** The `consent:` line must name Drive (consent for Gmail and Calendar doesn't extend to it). `where:` lists folder ids and is required: a `gdoc` source with no folders is refused, never the whole Drive. Only files directly in a listed folder are read (not subfolders). Google Docs are exported as plain text and `.txt`/`.md` files read as they are; PDFs, Sheets and anything else are skipped. The cursor keeps the newest `modifiedTime` per folder: the first pass lists files changed in the last `backfill_days`, later passes only what changed since, at most 50 files per pass. Refs are `gdoc:<file id>@<version>`, Drive's own version number, so an edit turns the facts citing the old version due. A file moved to the trash is noticed when it was also edited, or when `verify_source` reads it; `drive.readonly` can't see the rest of the trash cheaply.

**Where am I?** `pocketbrain doctor` has a `sources` section that names the one missing step for each source, in this order: no sources at all, the `consent:` line, the Google client keys, the sign-in per source (`pocketbrain sources connect <name>`), then a dry run if the source was never pulled. Once a source has been pulled it shows the last run (when, how many fetched and read) or the reason the last pull was refused. Only key names are checked, never their values, and nothing is fetched.

A token whose scope is anything more than its one read-only scope is refused, not used. An expired or revoked token becomes a `source_failed` alert ("run pocketbrain sources connect again"), never a crash. `verify_source` on a `gmail:`, `gcal:` or `gdoc:` ref fetches that one message, event or file by id. For Drive, the file's folders are checked against `where:` before any of its text is read.

One Gmail source can cover mailboxes that auto-forward into it: see "Forwarded mail" above.

## What's next from the calendar

A next step goes stale the day after it happens ("Class on Oct 14", read on Oct 20), while the calendar already knows the next one. With `upcoming: true` on a `gcal` source, every pull of that source also reads its coming 60 days (recurring events expanded, read only, nothing sent to a model). It keeps each event's title, place, start and ref, never its description or guests, and skips cancelled, private and confidential events and any that look like an injection. They're kept in `~/.cache/pocketbrain/upcoming/` (`PB_UPCOMING_DIR` moves it): one owner-only file per brain, outside the brain, its git history and its backups. Each pull replaces it.

When an agent reads (search, context_pack, read, and the golden set), a note's `next_*` fact that is no longer current is served as the soonest coming event whose title or place names the note (its title or an alias of four letters or more). It is served as `Course A class, 2026-10-14 18:30, Room 12 (from the calendar)`, current, citing `gcal:<id>@<version>`. A current next step is served as stored, and the note file never changes. This happens before the carve, so the carve decides who sees the event like any other fact: it carries the source's `min_sensitivity`, or the stored fact's, whichever is higher. If the source hasn't been refreshed for two days, its events are ignored and the stored step shows again, stale. To stop: remove `upcoming: true`, then delete the folder.

An event that should answer a note needs the note's name in its title. Add the event's word as an alias on the note when they differ (a course code, or a place's nickname).

## Backfilling sources

Most facts arrive from an assistant's word or a vague pointer, so nothing can recheck them later (the week report's "Facts with no live source"). `pocketbrain sources backfill <gmail source> [--max N] [--dry-run]` takes up to 20 such facts per run, newest first, and searches the mailbox for each value as an exact phrase, under the source's `where:` labels only. It reads at most 3 messages per fact. A search sends the value to the mail provider, so a fact that is private, or on a private note, is never searched for. A message becomes the fact's source only when:

- it states the value (every word of it, as pulls check), and names the note's title or one of its aliases;
- it isn't more sensitive than the note or the fact. A mail whose forwarded rule or source floor is above them is skipped, never attached.

Then the fact gets the mail's exact ref and `last_confirmed`, in one commit by the hub ("pull: <ref> confirms <fact>"). The value is never changed, and nothing from the mail is kept. A fact searched with no match waits 30 days before the next try (log/sources/<source>-backfill.json). Each run adds one line of counts to log/sources/backfill.jsonl. `--dry-run` lists what would be attached and writes nothing. It needs the owner's `consent:` line like any live read, and a replica doesn't run it. The nightly pass runs it too, for every Gmail source, with the same caps. Like every scheduled job it starts report-only: it searches and logs how many facts could get a source (`backfill (report only):` in the hub log) and writes nothing, until you run `pocketbrain backfill on` (an owner commit of `backfill: { nightly: true }` in policy.yaml; `pocketbrain backfill off` goes back). From then on facts gain their mail as a source with no hand step. How many still wait, and why, is in `pocketbrain audit trust` (docs/trust.md).

## Live Discord, texts and Granola

Every one of these needs the `consent:` line, and `--dry-run` works the same way.

- **Discord.** A bot of the owner's, with only View Channel and Read Message History on the listed channels and the Message Content intent turned on. Its token is `DISCORD_BOT_TOKEN` in the keys folder. The hub only ever sends GET: it never posts, reacts or edits. `where:` lists channel ids, or names (`"#dev"`) with `guild:` set to the server id. A name that matches more than one channel in the server (Discord allows that across categories) is refused with a `source_failed` alert naming the ids; list the id instead. Each pass re-reads the last 50 messages of each channel, so an edit is seen, plus anything newer than the cursor (the last message id per channel).
- **Texts.** The Mac's Messages database (`~/Library/Messages/chat.db`, or `path:`), opened read only. The allowlist is part of the query, so a thread that isn't listed is never read into memory. `where:` lists handles (phone or email) or a thread's `chat_identifier` (`chat…`, from the `chat` table). A display name is refused with an error saying what to list instead: anyone in a group chat can set its name, and names aren't unique. Newer macOS keeps the text only in `attributedBody`, which is decoded. The first pass reads the last `backfill_days`, picked by date in the query so a long thread's history can't crowd it out; with nothing that recent it starts after the thread's newest row. After that the cursor is the last row read (at most 500 per pass), and the 200 rows below it are re-read, keeping only texts already read, so an edit or an unsend is seen and the old thread never comes in. `verify_source` looks a text up by its id within the listed threads. The process running `pocketbrain start` needs Full Disk Access. The text channel's own thread is never read, even when it is listed: the hub's texts to the owner (the `imessage` transport's `to`, or the Twilio `from` number in `rules/escalation.yaml`) quote proposals and sources, so reading them back would let a fact confirm itself. Phone handles match by their last ten digits.
- **Granola.** The desktop app's local cache (`~/Library/Application Support/Granola/cache-v3.json`, or `path:`), read only. Its `cache` field is a JSON string holding `state.documents`; a cache in another shape fails with a `source_failed` alert instead of a guess. The cursor is the newest `updated_at`.

`verify_source` reads one Discord message, one text or one Granola note the same way.

## Contacts

The owner's address book fills the people pages: who is family, what someone is called, their job and company, how to reach them. A card is structured, so it is read by code and never sent to a model (`src/contacts.ts`); this source works with no model key. Its facts are checked and filed exactly like a pulled mail's (a capture record holding only the ref, Undo, a diary line), citing the card as `contacts:<card id>@<version>`, named "Contact card" on the page.

```yaml
consent: 2026-10-31 mail, calendar and contacts   # the line must name contacts
sources:
  contacts:
    kind: contacts
    account: primary          # Google Contacts: pocketbrain sources connect contacts (contacts.readonly)
    # path: ~/Contacts/export.vcf   # or a vCard file (or a folder of .vcf files) exported from the phone; no sign-in
```

What a card files:

- **On a page that exists:** its nicknames (`aliases`), its job title (`role`) and company (`org`, only when an org page by that name exists), its emails and phones. Emails and phones are filed `private`, so they wait behind **Show** like any private value and no assistant gets them before the owner has seen them: not through MCP, the API, its view or the relay, not even one that sees everything (test/contacts-doors.test.ts, G562). After Show only an assistant whose grant reaches private gets them, and `who_is` still matches nobody by them, since a card never makes an address trusted. An email or phone beside ones the page already holds, the owner's own included, is another item of the list, not a contradiction: it files itself and asks nothing (G565).
- **A job title or company that differs from the page's** is dropped, never filed: cards go stale for years.
- **The owner's own card** (the card whose name is the owner's) names family: "Mother: Hélène Lefebvre" becomes `relationship: Robin's mother` on Hélène's page. That is the only way a card starts a page: a person the owner's card names who has no page yet gets one, filed like any new page from a source (`new_notes_per_day`). A card for anyone else the brain doesn't know files nothing and leaves no record.
- **A relationship that contradicts the page's** ("Robin's sister" on a page that says "climbing partner") is filed as a conflict for the owner to settle, the only ask a card makes. One the page already says ("Robin's daughter, 9") is dropped.
- **Nicknames are kept, never matched on.** Only a page's title and frontmatter aliases decide which page a name means: a nickname like "Mom" on two cards would send mail to the wrong page. A nickname that is another person's name is not filed. A card's email or phone is filed as the card's own say-so; once upkeep's recheck has read the card again it counts as verified by the source, and two pages that then share it become a same-person proposal (`docs/same-person.md`).
- Addresses, birthdays, notes and groups are never read. Company-only cards are skipped.

`relationship` and `aliases` are filed even where rules/checks.yaml doesn't declare them; a model's extraction never proposes either (`CARD_ATTRS` and `cardOnly` in src/rules.ts).

**Google Contacts.** The same Google client as Gmail, with the People API enabled. `pocketbrain sources connect <source>` asks only for `contacts.readonly` and saves `GCONTACTS_REFRESH_TOKEN_<ACCOUNT>`. That scope can't name its account, so `address:` is used as the sign-in hint and not checked afterwards. Only saved contacts are read, never the "other contacts" Google collects from mail. The first pass lists every card; later passes use the People API's sync token and read only what changed. A deleted card turns the facts citing it due. An expired sync token lists again, skipping cards already read at their version. At most 200 cards are read per pass, and up to 200 stored a day (`max_per_day`); most cards store nothing.

**vCard.** `path:` is a `.vcf` file or a folder of them (an iPhone export, or Google's "Export > vCard"), read whole each pass. Apple's related names (`X-ABRELATEDNAMES` with their labels) and vCard 4 `RELATED` are both read. A card's id is its `UID`, else a hash of its name and first email or phone; its version is a hash of what it says. A card missing from a later export turns its facts due.

**A card ref is the hub's.** No assistant reads the owner's address book, so a `contacts:` ref counts as the card's only on what the hub pulled itself; on an assistant's write it is that assistant's own word, even when it names a card the hub has read and even in a brain whose resolver is that assistant: it never outranks the owner's word or what the card filed, and a different value is a conflict, never an update (`readFor` in src/write.ts, G564; test/contacts-forged-ref.test.ts). The record is stored as that word (self-reported), not only ranked as it, and an address vouched for by card refs alone counts toward a known sender only when the hub filed it (`trusted` in src/sameperson.ts, G581), so an assistant can't make an address it planted a trusted sender. A made-up card ref changes nothing until checked. The carve property (test/carve-property.test.ts) seeds card emails and phones, held and seen, and its leak oracle counts a value still held until Show as carved out for every agent (G563).

`verify_source` reads one card by its id from either, and checks a claim against it without its email and phone lines: those are held until Show, so no quote or match gives them away (G549). Upkeep's recheck reads the whole card and answers with fact keys only.

## Is the brain filling?

A brain nobody fills is a brain nobody consults. `pocketbrain fill [--days 7]` (code: `src/fill.ts`)
measures the capture pipeline the way the owner feels it, per source (the scheme of each fact's
first ref: `granola`, `gmail`, `gcal`, `discord`, `imessage`, `doc` for the mailbox and drop folder,
`agent` for an agent's capture, `unknown` for a card with no ref):

- **proposed**: capture proposals made in the window (an agent's own trial-tier proposal doesn't count);
- **kept / dropped / open**: what the owner did with them, and the keep rate;
- **re-confirmed**: facts a pull confirmed without asking anyone (`source-confirm` in `log/writes.jsonl`);
- **owner minutes**: from `log/owner-time.jsonl`, as in `pocketbrain week`.

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
