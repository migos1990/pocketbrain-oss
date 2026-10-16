// SPDX-License-Identifier: AGPL-3.0-only
// Red-team probe: a co-owner's word on a fact her assistant can't see (a private fact on a
// personal household note). Her word ranks as the owner's, so it replaces or retracts the
// owner's private fact without her ever seeing it.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadRules } from "../src/rules";
import { loadBrain, type FactRecord } from "../src/brain";
import { carve, grantFor } from "../src/carve";
import { write } from "../src/write";

const NOTE = `---
id: projects/kids-pickup
type: project
title: Kids pickup
area: household
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  pickup_time: { value: "15:30", as_of: 2026-10-01, sources: ["owner:2026-10-01/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }
  custody_note: { value: "lawyer says keep weekends", sensitivity: private, as_of: 2026-10-01, sources: ["owner:2026-10-01/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }
---
Who picks up the kids.
`;
function household() {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8"));
  p.areas.household = { owner: "steward" };
  p.agents["sam-assistant"] = { tier: "core", slices: ["area:household"] };
  p.co_owners = { sam: { name: "Sam Roy", areas: ["household"], agents: ["sam-assistant"] } };
  writeFileSync(f, YAML.stringify(p));
  mkdirSync(join(root, "projects"), { recursive: true });
  writeFileSync(join(root, "projects", "kids-pickup.md"), NOTE);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", "fx"], { cwd: root });
  return root;
}
const fact = (root: string, a: string) => loadBrain(root).find((n) => n.fm.id === "projects/kids-pickup")!.fm.facts?.[a] as FactRecord | undefined;
const SAM = { agent: "sam-assistant", id: "projects/kids-pickup", sources: ["owner:2026-10-08/chat"], verification: "confirmed-by-owner" as const };

test("precondition: her assistant can't see the owner's private fact", () => {
  const root = household(); const rules = loadRules(root);
  const res = carve(loadBrain(root), rules, grantFor(rules, "sam-assistant"));
  expect(res.visible.has("projects/kids-pickup")).toBe(true);
  expect(res.hiddenFacts.map((h) => h.key)).toContain("projects/kids-pickup#custody_note");
});

test("her word can't retract the owner's private fact she was never shown", () => {
  const root = household();
  const r = write(root, { ...SAM, attribute: "custody_note", value: "x", as_of: "2026-10-08", retract: true });
  expect(r.outcome).not.toBe("committed");
  expect(fact(root, "custody_note")?.value).toBe("lawyer says keep weekends");
});

test("her word can't replace the owner's private fact she was never shown", () => {
  const root = household();
  const r = write(root, { ...SAM, attribute: "custody_note", value: "every other weekend", as_of: "2026-10-08" });
  expect(r.outcome).not.toBe("committed");
  expect(fact(root, "custody_note")?.value).toBe("lawyer says keep weekends");
});
