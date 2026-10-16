// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "bun:test";
import { costOf, priceFor } from "../src/pricing";

test("cost from token counts: listed models, versioned replies, self-hosted, unlisted", () => {
  expect(costOf("anthropic", "claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 })).toBeCloseTo(3);
  expect(costOf("typesafe", "jev-latest", { input_tokens: 1350, output_tokens: 0 }, "jev-1.13.0")).toBeCloseTo(0.0000567, 9);
  expect(priceFor("typesafe", "jev-2", "jev-2.0.1")).toEqual({ input: 0.042, output: 0 });
  expect(costOf("openai-compatible", "llama3.1", { input_tokens: 5000, output_tokens: 5000 })).toBe(0);
  expect(costOf("openai", "some-model", { input_tokens: 10, output_tokens: 10 })).toBeUndefined();
  expect(costOf("anthropic", "claude-sonnet-5-5", undefined)).toBeUndefined();
});
