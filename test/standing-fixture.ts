// SPDX-License-Identifier: AGPL-3.0-only
// The standing fixture: the sample brain plus Sam (partner, owner-confirmed address) and Jane's
// source-verified address, with a standing.yaml, and fake mail traffic for suggestions.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { recordInteraction } from "../src/standing";

export const SAM = `---
id: people/sam-roy
type: person
title: Sam Roy
area: personal
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: steward
facts:
  emails: { items: [{ value: "sam@example.com", as_of: 2026-09-01, sources: ["owner:2026-09-01/dashboard"], verification: confirmed-by-owner, by: owner, recorded: 2026-10-01 }, { value: "sam.new@example.com", as_of: 2026-10-05, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-05 }, { value: "sam.claimed@example.com", as_of: 2026-10-05, sources: ["agent:steward"], verification: self-reported, by: steward, recorded: 2026-10-05 }] }
---
Partner.
`;
const JANE_EMAIL = `  emails: { items: [{ value: "jane@northfield.example", as_of: 2026-09-01, sources: ["gmail:f000000000000001"], verification: verified-by-source, by: planner, recorded: 2026-10-01 }] }\n`;

export function brain(standing?: Record<string, unknown>) {
  const root = makeBrain();
  writeFileSync(join(root, "people", "sam-roy.md"), SAM);
  const jane = readFileSync(join(root, "people", "jane-roy.md"), "utf8").replace(/(\n---\n)/, `\n${JANE_EMAIL.trimEnd()}$1`);
  writeFileSync(join(root, "people", "jane-roy.md"), jane);
  writeFileSync(join(root, "rules", "standing.yaml"), YAML.stringify(standing ?? {
    me: ["robin@example.com"],
    people: {
      "people/sam-roy": { tier: "inner", addresses: ["sam@example.com"] },
      "people/jane-roy": { tier: "known", authority: "owner" },
    },
  }));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "commit", "-q", "-m", "standing fixture"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "louis", GIT_AUTHOR_EMAIL: "l@x", GIT_COMMITTER_NAME: "louis", GIT_COMMITTER_EMAIL: "l@x" } });
  return root;
}
export function traffic(root: string, addr: string, inbound: number, outbound: number, replyMinutes = 30) {
  let t = Date.parse("2026-09-01T12:00:00Z");
  for (let i = 0; i < Math.max(inbound, outbound); i++) {
    if (i < inbound) recordInteraction(root, { kind: "gmail", from: addr, to: "robin@example.com", at: new Date(t).toISOString() });
    t += replyMinutes * 60_000;
    if (i < outbound) recordInteraction(root, { kind: "gmail", from: "Robin <robin@example.com>", to: addr, at: new Date(t).toISOString() });
    t += 24 * 3600_000;
  }
}
