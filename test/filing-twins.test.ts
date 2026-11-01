// SPDX-License-Identifier: AGPL-3.0-only
// G600: the inbox folds a second proposal of the same value for one fact under the first one's card
// (inboxCards' twins), but each is still its own open item. Filing looked proposals up by card only,
// so a twin was never found and waited as "It came from your own material" (owner's Mac after
// c6a01746, 2026-11-01: 4 imported facts). A twin is judged as its own proposal.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { verdict, autoSaves } from "../src/filing";
import { loadEscalation } from "../src/textline/policy";
import { loadBrain } from "../src/brain";
import { git } from "../src/git";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const OWN = "It came from your own material, so it waits for you.";
const files = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml")).sort();
const judge = (root: string, f: string) => verdict(root, { kind: "proposal", key: `proposal:${f}`, ref: f } as never, loadEscalation(root), { notes: loadBrain(root) });

test("G600: a twin of a handback the assistant can't see all of waits the same way, never as your own material", () => {
  const root = makeBrain();
  write(root, { agent: "steward", kind: "fact", id: "people/jane-roy", attribute: "org", value: "Globex", as_of: "2026-10-01", sources: ["gmail:f000000000000002"], share_with: ["steward"] } as never);
  for (const s of ["agent:planner", "gmail:f000000000000003"]) expect(write(root, { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "org", value: "Acme", as_of: "2026-10-05", sources: [s] } as never).outcome).toBe("inbox");
  const fs = files(root);
  expect(fs.length).toBe(2);
  const vs = fs.map((f) => JSON.stringify(judge(root, f)));
  expect(vs[0]).toBe(vs[1]);
  expect(vs.join()).not.toContain(OWN);
});

test("G600: an assistant's twin proposal gets its card's verdict under file all", () => {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["add", "rules/escalation.yaml"]); git(root, ["commit", "-q", "-m", "owner: file all"]);
  // A trial assistant proposes; the same value twice is one card with a twin.
  for (const s of ["agent:planner", "gmail:f000000000000004"]) write(root, { agent: "helper", kind: "fact", id: "people/jane-roy", attribute: "office", value: "Room 4", as_of: "2026-10-05", sources: [s] } as never);
  const fs = files(root);
  expect(fs.length).toBe(2);
  const vs = fs.map((f) => judge(root, f));
  expect(vs.map((v) => Object.keys(v)[0])).toEqual([Object.keys(vs[0])[0], Object.keys(vs[0])[0]]);
  expect(JSON.stringify(vs)).not.toContain(OWN);
  expect(autoSaves(root).size).toBe(0); // a trial assistant's: neither is a save
});

// Coordinator's call (2026-11-01): an assistant's capture that cites a mail and is about a person
// waits for the owner by the source-save rule ("It's about a person"); under the scope freeze it
// keeps waiting, on Settings, and the north star counts it on its own line, never as an ask.
test("north star counts an assistant's captured person fact that waits by rule as held_by_capture, not an ask", async () => {
  const { measure, counts } = await import("../scripts/north-star");
  const { mkdirSync } = await import("node:fs");
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all, source_saves_per_day: 20 }\n");
  mkdirSync(join(root, "inbox"), { recursive: true }); mkdirSync(join(root, "captures"), { recursive: true });
  writeFileSync(join(root, "captures", "2026-10-08-c1.md"), "---\nvia: agent\nby: planner\n---\nJane is in room 4.\n");
  writeFileSync(join(root, "inbox", "2026-10-08-planner-c1.yaml"), "by: planner\nreason: \"captured: a new fact\"\ncapture: captures/2026-10-08-c1.md\nrequest: { agent: planner, kind: fact, id: people/jane-roy, attribute: office, value: Room 4, as_of: 2026-10-07, sources: [\"gmail:f000000000000005\"] }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: a capture"]);
  expect(JSON.stringify(judge(root, "2026-10-08-planner-c1.yaml"))).toContain("about a person");
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.held_by_capture).toBe(1);
  expect(m.asks).toBe(0);
  expect(counts(m).held_by_capture).toBe(1);
}, 60_000);
