---
name: reflect
description: End of session, propose durable learnings (tips, rules, skills) for the harness instead of losing them
disable-model-invocation: true
---

Look back over this session (focus: $ARGUMENTS) and list what a future session on this repo would want to know: a correction Louis made, a command that failed and its fix, a trap, a check that should have been automatic.

For each, pick the cheapest home that holds:
- **Must never slip** → propose a rule for `.claude/hooks/guard.ts` with a test in `test/guard.test.ts`. Don't edit guard.ts or `.claude/settings.json` yourself; the guard blocks it and Louis owns them.
- **Repeatable procedure** → propose a command or skill under `.claude/`.
- **One-line habit** → propose a line for CLAUDE.md.
- **Anything else worth keeping** → a row for the Inbox table of the project's living tips list (`harness-tips.md` in the project's design docs), with date, tip, where it came from and why.

Print the proposals as a short table. Write nothing until Louis says which to keep. Never include secrets, tokens or real brain content.
