// SPDX-License-Identifier: AGPL-3.0-only
// Slice audit of G603 (tree 40f38da6), builder. A capture the hub accepted with nothing
// saved (by name "Jane Roy", org Acme) whose name now fits two pages: people/jane-roy (the person it
// was about, no org) and a namesake page that happens to hold org Acme. On a6921606 it is reopened and
// reaches the owner ("Its name fits more than one note"); on 40f38da6 the namesake's value counts as
// "landed" and the lost fact stays decided, silently. Integrity only (no agent sees either outcome).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { reopenLostAccepts } from "../src/write";
import { git } from "../src/git";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

test("G603 audit: a namesake page's equal value never keeps a lost by-name fact from the owner", () => {
  const root = makeBrain();
  writeFileSync(join(root, "people", "jane-roy-7f3a2c.md"), `---\nid: people/jane-roy-7f3a2c\ntype: person\ntitle: Jane Roy\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-05\nupdated: 2026-10-05\nby: planner\nfacts:\n  org: { value: Acme, as_of: 2026-10-05, sources: ["gmail:f000000000000003"], verification: self-reported, by: planner, recorded: 2026-10-05 }\n---\nA different Jane Roy (a student's parent).\n`);
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  const f = "2026-10-04-capture-cccc3333.yaml";
  writeFileSync(join(root, "inbox", "decided", f), YAML.stringify({ proposed: "2026-10-04", by: "auto-decide", decided: "2026-10-04", decision: "accept", reason: "capture inbox/captures/2026-10-04-c3.md: a new fact", checks: ["capture"], capture: "inbox/captures/2026-10-04-c3.md",
    request: { agent: "steward", kind: "fact", title: "Jane Roy", type: "person", attribute: "org", value: "Acme", as_of: "2026-10-04", sources: ["doc:capture/2026-10-04-c3"], source_type: "document" } }));
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture"]);
  const out = reopenLostAccepts(root);
  expect(out).toEqual([f]);
  expect(existsSync(join(root, "inbox", f))).toBe(true);
});
