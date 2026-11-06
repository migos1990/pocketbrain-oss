// SPDX-License-Identifier: AGPL-3.0-only
// Red-team probes: area moves and stale labels around a co-owner's word.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { loadBrain, type FactRecord } from "../src/brain";
import { write } from "../src/write";

const PICKUP = `---
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
  pickup_time: { value: "15:30", as_of: 2026-10-01, sources: ["agent:steward"], verification: self-reported, by: steward, recorded: 2026-10-01 }
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
  writeFileSync(join(root, "projects", "kids-pickup.md"), PICKUP);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-qm", "fx"], { cwd: root });
  return root;
}
const fact = (root: string) => loadBrain(root).find((n) => n.fm.id === "projects/kids-pickup")!.fm.facts?.pickup_time as FactRecord & { dispute?: string };
const moveTo = (root: string, area: string) => {
  const f = join(root, "projects", "kids-pickup.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("area: household", `area: ${area}`));
  Bun.spawnSync(["git", "commit", "-qam", "owner moves it"], { cwd: root });
};

test("the owner's own confirmation of a value she confirmed first survives a move out of her areas", () => {
  const root = household();
  // Sam's word: 16:00.
  expect(write(root, { agent: "sam-assistant", id: "projects/kids-pickup", attribute: "pickup_time", value: "16:00", as_of: "2026-10-05", sources: ["owner:2026-10-05/chat"], verification: "confirmed-by-owner" }).outcome).toBe("committed");
  // The owner, through his own channel, says the same: 16:00 is his word too.
  const r = write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "16:00", as_of: "2026-10-06", sources: ["owner:2026-10-06/text"], verification: "confirmed-by-owner" });
  expect(r.outcome).toBe("committed");
  // The owner moves the note to his personal area.
  moveTo(root, "personal");
  // A later mail's value must not replace the owner's word: it should dispute (step 6). (An
  // assistant's own word never asks against the owner's at all, G677.)
  const r2 = write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "17:00", as_of: "2026-10-07", sources: ["gmail:f000000000000077"], verification: "self-reported" });
  expect(r2.outcome).toBe("disputed");
  expect(fact(root).value).not.toBe("17:00");
});

test("a co-owner's assistant asking to move a household note to another area is refused, not proposed", () => {
  const root = household();
  const before = existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).length : 0;
  const r = write(root, { agent: "sam-assistant", id: "projects/kids-pickup", attribute: "pickup_time", value: "16:00", as_of: "2026-10-05", sources: ["owner:2026-10-05/chat"], verification: "confirmed-by-owner", area: "work" } as any);
  expect(r.outcome).toBe("refused");
  const after = existsSync(join(root, "inbox")) ? readdirSync(join(root, "inbox")).length : 0;
  expect(after).toBe(before);
});

test("the owner's own confirmation of a value she confirmed first survives removing her as co-owner", () => {
  const root = household();
  write(root, { agent: "sam-assistant", id: "projects/kids-pickup", attribute: "pickup_time", value: "16:00", as_of: "2026-10-05", sources: ["owner:2026-10-05/chat"], verification: "confirmed-by-owner" });
  write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "16:00", as_of: "2026-10-06", sources: ["owner:2026-10-06/text"], verification: "confirmed-by-owner" });
  const f = join(root, "rules", "policy.yaml");
  const p = YAML.parse(readFileSync(f, "utf8")); delete p.co_owners; delete p.agents["sam-assistant"]; writeFileSync(f, YAML.stringify(p));
  Bun.spawnSync(["git", "commit", "-qam", "owner removes the co-owner"], { cwd: root });
  const r2 = write(root, { agent: "steward", id: "projects/kids-pickup", attribute: "pickup_time", value: "17:00", as_of: "2026-10-07", sources: ["gmail:f000000000000077"], verification: "self-reported" });
  expect(r2.outcome).toBe("disputed");
});
