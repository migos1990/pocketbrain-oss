// SPDX-License-Identifier: AGPL-3.0-only
// The model cost ledger (backlog 272): every model call the hub makes is a line in
// log/usage.jsonl; the week report shows cost per job and flags a job whose cost doubled; a
// job past its daily cap runs on its provider's cheaper model instead of failing.
import { test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import type { Model, ModelConfig, ModelRequest } from "../src/model";
import { record, usageEvents, metered, costByJob, dailyState } from "../src/usage";
import { captureModel } from "../src/capture";
import { cheaperModel } from "../src/pricing";
import { week } from "../src/measure";

const saved = process.env.PB_TODAY;
afterEach(() => { if (saved === undefined) delete process.env.PB_TODAY; else process.env.PB_TODAY = saved; });

function setUsage(root: string, usage: unknown) {
  const f = join(root, "rules", "policy.yaml");
  const doc = YAML.parse(readFileSync(f, "utf8"));
  doc.usage = usage;
  writeFileSync(f, YAML.stringify(doc));
}
// A model that answers without the network, with the token counts a provider would report.
const stub = (config: Partial<ModelConfig>, calls: string[] = []): Model => ({
  config: { provider: "anthropic", ...config } as ModelConfig,
  async complete(_req: ModelRequest) { calls.push(String(config.model)); return { text: "ok", provider: "anthropic", model: String(config.model), usage: { input_tokens: 100_000, output_tokens: 10_000 } }; },
});
const spend = (root: string, day: string, step: string, model: string, tokens_in: number) => {
  process.env.PB_TODAY = day;
  record(root, { step, by: "reflect", outcome: "ok", provider: "anthropic", model, tokens_in, tokens_out: 0, seconds: 1 });
};

test("each provider's cheaper model is the cheapest priced one below it, none below the cheapest", () => {
  expect(cheaperModel("anthropic", "claude-opus-5-5")).toBe("claude-haiku-5-5");
  expect(cheaperModel("anthropic", "claude-sonnet-5-5")).toBe("claude-haiku-5-5");
  expect(cheaperModel("anthropic", "claude-haiku-5-5")).toBeUndefined();
  expect(cheaperModel("fake", "f1")).toBeUndefined();
  expect(cheaperModel("anthropic", "some-unlisted-model")).toBeUndefined();
});

test("past its daily cap a job runs on the cheaper model, recorded as downgraded, instead of failing", async () => {
  const root = makeBrain();
  setUsage(root, { cap: { daily: { "dashboard.ask": 0.5 } } });
  process.env.PB_TODAY = "2026-10-08";
  const calls: string[] = [];
  const make = (cfg: ModelConfig) => stub(cfg, calls);
  const m = metered(root, "dashboard.ask", stub({ model: "claude-sonnet-5-5" }, calls), "owner", make);
  await m.complete({ system: "s", prompt: "p" }); // 100k in at $2/M + 10k out at $10/M = $0.30
  await m.complete({ system: "s", prompt: "p" }); // $0.60 today: past the $0.50 cap
  const r = await m.complete({ system: "s", prompt: "p" });
  expect(calls).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  expect(r.model).toBe("claude-haiku-5-5");
  const last = usageEvents(root).at(-1)!;
  expect(last).toMatchObject({ step: "dashboard.ask", model: "claude-haiku-5-5", downgraded_from: "claude-sonnet-5-5" });
  expect(dailyState(root).find((d) => d.step === "dashboard.ask")).toMatchObject({ cap: 0.5, over: true, cheaper: "claude-haiku-5-5" });
  // The next day starts on the configured model again.
  process.env.PB_TODAY = "2026-10-09";
  await m.complete({ system: "s", prompt: "p" });
  expect(calls.at(-1)).toBe("claude-sonnet-5-5");
});

test("a job already on the cheapest model pauses for the rest of the day past its cap", async () => {
  const root = makeBrain();
  setUsage(root, { cap: { daily: { "capture.extract": 0.01 } } });
  process.env.PB_TODAY = "2026-10-08";
  const m = metered(root, "capture.extract", stub({ model: "claude-haiku-5-5" }), "capture", (cfg) => stub(cfg));
  await m.complete({ system: "s", prompt: "p" }); // 100k in at $0.10/M + 10k out at $0.50/M = $0.015
  await expect(m.complete({ system: "s", prompt: "p" })).rejects.toThrow(/daily cap/);
});

test("every job has a $2 daily cap unless the owner sets one", () => {
  const root = makeBrain();
  setUsage(root, {});
  expect(dailyState(root).find((d) => d.step === "sleep.consolidate")).toMatchObject({ cap: 2, over: false });
  setUsage(root, { cap: { daily_default: 5, daily: { "sleep.consolidate": 1 } } });
  expect(dailyState(root).find((d) => d.step === "sleep.consolidate")!.cap).toBe(1);
  expect(dailyState(root).find((d) => d.step === "capture.extract")!.cap).toBe(5);
});

test("the capture extraction model the hub uses by default is metered", async () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "models.yaml"), YAML.stringify({ steps: { "capture.extract": { provider: "openai-compatible", model: "local-1", base_url: "http://127.0.0.1:9/v1" } } }));
  await captureModel(root).complete({ system: "s", prompt: "p" }).catch(() => undefined);
  expect(usageEvents(root).map((e) => e.step)).toContain("capture.extract");
});

test("the week report shows cost per job and flags one whose cost doubled week on week", () => {
  const root = makeBrain();
  // Week before (2026-10-01..07): capture $0.10, sleep $0.10. This week (08..14): capture $0.30, sleep $0.11.
  spend(root, "2026-10-03", "capture.extract", "claude-sonnet-5-5", 50_000);
  spend(root, "2026-10-03", "sleep.consolidate", "claude-sonnet-5-5", 50_000);
  spend(root, "2026-10-10", "capture.extract", "claude-sonnet-5-5", 150_000);
  spend(root, "2026-10-10", "sleep.consolidate", "claude-sonnet-5-5", 55_000);
  const jobs = costByJob(root, "2026-10-14");
  expect(jobs.find((j) => j.step === "capture.extract")).toMatchObject({ week: 0.3, prior: 0.1, doubled: true });
  expect(jobs.find((j) => j.step === "sleep.consolidate")).toMatchObject({ week: 0.11, prior: 0.1, doubled: false });
  process.env.PB_TODAY = "2026-10-14";
  const text = week(root, "2026-10-14").text;
  expect(text).toContain("## Model cost per job");
  expect(text).toMatch(/\| capture\.extract \| \$0\.3000 \| \$0\.1000 \| \*\*doubled\*\* \|/);
  expect(text).toMatch(/\| sleep\.consolidate \| \$0\.1100 \| \$0\.1000 \|  \|/);
});

test("the built-in daily cap only ever switches to a cheaper model; with none it never pauses a job", async () => {
  const root = makeBrain();
  setUsage(root, {});
  process.env.PB_TODAY = "2026-10-08";
  spend(root, "2026-10-08", "capture.extract", "claude-haiku-5-5", 30_000_000); // $3 today, past the built-in $2
  const m = metered(root, "capture.extract", stub({ model: "claude-haiku-5-5" }), "capture", (cfg) => stub(cfg));
  await expect(m.complete({ system: "s", prompt: "p" })).resolves.toMatchObject({ model: "claude-haiku-5-5" });
});
