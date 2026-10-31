// SPDX-License-Identifier: AGPL-3.0-only
// memory_check under the context budget (docs/memory-sync.md, "Size"): what one check hands an
// agent stays under its memory_check budget. Oldest first; what isn't sent stays waiting (a
// correction isn't marked delivered, a changed fact isn't marked seen) and the reply counts it.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { carve, grantFor } from "../src/carve";
import { setFact } from "../src/dashboard/edit";
import { tokensOf } from "../src/context";
import * as ms from "../src/memsync";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

function budget(root: string, n: number) {
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.context_budget = { memory_check: n };
  writeFileSync(f, YAML.stringify(p));
}
const size = (c: ms.Check) => tokensOf(JSON.stringify(c, null, 2));
const AGENT = "steward"; // the example brain's widest view: 6 facts to ask about
const targets = (root: string) => { const n = loadBrain(root), r = loadRules(root); return ms.targets(n, r, carve(n, r, grantFor(r, AGENT))); };

test("open questions past the budget wait for the next check, and the reply says how many", () => {
  const root = makeBrain();
  const asked = ms.quiz(root, AGENT, 20);
  expect(asked.length).toBeGreaterThan(3);
  const all = ms.memoryCheck(root, AGENT);
  expect(all.questions).toHaveLength(asked.length);
  expect(all.waiting).toBeUndefined();
  const cap = size({ ...all, questions: all.questions.slice(0, 2) });
  budget(root, cap);
  const c = ms.memoryCheck(root, AGENT);
  expect(size(c)).toBeLessThanOrEqual(cap);
  expect(c.questions.length).toBeGreaterThanOrEqual(1);
  expect(c.questions.length).toBeLessThan(asked.length);
  expect(c.questions.map((q) => q.id)).toEqual(all.questions.slice(0, c.questions.length).map((q) => q.id)); // oldest first
  expect(c.waiting?.questions).toBe(asked.length - c.questions.length);
  expect(c.how).toMatch(/call memory_check again/);
});

test("a correction past the budget isn't marked delivered; it goes out at a later check", () => {
  const root = makeBrain();
  const log = join(root, "log", "memsync.jsonl");
  const keys = targets(root).slice(0, 4);
  expect(keys.length).toBe(4);
  for (const t of keys) {
    const [q] = ms.quiz(root, AGENT, 1, [t.key]);
    ms.memoryReply(root, AGENT, { answers: [{ id: q.id, answer: `Something else entirely ${"x".repeat(200)}` }] });
  }
  const proposed = ms.state(root).corrections.filter((c) => c.state === "proposed");
  expect(proposed.length).toBeGreaterThanOrEqual(2);
  for (const c of proposed) ms.approve(root, c.id);
  budget(root, 100);
  const first = ms.memoryCheck(root, AGENT);
  expect(first.corrections).toHaveLength(1); // always one, even over a tiny budget
  expect(first.waiting?.corrections).toBe(proposed.length - 1);
  const st = ms.state(root).corrections;
  expect(st.filter((c) => c.state === "delivered").map((c) => c.id)).toEqual([first.corrections[0].id]);
  const again = ms.memoryCheck(root, AGENT);
  expect(again.corrections[0].id).toBe(first.corrections[0].id); // still waiting on done, still first
  ms.memoryReply(root, AGENT, { corrections: [{ id: first.corrections[0].id, done: true }] });
  const next = ms.memoryCheck(root, AGENT);
  expect(next.corrections[0].id).not.toBe(first.corrections[0].id);
  expect(readFileSync(log, "utf8")).toContain('"ev":"delivered"');
});

test("changed facts past the budget aren't marked seen: they come in a later feed", () => {
  const root = makeBrain();
  ms.memoryCheck(root, AGENT); // baseline
  const ts = targets(root);
  expect(ts.length).toBeGreaterThanOrEqual(4);
  for (const t of ts) { const [id, attr] = t.key.split("#"); setFact(root, id, attr, `Changed value for ${attr} ${"y".repeat(150)}`); }
  const c0 = ms.memoryCheck(root, AGENT);
  const n = c0.changes?.items.length ?? 0; // a list fact (phones) isn't set this way
  expect(n).toBeGreaterThanOrEqual(4);
  const cap = size({ ...c0, changes: { ...c0.changes!, items: c0.changes!.items.slice(0, 2) } });
  budget(root, cap);
  const c = ms.memoryCheck(root, AGENT);
  expect(size(c)).toBeLessThanOrEqual(cap);
  const sent = c.changes?.items.length ?? 0;
  expect(sent).toBeGreaterThanOrEqual(1);
  expect(sent).toBeLessThan(n);
  expect(c.waiting?.changes).toBe(n - sent);
  ms.memoryReply(root, AGENT, { changes_seen: c.changes!.id });
  const later = ms.memoryCheck(root, AGENT);
  const keys = new Set(c.changes!.items.map((i) => i.key));
  expect(later.changes?.items.length).toBeGreaterThan(0);
  for (const i of later.changes!.items) expect(keys.has(i.key)).toBe(false);
});

test("a part the owner turned off stays fully off under the budget: nothing sent, delivered or counted as waiting", () => {
  const root = makeBrain();
  ms.memoryCheck(root, AGENT); // baseline
  for (const t of targets(root)) {
    const [q] = ms.quiz(root, AGENT, 1, [t.key]);
    ms.memoryReply(root, AGENT, { answers: [{ id: q.id, answer: `Something else entirely ${"x".repeat(200)}` }] });
  }
  for (const c of ms.state(root).corrections.filter((x) => x.state === "proposed")) ms.approve(root, c.id);
  for (const t of targets(root)) { const [id, attr] = t.key.split("#"); setFact(root, id, attr, `Changed value for ${attr} ${"y".repeat(150)}`); }
  ms.quiz(root, AGENT, 6);
  const f = join(root, "rules/policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.context_budget = { memory_check: 300 };
  p.memsync = { corrections: false, change_feed: false };
  writeFileSync(f, YAML.stringify(p));
  const c = ms.memoryCheck(root, AGENT);
  expect(c.corrections).toHaveLength(0);
  expect(c.changes).toBeUndefined();
  expect(c.waiting?.corrections).toBeUndefined();
  expect(c.waiting?.changes).toBeUndefined();
  expect(c.off).toEqual(["corrections", "change_feed"]);
  expect(ms.state(root).corrections.some((x) => x.state === "delivered")).toBe(false);
  expect(c.questions.length).toBeGreaterThanOrEqual(1); // the part still on is still held to the budget
});
