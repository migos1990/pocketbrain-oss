# Contributing to pocketBrain

pocketBrain is a prototype, published so people can read how it works.

- **Issues and discussion are welcome now**, including ones that challenge a design choice. Use the fictional brain in `examples/brain` for any example; never post personal notes, tokens or logs.
- **Code contributions open once the contributor agreement is ready.** It is being reviewed; until then, pull requests can't be merged. A pull request is still a fine way to show an idea.

When code contributions open:

- Run `bun run typecheck`, `bun test` and `PB_CELLS=1 bun test` before opening a pull request.
- Anything on the enforcement path (carve, write checks, relay, server, cells) needs a test; `test/security.test.ts` holds the attacks that must keep failing.
- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-only`.
- Working on the code as an agent? Read [CLAUDE.md](CLAUDE.md) first.
