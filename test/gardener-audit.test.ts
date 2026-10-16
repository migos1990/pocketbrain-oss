// SPDX-License-Identifier: AGPL-3.0-only
// scripts/gardener-audit.ts: counts, verdicts and ids only, so its output can leave the hub machine.
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { audit } from "../scripts/gardener-audit";

const SECRET = "Zanzibar-private-value";
const j = (o: unknown) => JSON.stringify(o) + "\n";

test("audit reports runs, proposals and their fate, verdicts and rails without any value, quote or log line", () => {
  const root = makeBrain();
  mkdirSync(join(root, "log", "sources"), { recursive: true });
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  const at = "2026-10-08T07:31:00.000Z";
  writeFileSync(join(root, "log", "gardener.jsonl"), j({ at, agent: "gardener", op: "upkeep_run", run: "u1", findings: 4 }) + j({ at, agent: "gardener", op: "sleep_run", run: "s1", retired: 2 }));
  writeFileSync(join(root, "log", "reads.jsonl"), j({ at, agent: "gardener", op: "search", query: SECRET }) + j({ at, agent: "gardener", op: "verify_source" }));
  writeFileSync(join(root, "log", "writes.jsonl"), j({ at, agent: "gardener", kind: "fact", key: "people/ana#role", outcome: "inbox", checks: [] }) + j({ at, agent: "gardener", kind: "fact", key: "people/bo", outcome: "inbox", checks: [] }) + j({ at, agent: "gardener", outcome: "refused", checks: ["proposal_cap"] }));
  writeFileSync(join(root, "log", "sources", "verify.jsonl"), j({ at, agent: "gardener", ref: "gmail:f1", result: "match" }) + j({ at, agent: "gardener", ref: "gmail:f2", result: "no-match" }));
  writeFileSync(join(root, "log", "alerts.jsonl"), j({ at, agent: "gardener", check: "gardener_hours", detail: SECRET }) + j({ at, agent: "town", check: "write_conflict", from: "people/bo#role", detail: SECRET }));
  writeFileSync(join(root, "inbox", "decided", "p1.yaml"), `request: {agent: gardener, id: people/ana, attribute: role, value: ${SECRET}, sources: [gmail:f1]}\ndecided: 2026-10-08\ndecision: reject\nsource_check: {result: match, quote: ${SECRET}}\n`);
  writeFileSync(join(root, "inbox", "p2.yaml"), `request: {agent: gardener, id: people/bo, attribute: role, value: ${SECRET}}\n`);
  const agents = mkdtempSync(join(tmpdir(), "pb-agents-"));
  mkdirSync(join(agents, "agents", "gardener"), { recursive: true });
  writeFileSync(join(agents, "agents", "gardener", "agent.md"), `---\nname: gardener\nmodel: claude-haiku-5-5\ntools:\n  - type: mcp_toolset\n    configs:\n      - {name: orientation, enabled: true}\n      - {name: verify_source, enabled: false}\n---\nYou are the gardener. ${SECRET}\n`);
  const logs = mkdtempSync(join(tmpdir(), "pb-logs-"));
  writeFileSync(join(logs, "pocketbrain.log"), `x night: gardener silent 36h+, ran locally\nerror reading ${SECRET}\n`);
  appendFileSync(join(logs, "pocketbrain.log"), "y night: 3 upkeep finding(s); r\n");

  const out = audit(root, { agents, ant: false, logs });
  const text = JSON.stringify(out);
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain("gmail:f1");
  const run = out.runs[0];
  expect(run).toMatchObject({ run: "u1", upkeep_findings: 4, sleep_retired: 2, tool_calls: { search: 1, verify_source: 1 }, verify_source: { match: 1, "no-match": 1 }, alerts: { gardener_hours: 1, write_conflict: 1 } });
  expect(run.proposals).toEqual([{ key: "people/ana#role", fate: "reject 2026-10-08" }, { key: "people/bo", fate: "open" }]);
  expect(out.proposals_all_time).toMatchObject({ open: 1, decided: { reject: 1 }, source_check: { match: 1, none: 1 }, no_source: 1 });
  expect(out.rails.cap_hits).toEqual([at]);
  expect(out.rails.tripwire).toEqual([at]);
  expect(out.clashes.write_conflicts_since_first_run).toEqual([{ at, key: "people/bo#role", gardener_proposed_on_note: true }]);
  expect(out.agent_config.gardener).toEqual({ model: "claude-haiku-5-5", tools: ["orientation"], prompt_names_verify_source: false, prompt_names_memory_sync: false });
  expect(out.hub_logs["pocketbrain.log"]).toMatchObject({ fallback_ran_locally: 1, night_local: 1 });
});
