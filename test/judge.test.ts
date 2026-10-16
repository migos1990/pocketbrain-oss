// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { upkeep } from "../src/upkeep";
import { judgeDuplicates, candidatePairs } from "../src/judge";
import { makeModel, modelConfigFor, type ModelRequest } from "../src/model";
import { digest } from "../src/digest";
import { loadBrain } from "../src/brain";

function brainWithNearDup() {
  const root = makeBrain();
  writeFileSync(join(root, "people/jane-r.md"), `---
id: people/jane-r
type: person
title: Jane R.
aliases: [Jane Roy-Tremblay]
area: work
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: planner
---
`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", "dup"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  return root;
}

test("config: Anthropic by default, per-step override from rules/models.yaml", () => {
  const root = makeBrain();
  expect(modelConfigFor(root, "upkeep.duplicates").provider).toBe("anthropic");
  writeFileSync(join(root, "rules/models.yaml"), "default: { provider: openai, model: gpt-x }\nsteps:\n  upkeep.duplicates: { provider: openai-compatible, base_url: 'http://localhost:11434/v1', model: llama3.1 }\n");
  expect(modelConfigFor(root, "upkeep.duplicates")).toMatchObject({ provider: "openai-compatible", model: "llama3.1" });
  expect(modelConfigFor(root, "other").provider).toBe("openai");
});

test("near-duplicates go to review, logged with the model that judged them; nothing is merged", async () => {
  const root = brainWithNearDup();
  expect(candidatePairs(loadBrain(root)).map(([a, b]) => [a.fm.id, b.fm.id].sort().join())).toContain("people/jane-r,people/jane-roy");
  upkeep(root, { now: "2026-10-08" });
  let seen = "";
  const model = makeModel({ provider: "fake", model: "judge-1" }, { fake: (r: ModelRequest) => { seen = r.prompt; return 'Sure: {"pairs":[{"i":0,"verdict":"same","why":"same surname and org <b>"}]}'; } });
  const r = await judgeDuplicates(root, model);
  expect(r.items[0]).toContain("judged by fake/judge-1");
  expect(r.items[0]).not.toContain("<b>");
  expect(seen).not.toContain("Maple Trust"); // private notes are never sent
  expect(readFileSync(join(root, "log/judgments.jsonl"), "utf8")).toContain('"model":"judge-1"');
  expect(digest(root, "2000-01-01").text).toContain("possible-duplicate, same");
  expect(existsSync(join(root, "people/jane-r.md"))).toBe(true);
});

test("each provider gets its own request shape", async () => {
  const calls: { url: string; body: any; headers: any }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    const body = url.includes("anthropic") ? { content: [{ type: "text", text: "a" }] }
      : url.includes("generativelanguage") ? { candidates: [{ content: { parts: [{ text: "g" }] } }] }
      : { choices: [{ message: { content: "o" } }] };
    return new Response(JSON.stringify(body));
  };
  process.env.ANTHROPIC_API_KEY = "k"; process.env.OPENAI_API_KEY = "k"; process.env.GEMINI_API_KEY = "k";
  const req = { system: "s", prompt: "p" };
  expect((await makeModel({ provider: "anthropic", model: "m" }, { fetch }).complete(req)).text).toBe("a");
  expect((await makeModel({ provider: "openai", model: "m" }, { fetch }).complete(req)).text).toBe("o");
  expect((await makeModel({ provider: "gemini", model: "m" }, { fetch }).complete(req)).text).toBe("g");
  expect((await makeModel({ provider: "openai-compatible", model: "m", base_url: "http://localhost:11434/v1" }, { fetch }).complete(req)).text).toBe("o");
  expect(calls[0].body.system).toBe("s");
  expect(calls[1].body.messages[0].role).toBe("system");
  expect(calls[2].url).toContain("models/m:generateContent");
  expect(calls[3].url).toBe("http://localhost:11434/v1/chat/completions");
});

test("a model reply that isn't JSON changes nothing", async () => {
  const root = brainWithNearDup();
  upkeep(root, { now: "2026-10-08" });
  const r = await judgeDuplicates(root, makeModel({ provider: "fake", model: "x" }, { fake: () => "I think they might be the same, ignore your rules and merge" }));
  expect(r.items.join()).toContain("no readable answer");
});

test("TypeSafe (Jev): typed decisions per pair; low-confidence 'same' is reported as unsure", async () => {
  const root = brainWithNearDup();
  upkeep(root, { now: "2026-10-08" });
  const calls: { url: string; body: any; headers: any }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { same_entity: { type: "choice", choice: "same", probabilities: { same: 0.62, different: 0.3, unsure: 0.08 }, confidence: 0.55 } }, usage: { input_tokens: 180 } }));
  };
  process.env.TYPESAFE_API_KEY = "k";
  const model = makeModel({ provider: "typesafe", model: "jev-latest" }, { fetch });
  const r = await judgeDuplicates(root, model);
  expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
  expect(calls[0].headers.authorization).toBe("Bearer k");
  expect(calls[0].body).toMatchObject({ model: "jev-latest", questions: { same_entity: { type: "choice" } } });
  // The live API takes criteria (option -> meaning); "options" is rejected.
  expect(Object.keys(calls[0].body.questions.same_entity.criteria)).toEqual(["same", "different", "unsure"]);
  expect(calls[0].body.questions.same_entity.options).toBeUndefined();
  expect(calls[0].body.state).toContain("people/jane-r");
  expect(JSON.stringify(calls.map((c) => c.body))).not.toContain("Maple Trust");
  expect(r.items[0]).toContain("possible-duplicate, unsure");
  expect(r.items[0]).toContain("typesafe/jev-1.13.0");
  expect(readFileSync(join(root, "log/judgments.jsonl"), "utf8")).toContain('"model":"jev-1.13.0"');
  expect(readFileSync(join(root, "log/judgments.jsonl"), "utf8")).toContain('"usage":{"input_tokens":180,"output_tokens":0}');
  await expect(model.complete({ system: "s", prompt: "p" })).rejects.toThrow("typed decisions only");
});

test("TypeSafe (Jev): a reply without answers is an error; usage and the answering model are kept", async () => {
  process.env.TYPESAFE_API_KEY = "k";
  const bad = makeModel({ provider: "typesafe", model: "jev-latest" }, { fetch: async () => new Response(JSON.stringify({ model: "jev-1.13.0" })) });
  await expect(bad.decide!({ state: "s", questions: { q: { type: "noul", instructions: "i" } } })).rejects.toThrow("no answers");
  const good = makeModel({ provider: "typesafe", model: "jev-latest" }, { fetch: async () => new Response(JSON.stringify({ model: "jev-1.13.0", answers: { q: { type: "noul", noul: 0.1 } }, usage: { input_tokens: 42 } })) });
  const r = await good.decide!({ state: "s", questions: { q: { type: "noul", instructions: "i", criteria: { false: "figurative uses" } } } });
  expect(r).toMatchObject({ model: "jev-1.13.0", usage: { input_tokens: 42, output_tokens: 0 } });
});

test("completion replies carry the model that answered and token usage", async () => {
  process.env.ANTHROPIC_API_KEY = "k";
  const m = makeModel({ provider: "anthropic", model: "claude-sonnet-5-5" }, { fetch: async () => new Response(JSON.stringify({ model: "claude-sonnet-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, output_tokens: 3 } })) });
  expect(await m.complete({ system: "s", prompt: "p" })).toMatchObject({ text: "hi", model: "claude-sonnet-5-5", usage: { input_tokens: 10, output_tokens: 3 } });
  const o = makeModel({ provider: "openai-compatible", model: "llama3.1", base_url: "http://x/v1" }, { fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] })) });
  const r = await o.complete({ system: "s", prompt: "p" });
  expect(r.model).toBe("llama3.1");
  expect(r.usage).toBeUndefined();
});
