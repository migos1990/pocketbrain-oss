// SPDX-License-Identifier: AGPL-3.0-only
// The model a model-judged step runs on, routed the way the product routes it (rules/models.yaml
// plus the role defaults in src/model.ts), so a step case measures what ships. EVAL_STEP_MODEL
// pins one model for every step case: that is how a paired compare puts two models side by side
//   EVAL_STEP_MODEL=claude-sonnet-5-5 bun evals/run.ts --llm --only steps --k 3 --save-baseline steps
//   bun evals/run.ts --llm --only steps --k 3 --compare steps
// With ANTHROPIC_API_KEY the call goes through the product's own adapter; without one, an
// Anthropic step goes through the `claude` CLI (lib/llm.ts), so it runs wherever Claude Code does.
import { llm } from "./llm";

// pb: the prototype's src/model.ts module at the commit under test.
export function stepModel(pb: any, root: string, step: string, pin = process.env.EVAL_STEP_MODEL) {
  const routed = pb.modelConfigFor(root, step);
  const cfg = pin ? { ...routed, provider: "anthropic", model: pin } : routed;
  if (process.env.ANTHROPIC_API_KEY || cfg.provider !== "anthropic") return pb.makeModel(cfg);
  return {
    config: cfg,
    complete: async (req: { system: string; prompt: string }) => ({ text: await llm(req.system, req.prompt, cfg.model), provider: "anthropic", model: cfg.model }),
  };
}

export const label = (m: { config: { provider: string; model: string } }) => `${m.config.provider}/${m.config.model}`;
