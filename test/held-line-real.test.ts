// SPDX-License-Identifier: AGPL-3.0-only
// Use-it check on the real brain, 2026-10-29: north-star --brain counted 2 assistant proposals held
// until 2026-10-30, and Settings showed no dated line for them. The real ones are the capture
// agent's private new pages, outside its area: a proposal with a title and type, no id.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { overview } from "../src/dashboard/html";
import { loadState } from "../src/dashboard/data";

const DURING = new Date("2026-10-29T23:00:00Z");

test("Settings gives a held new private page from the capture agent its dated line", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all, hold_assistants_until: 2026-10-30 }\n");
  Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qam", "owner: setup"], { cwd: root });
  mkdirSync(join(root, "inbox"), { recursive: true });
  // As the real ones read: a new page the assistant may not start itself, held private.
  writeFileSync(join(root, "inbox", "2026-10-26-steward-9f8e7d6c.yaml"), YAML.stringify({ proposed: "2026-10-26", by: "steward", reason: "area work is owned by planner (own_area)", request: { agent: "steward", kind: "fact", type: "person", title: "Mara Quill", area: "work", attribute: "role", value: "Clinic lead", as_of: "2026-10-26", sources: ["gmail:1a0e88a496d9705a"], sensitivity: "private", verification: "verified-by-source" } }));
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "steward: propose"], { cwd: root });
  const html = overview({ ...loadState(root), now: DURING }, "x").body;
  expect(html).toMatch(/Files on Oct 30/);
});

// The real brain's list on Settings runs past one page (50 rows); the held ones sort after the others,
// so their dated line sat on a later page. The count and the day lead the list instead.
test("Settings says up top how many assistant proposals are held and the day they file", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all, hold_assistants_until: 2026-10-30 }\n");
  mkdirSync(join(root, "inbox"), { recursive: true });
  for (let i = 0; i < 60; i++) writeFileSync(join(root, "inbox", `2026-10-26-helper-${String(i).padStart(8, "0")}.yaml`), YAML.stringify({ proposed: "2026-10-26", by: "helper", reason: "helper is a trial agent: propose-only", request: { agent: "helper", kind: "fact", id: "projects/course-a", attribute: `note_${i}`, value: `Note ${i}`, as_of: "2026-10-26", sources: [`gmail:f0000000000001${String(i % 99).padStart(2, "0")}`], verification: "verified-by-source" } }));
  writeFileSync(join(root, "inbox", "2026-10-26-steward-9f8e7d6c.yaml"), YAML.stringify({ proposed: "2026-10-26", by: "steward", reason: "area work is owned by planner (own_area)", request: { agent: "steward", kind: "fact", type: "person", title: "Mara Quill", area: "work", attribute: "role", value: "Clinic lead", as_of: "2026-10-26", sources: ["gmail:1a0e88a496d9705a"], sensitivity: "private", verification: "verified-by-source" } }));
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=steward", "-c", "user.email=s@x", "commit", "-qm", "proposals"], { cwd: root });
  const html = overview({ ...loadState(root), now: DURING }, "x").body;
  const top = html.slice(html.indexOf('<h2 id="more">'), html.indexOf('<div class="card">', html.indexOf('<h2 id="more">')));
  expect(top).toContain("1 of your assistants&#39; proposals files on Oct 30, when the hold ends. Nothing to decide now.");
});
