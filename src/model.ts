// SPDX-License-Identifier: AGPL-3.0-only
// Bring-your-own model (Louis, 2026-10-08). Every model-judged step goes through this one
// adapter; the provider and model come from rules/models.yaml, keys from the environment.
// Deterministic checks never call it. A model's answer only ever produces review items
// for Louis: it can't write facts, merge notes or loosen a rule.
import { sha256, appendJsonl } from "./util";
import { join } from "node:path";
import type { Sensitivity } from "./brain";
import { costOf } from "./pricing";
import { readYaml } from "./rules";

export type Provider = "anthropic" | "openai" | "gemini" | "openai-compatible" | "typesafe" | "fake";

export interface ModelConfig {
  provider: Provider;
  model: string;
  base_url?: string; // openai-compatible: Ollama, vLLM, OpenRouter, Azure…
  api_key_env?: string; // which env var holds the key (defaults per provider)
  max_sensitivity?: Sensitivity; // the most sensitive note this step may send to the model
  max_tokens?: number;
  timeout_ms?: number; // per call; default 10 s for typesafe, 120 s otherwise
}

export interface ModelRequest { system: string; prompt: string; maxTokens?: number }
export interface ModelReply { text: string; provider: Provider; model: string; usage?: Usage } // model: the one that answered, when the provider says
export interface Model { config: ModelConfig; complete(req: ModelRequest): Promise<ModelReply>; decide?(req: DecisionRequest): Promise<DecisionReply> }

// Typed decisions (TypeSafe AI's System One API, model "Jev"): one piece of state, a few typed
// questions, and answers that come back with probabilities instead of free text. A choice
// answer has a confidence from 0 to 1; a "noul" (yes/no) answer is the probability of yes; a
// "score" answer places the state on an ordered list of levels.
// Shape checked against a client that runs against the live API (POST /v1/systemone, model
// jev-1.13.0 answering for jev-latest, 2026-09). Jev reads questions literally: give a noul
// question criteria.false naming what does NOT count (figurative uses, look-alikes), or it
// over-matches.
export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> } // option -> what it means
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "score"; instructions: string; criteria: string[] }; // ordered levels, lowest first
export interface DecisionRequest { state: string; questions: Record<string, Question> }
export interface Answer { type: string; choice?: string; probabilities?: Record<string, number>; confidence?: number; noul?: number; score?: number }
export interface DecisionReply { answers: Record<string, Answer>; provider: Provider; model: string; usage?: Usage }

// Token counts as the provider reported them; absent when it reported none.
export interface Usage { input_tokens: number; output_tokens: number }

const DEFAULT: ModelConfig = { provider: "anthropic", model: "claude-sonnet-5-5", max_sensitivity: "personal" };
export const KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", "openai-compatible": "OPENAI_API_KEY", typesafe: "TYPESAFE_API_KEY", fake: "",
};

// rules/models.yaml:
//   default: { provider: anthropic, model: claude-sonnet-5-5 }
//   steps:
//     upkeep.duplicates: { provider: openai-compatible, base_url: http://localhost:11434/v1, model: llama3.1 }
//     upkeep.duplicates: { provider: typesafe, model: jev-latest }   # typed decisions, key in TYPESAFE_API_KEY
//   roles:                                   # move every step of a role at once
//     executor: { model: claude-sonnet-5-5 }
//   routing: off                             # every step on the default model
// Per-step defaults when models.yaml names none for the step: Jev for the classifier (typed
// questions with probabilities) and per-step timeouts.
const STEP_DEFAULTS: Record<string, Partial<ModelConfig>> = {
  "write.conflicts": { timeout_ms: 20_000 },
  "write.classify": { provider: "typesafe", model: "jev-latest", timeout_ms: 3_000 },
  "relay.flag": { timeout_ms: 20_000 },
};

// Model routing (backlog 89): routine steps that turn text into candidates or flags run on a
// cheaper model; the step that judges candidates for the owner runs on the strongest. Every
// executor's output still passes the deterministic checks (grounded quotes, the write path's
// rules) and only becomes a proposal or a Needs-you item, so a cheaper model costs recall, never
// safety. Steps with no role (the dashboard's Ask and Edit, which the owner reads directly) stay
// on the default. The Anthropic names apply only while the owner's default provider is Anthropic.
export type Role = "executor" | "review";
export const STEP_ROLES: Record<string, Role> = {
  "write.conflicts": "executor",
  "capture.extract": "executor",
  "sleep.consolidate": "executor",
  "relay.flag": "executor", // the relay's tighten-only flag check (claude/g6-classifier)
  // The duplicates judge only suggests merges for the owner to accept, and held on Haiku in the
  // judge compare (backlog 212), so it runs as an executor. Review keeps no step, so `roles: { review: ... }`
  // changes nothing today; a step's own line under `steps:` picks its model.
  "upkeep.duplicates": "executor",
};
const ROLE_DEFAULTS: Record<Role, Partial<ModelConfig>> = {
  executor: { model: "claude-haiku-5-5" },
  review: { model: "claude-opus-5-5" },
};
// Every model step, for `pocketbrain models`.
export const MODEL_STEPS = ["write.conflicts", "write.classify", "relay.flag", "capture.extract", "sleep.consolidate", "upkeep.duplicates", "dashboard.ask", "dashboard.edit"];

type ModelsDoc = { default?: Partial<ModelConfig>; roles?: Partial<Record<Role, Partial<ModelConfig>>>; steps?: Record<string, Partial<ModelConfig>>; routing?: boolean | string };
type Source = "steps" | "step default" | "roles" | "role default" | "default";
const readModels = (root: string) => readYaml<ModelsDoc>(join(root, "rules", "models.yaml"), {});

// Layers, weakest first; the last one that names a model is where the step's model comes from.
function layers(doc: ModelsDoc, step: string): [Source, Partial<ModelConfig>][] {
  const anthropic = (doc.default?.provider ?? "anthropic") === "anthropic";
  const on = doc.routing !== false && doc.routing !== "off";
  const role = on ? STEP_ROLES[step] : undefined;
  // A role never sets what its steps may send: max_sensitivity comes only from default or a step's own line.
  const { max_sensitivity: _drop, ...owned } = (role && doc.roles?.[role]) || {};
  const sd = STEP_DEFAULTS[step];
  const stepDefault = sd && (sd.provider || anthropic) ? sd : {};
  return [
    ["default", { ...DEFAULT, ...(doc.default ?? {}) }],
    ["role default", role && anthropic ? ROLE_DEFAULTS[role] : {}],
    ["roles", owned],
    ["step default", stepDefault],
    ["steps", doc.steps?.[step] ?? {}],
  ];
}

export function modelConfigFor(root: string, step: string): ModelConfig {
  return Object.assign({}, ...layers(readModels(root), step).map(([, c]) => c)) as ModelConfig;
}

// Which model each step runs on, and which line of models.yaml (or built-in default) picked it.
export function routing(root: string): { step: string; role?: Role; provider: Provider; model: string; from: Source }[] {
  const doc = readModels(root);
  return MODEL_STEPS.map((step) => {
    const ls = layers(doc, step);
    const cfg = Object.assign({}, ...ls.map(([, c]) => c)) as ModelConfig;
    const from = [...ls].reverse().find(([, c]) => c.model || c.provider)![0];
    const on = doc.routing !== false && doc.routing !== "off";
    return { step, role: on ? STEP_ROLES[step] : undefined, provider: cfg.provider, model: cfg.model, from };
  });
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function makeModel(config: ModelConfig, opts: { fetch?: Fetch; fake?: (req: ModelRequest) => string } = {}): Model {
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const key = () => {
    const name = config.api_key_env ?? KEY_ENV[config.provider];
    const k = name ? process.env[name] : undefined;
    if (!k && config.provider !== "openai-compatible") throw new Error(`set ${name} for ${config.provider}`);
    return k ?? "";
  };
  const post = async (url: string, headers: Record<string, string>, body: unknown) => {
    const ms = config.timeout_ms ?? (config.provider === "typesafe" ? 10_000 : 120_000);
    const r = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error(`${config.provider} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<any>;
  };
  const max = (req: ModelRequest) => req.maxTokens ?? config.max_tokens ?? 1024;
  const reply = (text: string, served?: unknown, usage?: Usage): ModelReply =>
    ({ text, provider: config.provider, model: typeof served === "string" && served ? served : config.model, ...(usage ? { usage } : {}) });
  const usageOf = (i: unknown, o: unknown): Usage | undefined =>
    typeof i === "number" || typeof o === "number" ? { input_tokens: Number(i) || 0, output_tokens: Number(o) || 0 } : undefined;

  return {
    config,
    ...(config.provider === "typesafe" ? {
      // POST /v1/systemone {model, state, questions} -> {model, answers, usage.input_tokens}.
      // Output tokens are free. A reply without an answers object is an error, not "no answers".
      async decide(req: DecisionRequest): Promise<DecisionReply> {
        const j = await post(`${config.base_url ?? "https://api.typesafe.ai/v1"}/systemone`, { authorization: `Bearer ${key()}` },
          { model: config.model, state: req.state, questions: req.questions });
        if (!j || typeof j.answers !== "object" || j.answers === null || Array.isArray(j.answers)) throw new Error("typesafe: reply has no answers object");
        const usage = usageOf(j.usage?.input_tokens, 0);
        return { answers: j.answers, provider: config.provider, model: typeof j.model === "string" ? j.model : config.model, ...(usage ? { usage } : {}) };
      },
    } : {}),
    async complete(req) {
      switch (config.provider) {
        case "typesafe":
          throw new Error("typesafe answers typed decisions only; use decide()");
        case "fake":
          if (!opts.fake) throw new Error("fake provider needs a responder");
          return reply(opts.fake(req));
        case "anthropic": {
          const j = await post(`${config.base_url ?? "https://api.anthropic.com"}/v1/messages`, { "x-api-key": key(), "anthropic-version": "2023-06-01" },
            { model: config.model, max_tokens: max(req), system: req.system, messages: [{ role: "user", content: req.prompt }] });
          return reply((j.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(""), j.model, usageOf(j.usage?.input_tokens, j.usage?.output_tokens));
        }
        case "openai":
        case "openai-compatible": {
          const k = key();
          const j = await post(`${config.base_url ?? "https://api.openai.com/v1"}/chat/completions`, k ? { authorization: `Bearer ${k}` } : {},
            { model: config.model, max_tokens: max(req), messages: [{ role: "system", content: req.system }, { role: "user", content: req.prompt }] });
          return reply(j.choices?.[0]?.message?.content ?? "", j.model, usageOf(j.usage?.prompt_tokens, j.usage?.completion_tokens));
        }
        case "gemini": {
          const j = await post(`${config.base_url ?? "https://generativelanguage.googleapis.com/v1beta"}/models/${encodeURIComponent(config.model)}:generateContent`, { "x-goog-api-key": key() },
            { systemInstruction: { parts: [{ text: req.system }] }, contents: [{ role: "user", parts: [{ text: req.prompt }] }], generationConfig: { maxOutputTokens: max(req) } });
          return reply((j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join(""), j.modelVersion, usageOf(j.usageMetadata?.promptTokenCount, j.usageMetadata?.candidatesTokenCount));
        }
      }
      throw new Error(`unknown provider ${config.provider}`);
    },
  };
}

// Every judgment is logged with the model that made it, so a later review (or an eval)
// can compare providers on the same inputs.
// Token counts and an estimated cost ride along when the provider reported usage.
export function logJudgment(root: string, step: string, reply: ModelReply, input: string, verdict: unknown, requested?: string) {
  const usd = costOf(reply.provider, requested ?? reply.model, reply.usage, reply.model);
  appendJsonl(join(root, "log", "judgments.jsonl"), {
    at: new Date().toISOString(), step, provider: reply.provider, model: reply.model,
    input_sha256: sha256(input), verdict,
    ...(reply.usage ? { usage: reply.usage } : {}), ...(usd !== undefined && reply.usage ? { usd: Number(usd.toFixed(6)) } : {}),
  });
}

// The first JSON object in a model's reply, or undefined. Models wrap JSON in prose or fences.
export function parseJson<T>(text: string): T | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try { return JSON.parse(m[0]) as T; } catch { return undefined; }
}
