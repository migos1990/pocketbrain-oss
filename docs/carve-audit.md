# Carve audit and write-path fuzz

Two checks that the sharing limits still hold after weeks of real use: one on the live brain (did anyone's reach grow without the owner?), one on the code (can a strange request get past the write path?).

## The weekly carve audit

```sh
pocketbrain audit carve            # report, record a snapshot, alert on anything the owner didn't do
pocketbrain audit carve --dry-run  # report only
pocketbrain audit carve --json
```

`start` runs it every Sunday after the nightly pass. For each agent it compares, with the last snapshot in `log/carve-audit.jsonl` (the first time: the brain as committed a week ago, or its first commit):

- the grant: slices, `max_sensitivity` (the tier's ceiling when unset), tier, `exclude_types`, `exclude`, `inside_wall`, the kill switch, being the owner's editor or the resolver, and new agents;
- what the carve shows: notes that existed before and are now visible, and facts (so `share_with` and per-fact sensitivity count) that existed before and are now visible.

New notes and new facts are not widenings. Each widening is traced to commits since the baseline: `rules/` when the old rules, applied to today's notes, would not have shown it; the note's own file otherwise (a hand edit that drops a tag or lowers a level). A widening is fine only when every one of those commits is authored by the owner (`owner`, `louis` or `owner.name`) and nothing on those paths is uncommitted. Anything else (an agent's rules commit, an uncommitted edit, a note edit by an agent, a change no commit explains) is one `carve_widened` alert per agent, so it shows under Needs-you in the digest, dashboard and text channel. The digest's numbers also carry the last audit's line.

Limits: git authorship is what the audit trusts. Commits made by hand with someone else's name pass as theirs; on a hub, `pocketbrain doctor` checks signatures. Being strict, a rules commit by anyone other than the owner fails every widening on rules in that week, even one the owner made in another commit.

## The write-path fuzz

`test/fuzz-write.test.ts` sends seeded random and mutated `remember` bodies from every agent at the fixture brain: odd Unicode, 100k-character strings, wrong types, null bytes, deep objects, traversal ids (`../`, `rules/`, `agents/<other>/`), bad dates, refs with spaces, and carved values in every field. After each one: no crash (only a refusal or a 4xx), nothing committed under `rules/` or outside the content folders, no file outside the brain, a refused write changes nothing, every change is committed and authored by the writer, and no value carved from the writer is committed into a note. `PB_FUZZ_N` sets the count (default 150, about 10 s), `PB_FUZZ_SEED` the seed, `PB_FUZZ_VERBOSE=1` prints outcomes and checks. Run a few other seeds after changing the write path.

Its first runs found eval gaps G21 (wrong-typed fields, a null byte or the attribute `constructor` crashed `remember` with a 500) and G22 (a carved value written as an attribute name or a source ref reached a shared note). Both are fixed and kept as `rt-fuzz-*` cases in `evals/cases/redteam.ts`.
