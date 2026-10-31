// SPDX-License-Identifier: AGPL-3.0-only
// List prices per million tokens, in USD, for turning a reply's token counts into money (the
// meter and spend caps). A model not listed has no price: costOf returns undefined, and the
// caller says "unpriced" rather than guessing. Self-hosted models (openai-compatible) cost 0
// per token here; their cost is the machine, not the call.
// Sources: Anthropic's model table as of 2026-10-06; TypeSafe's docs as of 2026-09-19 (input
// only, output free). Re-check when adding a model. Cache discounts are ignored: pocketBrain
// doesn't use prompt caching, so every input token is billed at the full rate.
import type { Provider, Usage } from "./model";

export interface Price { input: number; output: number } // USD per million tokens

export const PRICES: Partial<Record<Provider, Record<string, Price>>> = {
  anthropic: {
    "claude-fable-5-1": { input: 10, output: 50 },
    "claude-opus-5-5": { input: 4, output: 20 },
    "claude-opus-5": { input: 5, output: 25 },
    "claude-sonnet-5-5": { input: 2, output: 10 },
    "claude-sonnet-5": { input: 2, output: 10 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5 }, // prompts up to 100K tokens; 0.5 / 2.5 beyond
    "claude-haiku-4-5": { input: 1, output: 5 },
  },
  typesafe: { "jev-latest": { input: 0.042, output: 0 } },
};

// Providers answer with a dated or versioned id ("jev-1.13.0" for "jev-latest"); match the
// requested model first, then the served one, then the longest listed prefix of the served one.
export function priceFor(provider: Provider, model: string, served?: string): Price | undefined {
  if (provider === "openai-compatible" || provider === "fake") return { input: 0, output: 0 };
  const table = PRICES[provider];
  if (!table) return undefined;
  if (table[model]) return table[model];
  if (served && table[served]) return table[served];
  if (provider === "typesafe") return table["jev-latest"]; // one price for every Jev version
  const key = Object.keys(table).filter((k) => served?.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : undefined;
}

export function costOf(provider: Provider, model: string, usage: Usage | undefined, served?: string): number | undefined {
  const p = priceFor(provider, model, served);
  if (!p || !usage) return undefined;
  return (usage.input_tokens * p.input + usage.output_tokens * p.output) / 1e6;
}

// The cheaper model a job falls back to past its daily cap (backlog 272): the cheapest priced model
// of the same provider, so the same key works, and only if it costs less than the one asked for.
export function cheaperModel(provider: Provider, model: string): string | undefined {
  const table = PRICES[provider];
  const cur = table?.[model];
  if (!table || !cur) return undefined;
  const cost = (p: Price) => p.input + p.output;
  const best = Object.entries(table).filter(([, p]) => cost(p) < cost(cur)).sort(([, a], [, b]) => cost(a) - cost(b))[0];
  return best?.[0];
}
