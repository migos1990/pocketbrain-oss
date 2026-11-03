// SPDX-License-Identifier: AGPL-3.0-only
// Audit v11 finding 8 (unchanged from v10): the hub's filing weighed a by-name proposal against
// every note, while the write it then runs resolves the name over the writer's own view (write.ts,
// invariant 3). A name that fits a page the writer can't see was planned as "held it as a conflict"
// against that hidden page, then the write made a new page and the row said "a newer value ... the
// write updated it". And a hub yes the write handed back as a new proposal (a check it fails) was
// logged "saved it" with Undo and no page, and the new proposal then failed every tick (G650).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { verdict, runAuto } from "../src/filing";
import { loadEscalation } from "../src/textline/policy";
import { loadBrain } from "../src/brain";
import { git } from "../src/git";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

// planner, a core assistant, can't see people/paul-advisor (role: Financial advisor) or money/main-bank.
function brainWith(request: string) {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  mkdirSync(join(root, "inbox"), { recursive: true });
  writeFileSync(join(root, "inbox", "2026-10-06-planner-x1.yaml"), `by: planner\nreason: "outside its areas"\nrequest: { agent: planner, kind: fact, ${request}, as_of: 2026-10-05, sources: ["gmail:f000000000000007"] }\n`);
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: a proposal"]);
  return root;
}
const open = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"));
const verdictOf = (root: string, f: string) => verdict(root, { kind: "proposal", key: `proposal:${f}`, ref: f } as never, loadEscalation(root), { notes: loadBrain(root) });
const errors = (root: string) => { const p = join(root, "log", "auto-decisions-errors.jsonl"); return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).length : 0; };

test("a by-name proposal is weighed over the writer's view: a hidden namesake's value is no conflict", () => {
  const root = brainWith("title: Paul Advisor, type: person, area: personal, attribute: role, value: Retired pilot");
  const v = verdictOf(root, "2026-10-06-planner-x1.yaml");
  expect("plan" in v && v.plan.label).toBe("saved it");
  expect("plan" in v && v.plan.why).toContain("new page");
  const [row] = runAuto(root, new Date(Date.now() + 86_400_000));
  expect(row!.picked).toBe("saved it");
  expect(row!.why).toContain("new page");
  // The hidden page is untouched; the write made the writer's own page.
  const hidden = loadBrain(root).find((n) => n.fm.id === "people/paul-advisor")!;
  expect(Object.keys(hidden.fm.facts ?? {})).toEqual(["role"]);
  expect(loadBrain(root).some((n) => n.fm.id !== "people/paul-advisor" && n.fm.title === "Paul Advisor")).toBe(true);
});

test("a hub yes the write hands back is never logged as saved, and the handed-back proposal waits without failing each tick", () => {
  const root = brainWith("title: Main Bank, type: money, area: personal, attribute: branch, value: Downtown");
  const done = runAuto(root, new Date(Date.now() + 86_400_000));
  expect(done).toHaveLength(1);
  expect(done[0]!.picked).not.toBe("saved it");
  const [again] = open(root);
  expect(again).toBeDefined();
  expect("never" in verdictOf(root, again!)).toBe(true);
  runAuto(root, new Date(Date.now() + 2 * 86_400_000));
  runAuto(root, new Date(Date.now() + 3 * 86_400_000));
  expect(errors(root)).toBe(0);
});
