# The demo brain

A made-up life of about 500 facts: the brain the owner's screens and the UI tests are designed against (outside review 2026-10-29). Written by `bun scripts/demo-brain.ts` from `scripts/demo-data.ts`; edit the tables, not these files. Nobody in it is real.

This folder is the brain on 30 September 2026. The UI tests copy it and replay a week on top (`replayWeek` in `scripts/demo-brain.ts`): mail filed, things the owner said, assistants' reads and writes, three conflicts and one private value waiting. To look at it yourself:

```sh
bun scripts/demo-brain.ts --out /tmp/demo && PB_BRAIN=/tmp/demo bun src/cli.ts dashboard
```
