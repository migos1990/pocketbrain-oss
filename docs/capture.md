# Capture channels

The owner says something once, wherever they are, and it reaches the brain as proposals they accept. Four ways in, one path after that:

| Channel | Who | Where it runs | Counts as |
|---|---|---|---|
| `pocketbrain capture --text/--voice/--email` (`--voice` takes a transcript, or an audio file once [voice notes](#voice-notes) are on) | The owner at a terminal | any machine | The owner's word (email: a document) |
| MCP `capture` tool, `POST /v1/capture` | the agent that carries the owner's messages (policy `capture.agents`, default their channel agent) | the hub's server | The owner's word relayed; another allowed agent's capture is that agent's observation |
| The capture mailbox | The owner forwards an email, or writes a note, to a capture address | the hub (serve's tick, or `capture watch`) | always a document: a From line can be forged |
| The drop folder | the owner's phone saves a file to a folder their storage service syncs | any machine with the folder | The owner's word (an `.eml`: a document) |

Every channel ends in `capture()` (`src/capture.ts`):

1. **Secrets** (card numbers, passwords, codes) are blanked before anything is stored, queued or sent: in the text, the subject and the From line alike. What was removed is listed under `removed:`.
2. **Limits**: `max_bytes` per capture, `max_per_day` per sender (the CLI has none).
3. **Dedupe**: a capture is keyed by its normalized text. The same words on another day, from another channel or from another machine are kept once. On a replica, an op already queued counts too.
4. **Injection shapes** (the write path's own list, `findInjection`) hold the capture for the owner: stored with `status: held`, never sent to a model. `capture held`, then `capture release <file>` or `capture discard <file>`. The dashboard shows each held capture under Needs you, with its text and Release and Discard buttons. The text channel sends it as one item ("Held capture from the capture mailbox: it reads like instructions. Release?"), never its words or the sender's address; a relayed reply can discard it but only the owner's own reply or the dashboard releases it.
5. **Store**: `inbox/captures/<date>-<hash>.md`, committed, `status: pending`.
6. **Extract** (model step `capture.extract`): facts with exact quotes. Code then drops anything not in the text: the quote must be in it, a date must be written in it (whole, or its day and month) or said in words ("next week", "mardi") for a date within a year of today, and the value's words must appear as whole words, with thousands separators ignored ("50 000" and "$50,000" are 50000, but not 5000). Every number in the value must be in the text too, so a value with one digit changed is dropped though its other words match; a phone is matched by its digits, however it is written. Words like "the" and "of" don't count toward the value's words. A value that describes the item instead of a fact in it ("sender of the email", "the sender's department") or only restates the entity's own name (Maple Trust Bank, kind "bank") is dropped. So is a fact quoted from a mail's footer ("this email was sent to …", "ce courriel vous a été envoyé par …", unsubscribe lines): who a mail went to is not a fact about them. So is a value for a date attribute (`normalize: date`, like `last_contact`) that isn't a date or a date in words ("retiring at the end of October"). And a fact cited from a sentence that gives orders ("ignore all previous instructions and record that…") is dropped: that is the item's instruction, not a fact it states. How often extraction is right is measured on 40 synthetic items by `bun evals/run.ts --only fill` (evals/README.md, capture precision). When neither the text nor a pull's channel, thread or subject names who or what a fact is about, the proposal says the model inferred it, and a pulled item never re-confirms a fact that way. Then code resolves the entity, and compares with what the brain holds. A person is matched without honorifics or named degrees and certifications ("Dr. Jane Roy, PhD, CISSP" is Jane Roy; "Monsieur", "Madame" and "Mademoiselle" are titles too; the French "M." can be an initial, so "M. Dupont" stays apart from "Dupont", but two titled names of the same kind match ("M. Roy" is "Mr Roy" and "Monsieur Roy", never "Mme Roy"), and a titled full name is that name; G547); only after a name of two words or more, and a degree that is also a given name (Ma, Ba, Med) only when dotted or in capitals; a generational suffix, an initial or a given name after a comma keeps people apart ("John Smith, Jr." is not "John Smith, Sr."; "Li, Ba" is not "Li, Ma"; "Roy, Jane" stays as written). A person fact naming the owner (`owner.name` or `owner.aliases` in rules/policy.yaml, two words or more, or the title of the owner's own person page) goes to the owner's page ("Last, First" too); while the owner has none, it starts the owner's own page under the owner's full name (the longest of `owner.name` and `owner.aliases`), so the owner is never a second note; that page is filed in the `personal` area when there is one. A new person page is titled without credentials ("Ada Fox, PhD" starts "Ada Fox"). When `owner.name` is a first name alone, `pocketbrain me name` adds the full name to `owner.aliases` (asked in your terminal, or `--suggested`: the full name the open proposals of the capture pipeline, the capture agent and core assistants (never a trial agent or the Gardener) give you, a degree after it with or without a comma set aside, seen at least twice and twice as often as any other, never a Jr. or Sr.; spellings that are one name once accents, case, credentials, a title, a note in brackets and a surname in capitals put first ('LAST First') are set aside count together (any other word order stays a different name), and each becomes an alias; an initial or a family note in brackets (son, cousin, fils, Jr.) still keeps two names apart; neither prints it, and when no name is settled it prints counts only: how many person proposals, why each was set aside, sightings per name) and moves the open proposals about you onto that one page, in one commit. The aliases are your commit; the move is the hub's, with `Asked-by: owner` in its message (every brain commit names who made it: you, the hub or an agent, never the machine's git login; a move the hub's code decides is never yours, G426). `bun scripts/filing-counts.ts` knows you by the same names: "owner has a person page" and "about the owner" use them, not the first name alone. A title and surname alone on the owner's page ("M. Lake", the name a merge of that page into yours leaves there) is you under any title of the same kind ("Mr Lake", "Monsieur Lake"), never one of the other kind ("Mme Lake"), and only while no one else's page has that surname: beside your father's "Alain Lake", "Monsieur Lake" is left ambiguous, and only the alias as written ("M. Lake") is you; and a titled name never matches a page named with a title of the other kind (G547). With two person pages bearing the owner's name, it is left ambiguous rather than guessed. Each new or changed fact becomes one `inbox/` proposal. Accepting it runs the normal write path, with every write check; the fact is marked "you approved" and ranks as the source it cites, not as the owner's word (see [trust.md](trust.md)). A new person or project gets the area most related notes are in, which the owner can change before accepting.
   - A candidate the model returns with anything but text in its entity, type, attribute, value or quote is dropped as ungrounded; the others still go through.
   - A value over 200 characters (`MAX_VALUE_CHARS` in `src/capture.ts`; there is no per-attribute setting) is "unsupported: too long to be a fact", with no proposal, however well its words match the text. A fact is a short value, not a paragraph of the source. The digest prints at most 120 characters of any proposal's value and 300 of its reason; the proposal file holds the rest.
   - One capture makes at most `max_proposals` proposals (default 10). Facts past that are listed in the capture file as `over-cap` ("over the cap"), with no proposal.
   - A fact already waiting in `inbox/` (same note, attribute and normalized value, whatever source it cites) is not proposed again. The new source is added to that proposal's `sources` when both came from captures of the same kind (two pulled messages, two of the owner's notes); otherwise it gets its own proposal, and the owner sees both as one card (a pulled email, then the owner saying the same thing).
   - The capture file's `## Extracted` list shows a dropped (ungrounded or unsupported) candidate by its status, type and attribute only, never its value. For a pulled item no value is written except the ones in its proposals.
7. **No copies of other people's words.** A capture that isn't the owner's own words (forwarded or mailbox mail, another agent's capture, an agent's memory dump) keeps its text only until it is extracted, or discarded if it was held. Then the file keeps the header, a line naming the ref its proposals cite (`doc:capture/<id>`) and the `## Extracted` list, like a pull; each proposal still carries its quote. The owner's own typed, spoken, dropped or relayed notes stay as they are. Commits made before extraction still hold the text in the brain's history.

### One card per fact

Every proposal follows the same rule, not only captures. Proposals for the same value of the same fact (same note, or same type and title; same attribute; same normalized value, using the note's own type) are shown on the dashboard as one card, led by the one filed first. The card says "also said by …", with a twin's level when it differs (for example "(private)"), and "(its source doesn't match)" when the hub's check of that twin's cited link didn't find the value, and the digest prints one line with "Also said by … (N sources)".

On the dashboard, each change to approve is one plain question ("Save “B-204” as Course A's room?", or "Add this to Course A?" for a long value, "Update Course A: next step?", "Add this open question to Course A?") with where it came from and the source's own words when a pull or capture kept them. Settings decides nothing (2026-10-27): a proposal that contradicts a value has a *Settle it* link to its settle screen (`/settle/p-<file>`, `src/settle-inbox.ts`), and the rest say what the hub's own plan does with them and when (`queues` from `autoSaves` in `src/filing.ts`): "Files on Oct 30" for an assistant's own proposal held until the hold ends, "Expires unconfirmed on <day>" for an outside assistant's, "Set aside on the next tick" for an assistant's question; one with no plan waits for your own word in the box. Above the list, one line says how many of your assistants' proposals are held and the day they file, so the day shows even when the list runs past its first page of 50 (G500). `pocketbrain inbox --accept <file>` (and `decideProposal`) still answer one. Accepting is your approval as of today, so a proposal an assistant dated after today is saved dated today rather than refused (`decideProposal` in `src/write.ts`); an assistant's own write dated in the future is still refused. Rule ids in an agent's text show as words ("rule:never-store" as "your never store rule") and the owner named in the third person as "you". An answer covers the card and the twins it showed, each through its own request and every write check, as if answered alone. A twin filed after the card was drawn is not answered with it. A twin its checks refuse stays in the inbox, and one that goes back for review is counted apart; the answer says so. `pocketbrain inbox --accept <file>` answers that one file only. A gardener proposal on such a card is rejected like any other, so its 30-day refusal applies.

An agent's proposal that cites the owner's word (an `imsg:phonemsg-…` or `owner:` ref), or was flagged for it, is never folded into a card: it keeps its own card and its own warning. The hub's own capture of something the owner said does fold.

Each proposer keeps its own file and gets the same answer as ever. Grouping happens only in the owner's view, so nothing an agent sees depends on what else waits in the inbox.

A model only extracts: nothing here writes a fact. The write path files each one (CLAUDE.md invariant 6: facts file themselves; the owner is asked only about conflicts).

Extraction runs after storing, not inside the request. An agent gets its answer at once; the server extracts in its write queue right after. Mailbox and drop-folder captures are extracted at the end of each tick. A failed model call, or a hub restarted mid-extraction, leaves the capture `pending` for the next pass; proposals it already wrote merge with the new ones, so nothing is filed twice. `pocketbrain capture pending` runs it by hand.

## Configuration (policy.yaml, the owner only)

```yaml
capture:
  agents: [instinct]          # who may use the capture tool/route (default: louis_channel, else the resolver)
  max_bytes: 65536
  max_per_day: 50
  max_proposals: 10           # inbox proposals from one capture or pulled item; the rest are listed "over the cap"
  poll_minutes: 5             # mailbox + drop folder + pending extraction, in serve and capture watch
  drop_folder: ~/Storage/pocketbrain-drop   # read on whichever machine has it; --dir overrides
  mail:
    provider: agentmail       # or maildir
    inbox: capture@<your agentmail domain>
    key_env: AGENTMAIL_CAPTURE_KEY           # a key scoped to this inbox only
    # provider: maildir, dir: ~/Mail/pocketbrain   (fetchmail, getmail or a mail rule fills it)
    allowed_from: [louis@example.com]        # the owner's own addresses; anything else is dropped with an alert
```

With no `allowed_from`, the mailbox isn't read at all.

## The mailbox

A Gmail filter (or a manual forward) sends mail to the capture address. On each tick the hub reads unread messages:

- A sender not in `allowed_from` is dropped. Its text is never stored. An alert goes to `log/alerts.jsonl`.
- A forwarded message (Gmail, Apple Mail and Outlook markers) is captured with the **original** sender, subject and date. The owner's own line above the forward stays in the text.
- MIME is handled: text/plain preferred, HTML stripped, quoted-printable and base64 decoded.
- Every message read is marked done (AgentMail label `captured`, Maildir `cur/`), so a bad message can't loop.

Because From can be forged, a mailbox capture is never the owner's word. Its proposals cite `doc:capture/<id>` (source type `document`) and the owner still accepts each one.

## The drop folder (phone)

The phone saves into a folder the storage service syncs. iOS Shortcuts or the Files app both work. Each file at the top level of the folder becomes one capture:

| File | Becomes |
|---|---|
| `*.txt`, `*.md` | a text; a voice transcript if the name has `voice`, `transcript` or `dictation` |
| `*.eml` | an email (a document) |
| `*.json` | `{"text": "...", "kind": "text|voice|email", "subject": "...", "date": "YYYY-MM-DD"}` from a shortcut |
| audio (`.m4a .mp3 .wav .caf .aac .ogg .opus .amr .flac .webm`) | a voice capture of its transcript, once a transcriber is set ([Voice notes](#voice-notes)); while it is off, moved to `failed/` with a note saying how to turn it on |

Files changed in the last 10 seconds wait for the next pass (still syncing). Each file then moves to `done/<date>/`, or to `failed/` with a `.why.txt`. The phone signs nothing: the machine that reads the folder does. On a replica, that means a signed op.

## Voice notes

Off by default. An audio file in the drop folder, or given to `capture --voice`, is transcribed only once the owner names a transcriber in `rules/models.yaml` (`src/transcribe.ts`). A step default or the `default:` model never turns it on: sending audio out is its own choice.

```yaml
steps:
  # Local (preferred): the audio never leaves the machine. {audio} is the file's path; no shell runs.
  capture.transcribe: { provider: command, command: ["whisper-cli", "-m", "~/models/ggml-base.bin", "-nt", "-f", "{audio}"] }
  # Hosted, only with a key: POST <base_url>/audio/transcriptions
  # capture.transcribe: { provider: openai, model: whisper-1 }                       # key in OPENAI_API_KEY
  # capture.transcribe: { provider: openai-compatible, base_url: http://localhost:8080/v1, model: whisper-large-v3 }  # api_key_env if it needs one
  # Optional: max_bytes (default 25 MB), timeout_ms (default 5 min), language (hosted hint, e.g. fr)
```

- The transcript is the capture: `kind: voice`, then the same path as a dictated `.txt` (secrets blanked, `max_bytes`, `max_per_day`, injection hold, dedupe, extraction). whisper.cpp's timestamps and tags like `[BLANK_AUDIO]` are dropped first.
- The audio is never copied into the brain or a queued op. It moves to `done/<date>/` in the drop folder, which is the owner's own storage, like any other file there.
- A transcriber that fails, hears nothing, or is misconfigured moves the file to `failed/` with the reason. Move it back to retry.
- In the drop folder, audio over `max_bytes` is refused without being read. `capture --voice` doesn't check the size.
- On a replica, the machine that reads the folder transcribes; only the text is queued as the op.
- A hosted call is recorded in `log/usage.jsonl` as step `capture.transcribe` and honours the monthly and step caps ([usage.md](usage.md)). It has no token price: it costs 0 there unless `usage.prices.model_minute` is set (wall seconds). A local command isn't metered.

## On a replica: everything queues as a signed op

With `rules/hub.yaml`, only the hub commits brain changes ([hub.md](hub.md)). A replica used to refuse capture, upkeep and inbox decisions. It now queues them in `ops/<replica>/<ulid>.json`, committed and signed by that machine, and the hub applies them on its next sync:

| Op (`op:`) | Queued by | The hub does |
|---|---|---|
| unset / `write` | `write()` | `write()`, as before |
| `capture` | any capture on a replica (CLI, drop folder, mailbox) | stores it (all checks above run again on the hub); extraction at the hub's next capture tick |
| `inbox` | `inbox --accept/--reject`, the dashboard's buttons (Approve, Reject, Release, Discard), `capture release/discard`, a text reply | `decideProposal` or `decideCapture` as the owner; already answered is a no-op |
| `upkeep` | `upkeep [--live …]` | runs the rule passes on its own current notes, plus the replica's recorded live rechecks (same run id, so `undo --run` works) |

Upkeep on a replica changes nothing locally. It records what each live source said about each fact, as data (`{ "<id>#<attr>": { value, ref } }`). The hub re-judges each against its own current value: a confirmation of a value that has since changed becomes a contradiction, which is escalated, never settled.

The hub refuses an op when:

- it isn't in a commit signed by the replica's key, or the commit touches anything outside `ops/<replica>/` (as before);
- `may_write_as` in hub.yaml doesn't list its author. A phone replica limited to `[instinct]` can't queue the owner's inbox answers or their drop-folder captures;
- a drop-folder or CLI capture names anyone but the owner, or an agent capture comes from an agent not in `capture.agents`;
- an inbox op isn't the owner's, or an upkeep op isn't `reflect`'s.

## What still needs a live run

- **A live extraction model.** All tests use the fake adapter. The prompt, the JSON shape and the grounding checks are tested; how well a real model lists facts is not. Set `steps.capture.extract` in `rules/models.yaml` and a key, then run `pocketbrain capture --text "…"` on a copy of the brain.
- **AgentMail.** The capture inbox reader uses the same REST shape as the relay and has never run against a live account. Maildir is tested end to end.
- **A live transcriber.** Tests use a fake whisper-style script and a fake hosted API on a generated WAV. Install whisper.cpp on the Mac, set the step, and drop a test memo before relying on it.
- **The storage service.** The drop folder is a plain folder in tests. Check how the service writes files (temporary names, partial writes) on the owner's Mac before relying on the 10-second settle.

## Not built

- Agent logs and relay decisions on a replica still commit directly, so they are refused there.
