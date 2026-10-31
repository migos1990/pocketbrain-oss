# Checks after a write

When an agent's write commits, the agent gets its answer straight away. Two checks then run in the background on the hub (`src/aftercheck.ts`). Both can only add a "Needs you" item or make a fact more private. They never block, slow, lower or undo a write, and the write path's own rules stay the floor.

| | Quick gardener | Second-opinion classifier |
|---|---|---|
| Model step | `write.conflicts` (executor role, default `claude-haiku-5-5`) | `write.classify` (default TypeSafe `jev-latest`, 3 s timeout) |
| On by default | Yes, when its model has a key | **No.** Turn it on with `pocketbrain aftercheck classify on --cap 1` (sets `aftercheck: { classify: true }` and a $1 a month cap for the step in `rules/policy.yaml`, one owner commit; `off` turns it off and keeps the cap) |
| What it sends | The new fact and the 5 closest notes (BM25), as a carve at the step's `max_sensitivity` | The new fact, its note title, type and area. Never above `personal`, whatever `models.yaml` says |
| What it asks | Does the fact contradict or duplicate something in another note or under another key? | Another person's health, schooling, exams, professional licensing or discipline, legal matter or money? Which category? How sensitive? Which area? |
| A confident answer | A Needs-you alert (`write_conflict`) | At 0.5 or more on a third party's matter or a category, the fact is made private (a third party's matter is also shared with the resolver only), committed by `gardener`. The digest lists each one under "Done automatically" (`made private: <fact>, <model> 0.92`); `git revert` undoes it. A higher sensitivity level needs 0.8 |
| An unsure answer | Nothing | A Needs-you alert (`classify_review`): a third party's matter at 0.3 to 0.5, or a level under 0.8. Area suggestions are always only alerts |

Private and secret facts, `share_with` facts, list facts, disputed facts and anything secret-shaped are never sent; the nightly pass is where those get looked at.

**When the model is down, slow or over its spend cap**, or its answer is cut off, the write stays exactly as the rules made it. Each step runs on its own: a failed conflict check never stops the classifier, and the key comes back for another try. The check is queued in `log/aftercheck.jsonl`, retried after the next write and in the nightly pass, and dropped after 3 failures. The nightly pass also queues any agent write of the last two days that committed with no queue line after it, which is what a hub restart between the commit and the queue leaves. With no key for a step, the queue clears at once and the rules decide alone.

Both steps are metered like every other model step (`docs/usage.md`) and logged in `log/judgments.jsonl` with the model that answered. Change providers per step in `rules/models.yaml`:

```yaml
steps:
  write.conflicts: { provider: anthropic, model: claude-haiku-5-5 }
  write.classify: { provider: typesafe, model: jev-latest, timeout_ms: 3000 }
```

Turning the classifier on sends fact text, including other people's details at `personal` level, to TypeSafe. Leave it off until the labelled-set scoring shows it catches more than the keyword rules.
