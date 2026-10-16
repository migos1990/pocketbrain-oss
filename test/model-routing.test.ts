// SPDX-License-Identifier: AGPL-3.0-only
// Model routing (backlog 89): routine executor steps run on a cheaper model, review steps on
// the strongest, and the owner can move either role or any single step in rules/models.yaml.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { modelConfigFor, routing, STEP_ROLES } from "../src/model";
import { main } from "../src/cli";

const models = (root: string, yaml: string) => writeFileSync(join(root, "rules/models.yaml"), yaml);

test("routing: executor steps (now including the duplicates judge) on Haiku, owner-facing steps on the default", () => {
  const root = makeBrain();
  for (const step of ["capture.extract", "sleep.consolidate", "write.conflicts", "upkeep.duplicates"])
    expect(modelConfigFor(root, step)).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
  for (const step of ["dashboard.ask", "dashboard.edit"])
    expect(modelConfigFor(root, step)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
  expect(modelConfigFor(root, "write.classify")).toMatchObject({ provider: "typesafe", model: "jev-latest" });
  expect(STEP_ROLES["upkeep.duplicates"]).toBe("executor"); // backlog 212: held on Haiku in the judge compare
  expect(modelConfigFor(root, "relay.flag")).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
});

test("routing: roles in models.yaml move every step of a role; a step's own line still wins", () => {
  const root = makeBrain();
  models(root, [
    "roles:",
    "  executor: { model: claude-sonnet-5-5 }",
    "  review: { provider: openai, model: gpt-big }",
    "steps:",
    "  capture.extract: { model: claude-haiku-5-5 }",
  ].join("\n"));
  expect(modelConfigFor(root, "sleep.consolidate")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
  expect(modelConfigFor(root, "capture.extract")).toMatchObject({ model: "claude-haiku-5-5" });
  expect(modelConfigFor(root, "upkeep.duplicates")).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" }); // an executor now; review has no step by default
  expect(modelConfigFor(root, "dashboard.ask")).toMatchObject({ model: "claude-sonnet-5-5" });
});

test("routing: a role can't widen what its steps send; only a step's own line sets max_sensitivity", () => {
  const root = makeBrain();
  models(root, "roles:\n  review: { model: claude-opus-5-5, max_sensitivity: private }\n  executor: { max_sensitivity: secret }\n");
  expect(modelConfigFor(root, "upkeep.duplicates").max_sensitivity).toBe("personal");
  expect(modelConfigFor(root, "sleep.consolidate").max_sensitivity).toBe("personal");
  models(root, "roles:\n  review: { max_sensitivity: private }\nsteps:\n  upkeep.duplicates: { max_sensitivity: private }\n");
  expect(modelConfigFor(root, "upkeep.duplicates").max_sensitivity).toBe("private");
});

test("routing: bring-your-own keeps its provider; no Anthropic model name under another provider", () => {
  const root = makeBrain();
  models(root, "default: { provider: openai-compatible, base_url: http://localhost:11434/v1, model: llama3.1 }\n");
  for (const step of ["capture.extract", "upkeep.duplicates", "write.conflicts"])
    expect(modelConfigFor(root, step)).toMatchObject({ provider: "openai-compatible", model: "llama3.1" });
  models(root, "default: { provider: openai, model: gpt-x }\nroles:\n  executor: { model: gpt-mini }\n");
  expect(modelConfigFor(root, "capture.extract")).toMatchObject({ provider: "openai", model: "gpt-mini" });
  expect(modelConfigFor(root, "upkeep.duplicates")).toMatchObject({ provider: "openai", model: "gpt-mini" });
});

test("routing: off puts every step on the default model", () => {
  const root = makeBrain();
  models(root, "routing: off\nroles:\n  executor: { model: claude-haiku-5-5 }\n");
  for (const step of ["capture.extract", "sleep.consolidate", "write.conflicts", "upkeep.duplicates"])
    expect(modelConfigFor(root, step)).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });
  expect(modelConfigFor(root, "write.classify")).toMatchObject({ provider: "typesafe" }); // a provider default, not a role
  expect(modelConfigFor(root, "write.conflicts").timeout_ms).toBe(20_000);
});

test("routing table says where each step's model comes from; `pocketbrain models` prints it", async () => {
  const root = makeBrain();
  models(root, "steps:\n  capture.extract: { model: claude-sonnet-5-5 }\n");
  const t = routing(root);
  expect(t.find((r) => r.step === "capture.extract")).toMatchObject({ role: "executor", model: "claude-sonnet-5-5", from: "steps" });
  expect(t.find((r) => r.step === "sleep.consolidate")).toMatchObject({ role: "executor", model: "claude-haiku-5-5", from: "role default" });
  expect(t.find((r) => r.step === "dashboard.ask")).toMatchObject({ role: undefined, from: "default" });
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try { expect(await main(["models", "--brain", root])).toBe(0); } finally { console.log = log; }
  const out = lines.join("\n");
  expect(out).toContain("upkeep.duplicates");
  expect(out).toMatch(/upkeep\.duplicates\s+executor\s+anthropic\/claude-haiku-5-5/);
});

test("routing table lists every routed step, the relay's request check included", () => {
  const root = makeBrain();
  const steps = routing(root).map((r) => r.step);
  for (const s of Object.keys(STEP_ROLES)) expect(steps).toContain(s);
  expect(routing(root).find((r) => r.step === "relay.flag")).toMatchObject({ role: "executor", model: "claude-haiku-5-5" });
});
