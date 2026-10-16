# pocketBrain: bootstrapping from Notion

> **Design record from 2026-10-08, kept for history.** It was written before the code and is not kept up to date. Current behaviour is in the [README](../../README.md), [CLAUDE.md](../../CLAUDE.md) and the guides in [docs/](..).

> Status: draft, 2026-10-08, aligned with memory-shape.md the same day. Owner: the "Bootstrapping" thread. The on-disk format is owned by the "Memory shape on disk" thread ([memory-shape.md](memory-shape.md)); where this file names a frontmatter field, memory-shape.md wins if they disagree. Builds on [architecture.md](architecture.md) section 0 (phase 0 starts with "Export Notion to Markdown") and the Notion mapping (private, not published).

## TL;DR

- **One import, run by Claude through the Notion MCP, plus a Notion-native export zip as an untouched backup.** The import is a script over a raw JSON snapshot, so it is repeatable and keyed on the Notion page id: running it twice changes nothing.
- **The hard part isn't the export, it's the cleanup.** The real workspace has fact keys in four styles, per-field sources hidden in page bodies, free-text "relations", logging dates posing as event dates, and corrupted Fingerprint lines. So the import is two passes (as memory-shape.md section 10 also concludes): a mechanical pass, then a reviewed extraction from the page bodies. Louis reviews a one-page import report.
- **Recommended for Notion afterwards: freeze it, then retire it.** At cutover, agents lose write access to the Second Brain page, a banner says where the brain lives now, and it stays readable for Louis for one month (the phase 1 gate). Then the export zip is archived and the page is moved to trash. Not a live mirror, and never two-way.

## 1. What is actually in Notion (checked 2026-10-08)

Read through the Notion MCP. Counts from the Notion mapping (private, not published); the People details below were verified row by row.

| Source | Rows | Goes to |
|---|---|---|
| Decisions | 7 (3 sensitive) | `decisions/` |
| Projects | 19 (5 sensitive) | `projects/` |
| People and contacts | 24 (verified) | `people/`, plus `orgs/` (Notion's free-text Org becomes an entity) |
| Research and notes | 13 (incl. Vamprose wiki dumps, 1 procedure) | `notes/` |
| Money | 4 (all sensitive) | `money/` |
| Receipts and expenses | 0 | nothing (no empty folder) |
| **Content total** | **67** | |
| Agent capabilities | ~30 | `agents/<agent>/` |
| Start page rules, Agent hierarchy, Agent safety and tests | 3 pages | hand-drafted `rules/RULES.md`, `rules/policy.yaml`, `rules/checks.yaml` for Louis to approve |
| Agent comms (message log + claims table) | 1 page | `comms/archive/notion-agent-comms.md`, one file, as history |

### What the real rows look like (problems the converter must handle)

1. **Fact keys in several styles.** Vamprose writes `person:sam-okafor`; Instinct writes `instinct\:people\:pat-lindqvist` (escaped colons, agent name as prefix); memory-shape found four styles in all. None are reused: the file id is its path (`people/sam-okafor`) and fact keys derive as `<id>#<attribute>`. The old key and the Notion page id go in `legacy:`, which is what makes re-import a no-op.
2. **The best sources are in the page body, not the properties.** Example: Robin Castell's row-level Source is "Instinct memory note entities/people/robin-brightpath", but the body says his surname and role came from Gmail `0000aaaa1111bb01`, and one claim has "no exact reference located". If only properties are imported, every fact inherits the weakest source. So each page body is fetched, and per-field sources are lifted into that field's `facts:` entry (see step 4).
3. **Relations are free text.** "Related project" holds titles like `Northfield COURSE 101`, `Initech offer decision`, `Maple Trust Bank migration`. Some match a Projects row title, some match nothing. The converter links exact or near-exact title matches and lists the rest in the report.
4. **Fingerprint is unreliable text.** Lines are joined with `<br>`, pipes are escaped, and one row (the Lisbon trip) is already corrupted with literal `n`s. It is not kept as data: the verbatim text goes in that file's import commit message, and `by`, `created` and `updated` are read from it.
4b. **`Valid from` is not event time.** It is 2026-10-04 on every row, the day the column was added, and `Date` means different things per row. `as_of` comes from the cited source's date, else Notion `Date` with `as_of_approx: true`.
5. **Co-authored rows.** Several rows were created by Instinct and edited by Vamprose (Jordan Pike, Robin Castell). `Author agent` names only one. Agent names go through one alias map (Vamprose, "Vamprose / Town" and Town all become `town`), body claims keep their own source as a footnote, and area ownership in `policy.yaml` decides who owns the file from now on.
5b. **Duplicates across databases.** The "Northfield Oct 11 session move" decision duplicates the Northfield project row. It is imported with `status: merged` and `merged_into:` the project. Its "Oct 6" session date is also wrong (the course is on Mondays, so Oct 5) and goes in the report for Louis.
6. **Statuses and confidence vary per database.** People has only `Active`; Agent capabilities uses High/Medium/Low instead of Stated/Inferred/Unverified. The converter maps every value through one table and refuses unknown values instead of guessing.
7. **Muse's trashed duplicates (6 rows, 2026-10-04)** are in Notion's trash, not live. Not imported.
8. **Rate limits.** The MCP's SQL query mode hit the workspace usage limit during this check. View mode and page fetches don't count against it, so the importer uses those (one view query per database, one fetch per page, about 100 calls in total).

## 2. The import, step by step

All of this runs inside the wall (Claude Code with repo access), per architecture 0.1.

| # | Step | Output | Who |
|---|---|---|---|
| 0 | **Announce and pause writers.** Post in Agent comms that the brain is moving and ask Town to pause its daily sync and Muse to stop writing. Louis turns the agents' Notion connections to read-only, or just tells them. | quiet workspace | Louis (approve the post), Claude drafts it |
| 1 | **Backup snapshot.** Louis runs Notion's own export (Settings, Export, Markdown & CSV, include subpages) on the Second Brain page. | `import/notion-2026-10-xx.zip`, never edited | Louis, 2 minutes |
| 2 | **Raw snapshot through the MCP.** For each database: one view-mode query for all properties. For each row and each coordination page: one fetch for the body, plus comments. Saved as-is. | `import/raw/<db>/<notion_id>.json` | Claude |
| 3 | **Pass 1, mechanical.** A deterministic script turns raw JSON into one Markdown file per row in the memory-shape format, using the mapping in section 3. Body copied whole, `legacy` set, every date `as_of_approx`. No LLM in this step, so re-running it gives byte-identical output. | `decisions/ projects/ people/ orgs/ notes/ money/ agents/` | script |
| 4 | **Pass 2, reviewed extraction.** The judgement step. Shelf-life facts that live in page bodies (Town appended sections to 27 rows) move into `facts:` with the source the body cites; other body claims stay prose with footnoted sources. Example: Robin Castell's role gets Gmail `0000aaaa1111bb01`, not the vague row-level Instinct note. Nothing becomes "Confirmed by Louis" unless a message from Louis is cited. Rules found inside notes (the "Hard rules" in the communication-style note) are proposed into `rules/RULES.md`, not imported as content. Every change is listed in the report. | separate commit on top of pass 1 | Claude |
| 5 | **Resolve entities and links.** Match people across the two key styles and by name and email so no person exists twice. Resolve "Related project" titles to project ids. Anything ambiguous is left unlinked and listed. | links in frontmatter | script + Claude |
| 6 | **Run the write-path checks** (architecture 0.6) on every file: schema valid, source present, key well formed, no secret-shaped strings, no Northfield student data. A failing row is still imported, marked `verification: unverified` and `freshness: due`, and listed. Nothing is dropped silently. | check results | script |
| 7 | **Reconcile.** Every Notion page id appears in exactly one file (`legacy.notion`), counts per folder match section 1, sensitive rows kept their level. | pass/fail lines | script |
| 8 | **Import report for Louis.** One page: counts, rows with no usable source, links that didn't resolve, key collisions, facts whose source was upgraded in step 4, and the drafted `rules/` files. | `import/REPORT.md` | Claude |
| 9 | **Louis reviews and approves** `rules/` (only Louis edits rules) and skims the report. | approval | Louis |
| 10 | **Commit and cut over.** Three commits: raw snapshot, pass 1, pass 2. Then the Notion freeze (section 4). Phase 0's per-agent views are built from this commit. | brain repo at v0 | Claude, then Louis for the freeze |

**Idempotency.** Every file carries the Notion page id in `legacy.notion`. Running steps 2 to 7 again (for example if Town wrote something during the window) updates only rows whose raw JSON changed, and the write path treats same-value writes as no-ops. That makes a delta re-import before the freeze cheap and safe.

**Sensitive rows.** The 4 Money rows and the sensitive Decisions and Projects rows keep their `Sensitive` flag mapped to a sensitivity level. Money rows are checked for full account numbers before commit (the Notion rules already forbid them, but nothing enforced it). The raw snapshot is in the private repo only, never in a view.

## 3. Field mapping

The authoritative mapping is in [memory-shape.md](memory-shape.md) sections 8 (nine real rows converted) and 8.9 (patterns). In short:

| Notion property | pocketBrain | Note |
|---|---|---|
| page id, old Fact key | `legacy: { notion, fact_key }` | the import key; never used as a live key |
| Name / title | file path id (a slug that never changes) + `title`; renames go in `aliases` | |
| Source type | dropped | the scheme of the ref is the type (`gmail:`, `gcal:`, `imsg:`, `instinct-mem:`); Notion's types are often wrong |
| Source, Original source lineage | `sources: [{ ref, via }]` | Gmail `m1.<base64>` refs decoded to hex so one email can't count twice |
| Author agent | `by`, through the alias map | identity from now on is the committer |
| Fingerprint | import commit message only; `created`, `updated` derived | |
| Valid from, Date | `as_of` from the source's date, else Date with `as_of_approx: true` | Valid from ignored |
| Confidence | `confidence: stated / inferred` | Notion "Unverified" moves to `verification` |
| Verification | `verification` | capabilities' High/Medium/Low become `self-reported` |
| Sensitive | `private` when checked; Money private by default | |
| Review after | not stored | computed from shelf life |
| Status, Supersedes | `status`; Supersedes is empty everywhere | fact history starts at import |
| Related project, Org | wiki links to entity ids | unresolved ones listed in the report |
| Page body | Markdown body, sources as footnotes | shelf-life facts lifted in pass 2 |
| Comments | appended under a `## Notion comments` heading | |

## 4. What happens to Notion afterwards

### Options

| Option | What it means | Verdict |
|---|---|---|
| **A. Freeze, then retire** | At cutover, remove agents' Notion access to the Second Brain page and add a banner pointing to the repo. Louis can still read it for one month. Then archive the export zip and trash the page. | **Recommended** |
| B. Keep as a read-only view | A one-way sync renders the repo back into Notion so Louis can keep browsing there. | Not in v1. Comes back only if Louis finds he misses browsing in Notion. |
| C. Keep two-way | Agents and Louis keep editing Notion and a sync merges both ways. | No |

### Why A

- **One truth or none.** Every Notion pain point (labels instead of access control, typed author names, convention-only "append, never delete") comes from Notion being the place agents write. As long as an agent can still write there, some fact will land in Notion and not in the repo, and the two will drift. Removing write access is what actually ends the old system, not a banner.
- **Option B is code with no named need.** A repo-to-Notion renderer is a component to build and maintain before phase 1 has even shown the repo works. Section 0 says nothing gets built without a trigger; the trigger here would be "Louis keeps opening Notion to look something up". If that happens during the month, B is cheap to add then, from the same converter run in reverse.
- **Option C reintroduces everything v1 removed.** Two writable copies means conflicts, sync loops and duplicates, exactly what Town's daily sync and Muse's duplicates already showed.
- **One month of read access is the safety net.** It matches the phase 1 gate ("used daily for a month"). If something was lost in the import, Louis can still look it up and the importer can re-run as a delta. After that, the zip in the repo is the record.

### Freeze checklist (Louis's actions, nothing irreversible until the last line)

1. Agents' Notion connections lose access to the Second Brain page (or the integrations are removed from it). Notion has no per-page "read-only for this integration" setting for every vendor, so removing access is the reliable way.
2. Banner at the top of the start page: "Frozen 2026-10-xx. The brain now lives in the pocketBrain repo. Don't write here."
3. Each assistant's instructions switch from "read the Notion start page" to its pocketBrain instruction block (architecture 0.1, "Per-vendor instructions"). This is the step that makes the switch real for the agents.
4. After a month with no lookups that the repo couldn't answer: export zip stays in `import/`, Second Brain page moves to trash. Notion keeps trash for 30 days, so even that is recoverable for a while.

## 5. Open points

- **Who sends the "pause" note to Town and Muse.** Default: Claude drafts the Agent comms post, Louis approves it, since it's a message to other agents.
- **Agent capabilities and the coordination pages** are converted by hand into `agents/` and draft `rules/` files rather than by the script, because they are rules and roles, not facts. Louis approves `rules/` before it takes effect.
