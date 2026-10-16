# Model spend caps

The brain's own model steps cost the owner money: sleep consolidation, the duplicate judge, capture and the dashboard's Ask. This puts a cap on that bill, per month and per step, and tells the owner when it is near or reached.

Reads and writes are **never** metered, capped or held. On the owner's own machine a meter in the read or write path is one `git revert` away, and it would discourage the reading the product depends on. Billing for a hosted offer, if any, belongs in that service and counts only what it operates: requests through its door, model credits it sells, hosted compute. The owner's pricing decision (pure usage, 2026-10-08) is applied there, not here.

## What is recorded

Every call through `modelFor()` / `metered()` is one line in `log/usage.jsonl`: the step, who ran it, provider and model, tokens in and out (as the provider reports them, or estimated from text length and marked `~`), wall seconds, and the cost. Tokens are priced at the model's list price in `src/pricing.ts` (a local model costs 0), unless the owner overrides it; a model with no listed price is marked unpriced and counts as 0 until a price is set. Lines are hash-chained like `log/reads.jsonl`, so `verifyChain` shows an edited or dropped line. A failed call is recorded too, since a provider may still bill it.

## Configuration (owner only, `rules/policy.yaml`)

```yaml
usage:
  currency: USD
  prices: { model_minute: 0 }   # optional; model_input_per_million / model_output_per_million override src/pricing.ts
  cap: { monthly: 20, alert_at: 0.8, steps: { capture.extract: 5 } }
```

Without a `usage:` block calls are still recorded, at a price of 0, with no cap.

## Past a cap

- The monthly cap pauses every model step; a step cap pauses only that step.
- Sleep carries on without its model and says so in the morning note; `judge` and `capture` refuse with the reason; Ask on the dashboard shows it.
- The relay's request check (`relay.flag`, when turned on) can't run, so agent mail it would read is held for the owner with the same reason as any check that couldn't read a message; mail the code checks decide alone moves as before.
- Reads, writes, the relay's code checks and every deterministic check carry on untouched.
- The owner hears at `alert_at` and at the cap: a line at the top of the digest (with amounts), a banner on the dashboard, and a text-channel item.

Raising the cap (dashboard Spend page, or policy.yaml) resumes at once.

## Agents never see it

- No orientation text, tool description, tool result, API route or error changes with the cap: `test/usage.test.ts` and `evals/cases/usage.ts` (`usage-invisible`) run every MCP tool and API route for every agent with no cap, under it and over it, and require identical answers.
- Cells never carry the `usage:` block (`buildCell` writes its own minimal policy).
- The text channel's transport is an agent (Instinct), so its item says only "Account notice: open the dashboard". Amounts appear only in the digest and on the dashboard.

## For the owner

- `pocketbrain usage [--month YYYY-MM] [--json]`: per day and per step, against the caps.
- `pocketbrain models [--json]`: which model each step runs on. Executor steps (capture, nightly consolidation, the check after each write, the duplicates judge) default to `claude-haiku-5-5`; the `review` role (`claude-opus-5-5`) has no step; a step's own line under `steps:` in `rules/models.yaml` picks its model, and `roles:` changes a whole role's model (README, "Models (bring your own)").
- Dashboard → Spend: the month against the cap, by step and by day, the price sheet, and a field to set or remove the cap (a commit to policy.yaml by the owner).
- `bun scripts/usage-day.ts [--brain <repo>]`: one scripted day on a throwaway copy: the request volumes a hosted door would count, and the model spend.
