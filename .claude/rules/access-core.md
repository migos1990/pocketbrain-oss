---
paths:
  - "src/carve.ts"
  - "src/write.ts"
  - "src/checks.ts"
  - "src/auth.ts"
  - "src/oauth.ts"
  - "src/cell.ts"
  - "src/view.ts"
  - "src/relay.ts"
---

# Access core: who sees and writes what

You are editing code that decides what an agent can see or write. A bug here leaks a slice.

- Deterministic checks never depend on a model; a model's answer may only tighten or flag.
- Every behaviour change ships with a test that fails before it, and `bun evals/run.ts` stays green (red team included).
- A red-team or review finding becomes a case in `evals/gaps.ts` before merge, then is marked closed.
- `[withheld]`, `[[redacted]]` and "not in your view" must stay indistinguishable from absence to the agent.
