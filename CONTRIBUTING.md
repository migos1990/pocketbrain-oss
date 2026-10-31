# Contributing to pocketBrain

Contributions require signing the Individual CLA in [CLA.md](CLA.md); the maintainer won't merge a pull request until its author has signed (instructions in CLA.md).

- Issues that challenge a design choice are as welcome as code.
- Run `bun run typecheck`, `bun test` and `PB_CELLS=1 bun test` before opening a pull request.
- Anything on the enforcement path (carve, write checks, relay, server, cells) needs a test; `test/security.test.ts` holds the attacks that must keep failing.
- No personal data in fixtures or issues: use the fictional brain in `examples/brain`, or the bigger made-up `examples/demo-brain` for anything on a screen.
- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-only`.
- Working on the code as an agent? Read [CLAUDE.md](CLAUDE.md) first.
