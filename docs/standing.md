# Standing: who matters to the owner

An ask from the owner's partner, a parent, a student and a stranger are not the same ask. Standing tells the owner's assistants how much weight a person's ask carries, so they put family first and never jump at a stranger's request. It is the owner's word, kept in `rules/`, and it changes priority only: it never grants access and never relaxes a check (`src/standing.ts`).

## rules/standing.yaml (owner only)

```yaml
# Who matters to me. Only I edit this file (agents can't: rules/ is read-only to them).
me: [robin@example.com, "+15145550199"]   # my own addresses, so the brain can tell my replies apart
people:
  people/sam-roy: { tier: inner, addresses: [sam@example.com] }    # partner
  people/jane-roy: { tier: known, authority: owner }               # a student: I decide, not her
  people/dean-smith: { tier: close, authority: them }              # my dean: her asks rank high
```

| Tier | Who | What an assistant does with their ask |
|---|---|---|
| `inner` | partner, parents, family | First, the same day. Never batched behind anything else. |
| `close` | close friends, the people the owner relies on | Soon, ahead of routine work. |
| `known` | people the owner deals with: colleagues, students, clients | Normal priority. |
| (anyone else) | not in the file, or not in the assistant's view | Unknown: don't act quickly. No commitment of the owner's time, money or information; batch it for the owner. |

`authority` is optional: `owner` when the owner holds authority over the person (a teacher over a student, a manager over a report), so their asks are requests to the owner and an assistant concedes nothing on the owner's behalf; `them` when the person holds authority over the owner (a dean, a manager), so their asks rank higher within the tier.

Set it with the CLI rather than by hand:

- `pocketbrain standing set <person> <inner|close|known|none> [--authority owner|them|none] [--pin a,b]` writes the line as an owner commit, on the hub only (a replica refuses before writing anything). For `inner` and `close` it pins the addresses you confirmed on the person's note, keeps earlier pins, and adds the source-verified addresses you name with `--pin`; it lists the source-verified ones it left unpinned. Re-running keeps the authority unless you give one (`none` clears it). It also records the note's `created` date, so a note deleted and later recreated under the same id (say, by an assistant) doesn't inherit the standing.
- `pocketbrain standing list` shows the file, entries whose tier it doesn't understand (not applied), entries whose note is gone or was replaced (not applied; the digest flags them too), and warns when `me:` is empty.

## What an assistant sees

- On a person note it can see, one line under the title: `standing: inner` (and `· the owner holds authority` or `· holds authority over the owner`). Never the reasons, never the signals, never `me:`.
- Standing counts as a personal-level attribute named `standing`. A slice with `only_attributes` shares it only if it lists `standing`; `exclude_attributes: [standing]` or an agent `exclude: [<id>#standing]` holds it back; an agent whose ceiling is below personal never sees it.
- `who_is` (MCP) or `GET /v1/who?address=…` (JSON API): given the address or number a message came from, the person it belongs to in the assistant's view, their standing and what to do. The answer's tier is `inner`, `close`, `known`, `unlisted` (a person in its view with no standing it can see) or `unknown` (nobody in its view has that address). A person the assistant can't see answers exactly like nobody. If two people share an address, the lower standing wins.
- The orientation guide has a "Who is asking" section that tells the assistant to call `who_is` before acting on a message, and how to weigh each tier. The gardener doesn't get it.

## Standing never relaxes a check

- **Addresses only, never names.** `who_is` reads the address inside `Name <address>` and ignores the display name. "Mom" from an unknown address is unknown.
- **Only trusted addresses.** An address counts only if it is a visible `emails`/`phones` fact (or any attribute normalized as email or e164) that is current and `confirmed-by-owner` or `verified-by-source`. Self-reported and unverified addresses never match.
- **Top tiers need a pinned address.** For `inner` and `close`, the address must also be pinned in `standing.yaml` (`addresses:`). `standing set` pins only addresses the owner confirmed, plus any source-verified ones the owner names with `--pin` (a forged email can make an address source-verified, so it is never pinned silently). An address added later by an assistant matches as `known` at most, without `authority: them`, until the owner pins it. A stranger can't climb to the top by getting an address written onto Mom's note.
- **A pinned address stays with its person.** If an assistant writes Mom's pinned address onto another person's note, `who_is` still answers Mom. Otherwise, when two people share an address, the lower standing wins.
- **Agents can't raise anyone.** `rules/` is read-only to agents, and the write path refuses a fact named `standing` on any note, through `remember` or `retire` (check `reserved_attribute`, always on). The real line sits right under the note's title; a note's text can still contain the words "standing: inner", like any other data an agent must not take as an instruction.
- **Nothing reads standing to decide a check.** The relay, captures, pulls, injection and secret checks, held mail and "claimed to be you" work the same for the owner's mother as for a stranger. Standing changes how fast and how far an assistant responds, nothing else. `test/standing.test.ts` pins the only files that may import `src/standing.ts` or read `rules.standing` (`STANDING_READERS`): they show, record or set standing, and none of them decides a check (`pull.ts` only records who wrote; `quizplan.ts` only orders the belief radar's questions; `passport.ts` only copies `rules/standing.yaml` into the owner's export bundle).
- **Ask to see.** A note released once by an approved ask (`docs/ask-to-see.md`) is shown whole, standing line included, like its facts.
- **Cells.** An agent's cell gets its own `rules/standing.yaml` holding only the people whose standing it can see, with only the pinned addresses it can already see as values. Never `me:`.

## Suggestions from the owner's own traffic

The owner sets the top tiers. For everyone else the brain suggests, and the owner approves.

- Each new item a source pull reads from mail or texts (`gmail`, `mail`, `imessage` sources; only items inside the source's `where:` allowlist) adds one interaction to `log/standing/contacts.json`: the other party's address, whether it came in or went out, and when. No text, no subject. Items are counted oldest first after the pass, whatever order the source lists them in.
- The direction comes from the source, not the From line: Gmail's `SENT` label, a mail folder named Sent, or a text from the owner. Mail that claims to come from one of the owner's `me:` addresses but wasn't sent by them is forged and counts for nothing. So a Gmail source feeds the owner's replies only if its `where:` allowlist includes `SENT`.
- `pocketbrain standing suggest` matches each address to a person note through trusted addresses and proposes:
  - `close`: the owner wrote to them at least 10 times, at least half as often as they wrote to the owner, and usually replied within 4 hours;
  - `known`: at least 4 messages either way, at least one from the owner.
  Never `inner`: only the owner names family. Never anyone already in `standing.yaml`: the owner's word stands.
- `pocketbrain standing approve <person>` (or the dashboard's Who matters page) applies a suggestion (an owner commit); nothing applies on its own. The digest's "Worth a look" says how many suggestions wait.
- `log/standing/contacts.json` is local and never committed. It holds counts, first and last times, and the last 20 reply delays per address.

## The dashboard's Who matters page

`/people` on the owner dashboard (`src/dashboard/people.ts`) does everything above in one click per person, each button an owner commit through `setStanding`, like the CLI:

- **Suggested**: each suggestion with its reason. *Make close* (or *Make known*) applies exactly what was suggested; the level picker next to it starts on the suggested level, never on inner circle; Each suggestion names the addresses its counts came from and whether the owner confirmed each one or only a source did (a forged message can make an address source-verified). A click applies only the level that was on screen: if the signals moved since, it is refused and nothing changes. *Not now* hides that person at that level; a higher level is still suggested, and a dismissed close stays hidden until *Suggest again* or the note is replaced (kept in `log/standing/dismissed.json`, local, never committed; nothing is written to `rules/`).
- **Your list**: everyone placed, inner circle first, with the addresses that are pinned. Change the level or authority, Remove, or pin a source-verified address the note already has (asks first: a forged message can put an address there).
- **Add someone**: any person note not yet on the list, at any level. This is where the owner names their inner circle.
- Overview's *Needs you* shows one line when suggestions wait. On a replica the buttons say where standing is set and write nothing.

## Not built yet

- Weighing pulled proposals or held items by the sender's standing in the digest and the text channel.
- Live fetchers: until a source pulls live, suggestions come only from fixture pulls.
- Discord and calendar invites don't feed suggestions (no address to match).
