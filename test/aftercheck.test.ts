// SPDX-License-Identifier: AGPL-3.0-only
// Checks after a write: the quick gardener and the second-opinion classifier. Both only add a
// Needs-you item or raise a fact; neither blocks, lowers or undoes a write.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import * as core from "../src/core";
import { handle } from "../src/server";
import { issueToken } from "../src/auth";
import { queueAftercheck, pendingChecks, drainAftercheck, CONFLICT_STEP, CLASSIFY_STEP } from "../src/aftercheck";
import { makeModel, modelConfigFor, type Model, type DecisionRequest, type Answer } from "../src/model";
import { loadBrain, type FactRecord } from "../src/brain";
import { readJsonl } from "../src/util";
import { digest } from "../src/digest";

const KEY = "projects/course-a#next_step";
const W = { id: "projects/course-a", attribute: "next_step", value: "Publish grades", as_of: "2026-10-07", sources: ["gmail:f000000000000006"], verification: "verified-by-source" };

const textModel = (answer: (prompt: string) => string, seen: string[] = []): Model =>
  makeModel({ provider: "fake", model: "fake-small", max_sensitivity: "personal" }, { fake: (r) => { seen.push(r.prompt); return answer(r.prompt); } });
const jev = (answers: Record<string, Answer>, seen: string[] = []): Model => ({
  config: { provider: "typesafe", model: "jev-latest", max_sensitivity: "personal" },
  complete: async () => { throw new Error("decide only"); },
  decide: async (r: DecisionRequest) => { seen.push(r.state); return { answers, provider: "typesafe", model: "jev-test" }; },
});
const alerts = (root: string) => readJsonl<Record<string, string>>(join(root, "log", "alerts.jsonl"));
const fact = (root: string, key = KEY) => { const [id, a] = key.split("#"); return loadBrain(root).find((n) => n.fm.id === id)!.fm.facts![a] as FactRecord; };
const setPolicy = (root: string, extra: Record<string, unknown>) => {
  const p = join(root, "rules/policy.yaml");
  writeFileSync(p, YAML.stringify({ ...YAML.parse(readFileSync(p, "utf8")), ...extra }));
};
function committedWrite(root: string) {
  const r = core.remember(root, "planner", W);
  expect(r.outcome).toBe("committed");
  queueAftercheck(root, "planner", r.fact_key);
  return r;
}

test("step defaults: a small model for the conflict check, Jev for the classifier; models.yaml still wins", () => {
  const root = makeBrain();
  expect(modelConfigFor(root, CONFLICT_STEP)).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
  expect(modelConfigFor(root, CLASSIFY_STEP)).toMatchObject({ provider: "typesafe", model: "jev-latest" });
  writeFileSync(join(root, "rules/models.yaml"), "default: { provider: openai, model: gpt-x }\nsteps:\n  write.classify: { provider: anthropic, model: claude-haiku-5-5 }\n");
  expect(modelConfigFor(root, CONFLICT_STEP)).toMatchObject({ provider: "openai", model: "gpt-x" }); // no Anthropic model name under another provider
  expect(modelConfigFor(root, CLASSIFY_STEP)).toMatchObject({ provider: "anthropic" });
});

test("quick gardener: a clash the same-key rules can't see becomes a Needs-you alert; the write stands", async () => {
  const root = makeBrain();
  committedWrite(root);
  const seen: string[] = [];
  const m = textModel(() => '{"conflict": true, "kind": "contradicts", "note": "projects/course-a", "why": "the body says grades were already published"}', seen);
  const r = await drainAftercheck(root, { conflicts: m });
  expect(r.conflicts).toHaveLength(1);
  expect(seen[0]).toContain("Publish grades");
  expect(fact(root).value).toBe("Publish grades");
  const a = alerts(root).find((x) => x.check === "write_conflict")!;
  expect(a.from).toBe(KEY);
  expect(a.agent).toBe("planner");
  expect(pendingChecks(root)).toHaveLength(0);
  expect(readFileSync(join(root, "log/judgments.jsonl"), "utf8")).toContain(CONFLICT_STEP);
});

test("quick gardener: no clash, nothing happens", async () => {
  const root = makeBrain();
  committedWrite(root);
  const r = await drainAftercheck(root, { conflicts: textModel(() => '{"conflict": false}') });
  expect(r.conflicts).toHaveLength(0);
  expect(alerts(root).filter((x) => x.check === "write_conflict")).toHaveLength(0);
});

test("a model that fails leaves the write as the rules made it; retried, then left to the nightly pass", async () => {
  const root = makeBrain();
  committedWrite(root);
  const down = textModel(() => { throw new Error("overloaded"); });
  for (let i = 0; i < 3; i++) expect((await drainAftercheck(root, { conflicts: down })).errors).toHaveLength(1);
  expect(pendingChecks(root)).toHaveLength(0); // gave up after 3
  expect(fact(root).value).toBe("Publish grades");
});

test("no model key: the rules decide alone and the queue is cleared", async () => {
  const root = makeBrain();
  committedWrite(root);
  const r = await drainAftercheck(root, { conflicts: null });
  expect(r.skipped).toEqual([KEY]);
  expect(pendingChecks(root)).toHaveLength(0);
});

test("a fact above the model's ceiling is never sent", async () => {
  const root = makeBrain();
  core.remember(root, "planner", { ...W, sensitivity: "private" });
  queueAftercheck(root, "planner", KEY);
  const seen: string[] = [];
  await drainAftercheck(root, { conflicts: textModel(() => '{"conflict": true}', seen), classify: jev({}, seen) });
  expect(seen).toHaveLength(0);
});

test("classifier is off by default: even with a model at hand nothing is asked", async () => {
  const root = makeBrain();
  committedWrite(root);
  const seen: string[] = [];
  await drainAftercheck(root, { conflicts: null, classify: jev({ third_party_sensitive: { type: "noul", noul: 0.99 } }, seen) });
  expect(seen).toHaveLength(0);
  expect(fact(root).sensitivity).toBeUndefined();
});

test("classifier on: a confident third-party matter is raised to private and shared with the resolver only", async () => {
  const root = makeBrain();
  setPolicy(root, { aftercheck: { classify: true } });
  committedWrite(root);
  const r = await drainAftercheck(root, { conflicts: null, classify: jev({ third_party_sensitive: { type: "noul", noul: 0.93 }, category: { type: "choice", choice: "health", confidence: 0.9 } }) });
  expect(r.raised).toHaveLength(1);
  expect(fact(root)).toMatchObject({ sensitivity: "private", share_with: ["steward"], value: "Publish grades" });
  const log = Bun.spawnSync(["git", "log", "-1", "--format=%an %s"], { cwd: root }).stdout.toString();
  expect(log).toContain("gardener: made private: projects/course-a#next_step, typesafe/jev-test 0.93");
});

test("classifier bar: 0.5 makes a fact private and the digest lists it; 0.3 to 0.5 asks the owner; the question covers exams and licensing", async () => {
  const root = makeBrain();
  setPolicy(root, { aftercheck: { classify: true } });
  committedWrite(root);
  const seen: string[] = [];
  let asked: DecisionRequest | undefined;
  const capture: Model = { ...jev({}), decide: async (r) => { asked = r; return { answers: { third_party_sensitive: { type: "noul", noul: 0.63 } }, provider: "typesafe", model: "jev-1.13.0" }; } };
  await drainAftercheck(root, { conflicts: null, classify: capture });
  expect(JSON.stringify(asked!.questions)).toContain("professional licensing");
  expect(fact(root).sensitivity).toBe("private");
  expect(digest(root, "2000-01-01").text).toContain("gardener: made private: projects/course-a#next_step, typesafe/jev-1.13.0 0.63");

  const other = makeBrain();
  setPolicy(other, { aftercheck: { classify: true } });
  committedWrite(other);
  await drainAftercheck(other, { conflicts: null, classify: jev({ third_party_sensitive: { type: "noul", noul: 0.4 } }, seen) });
  expect(fact(other).sensitivity).toBeUndefined();
  expect(alerts(other).find((x) => x.check === "classify_review")?.detail).toContain("may be another person's private matter");
  // Someone's own money, as the eval asked it, is made private too.
  queueAftercheck(other, "planner", KEY);
  await drainAftercheck(other, { conflicts: null, classify: jev({ third_party_sensitive: { type: "noul", noul: 0.1 }, personal_money: { type: "noul", noul: 0.9 } }, seen) });
  expect(fact(other).sensitivity).toBe("private");
  expect(seen.at(-1)).toContain("About: Course A (someone other than the owner");
});

test("classifier on: it never lowers, and an unsure answer is a Needs-you item, not a change", async () => {
  const root = makeBrain();
  setPolicy(root, { aftercheck: { classify: true } });
  committedWrite(root);
  await drainAftercheck(root, { conflicts: null, classify: jev({ third_party_sensitive: { type: "noul", noul: 0.1 }, sensitivity: { type: "score", choice: "public", confidence: 0.99 } }) });
  expect(fact(root).sensitivity).toBeUndefined(); // "public" is below personal: ignored
  queueAftercheck(root, "planner", KEY);
  await drainAftercheck(root, { conflicts: null, classify: jev({ third_party_sensitive: { type: "noul", noul: 0.1 }, sensitivity: { type: "score", choice: "private", confidence: 0.6 } }) });
  expect(fact(root).sensitivity).toBeUndefined();
  expect(alerts(root).find((x) => x.check === "classify_review")?.detail).toContain("may be private");
});

test("an agent's write over the API answers at once and queues its check", async () => {
  const root = makeBrain();
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const tok = issueToken(root, "planner");
    const res = await handle(root, new Request("http://pb/v1/remember", { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify(W) }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { outcome: string }).outcome).toBe("committed");
    await Bun.sleep(50);
    const q = readJsonl<{ key: string; event: string }>(join(root, "log", "aftercheck.jsonl"));
    expect(q.map((e) => e.event)).toEqual(["queued", "done"]); // no key here: the rules decided alone
  } finally { if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved; }
});
