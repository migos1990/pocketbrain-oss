// SPDX-License-Identifier: AGPL-3.0-only
// After G601 went live (owner's Mac, a6921606, 2026-11-01, counts only), 6 imported and captured
// facts waited as "Its name fits more than one note". They name a page by title (a capture names
// its subject, never an id), and the name fits a page the brain has as well as a new one: the write
// path asks "new or same as …?" and the hub must not guess. That is a rule wait, like held_by_access:
// it waits on Settings and the north star counts it on its own line, never as an ask (G603).
// And a decided copy whose fact one of those pages already holds landed: reopen leaves it decided.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write, reopenLostAccepts } from "../src/write";
import { verdict } from "../src/filing";
import { loadEscalation } from "../src/textline/policy";
import { loadBrain } from "../src/brain";
import { git } from "../src/git";

beforeEach(() => { process.env.PB_CONFIG_DIR = mkdtempSync(join(tmpdir(), "pb-cfg-")); });
afterEach(() => { delete process.env.PB_CONFIG_DIR; });

const fileAll = (root: string) => {
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["add", "rules/escalation.yaml"]); git(root, ["commit", "-q", "-m", "owner: file all"]);
};
const open = (root: string) => readdirSync(join(root, "inbox")).filter((f) => f.endsWith(".yaml"));

// One counted list (owner, 2026-11-01, through the coordinator after "i trust u"; audit v10): a held item is still an ask, its held line only says why.
test("G603: a by-name proposal whose name fits a page and a new one waits, counted in asks, with held_by_ambiguity saying why", async () => {
  const { measure, counts } = await import("../scripts/north-star");
  const root = makeBrain();
  fileAll(root);
  // "Jan Roy" could be Jane Roy or someone new: the write asks, it never guesses.
  const r = write(root, { agent: "planner", kind: "fact", title: "Jan Roy", type: "person", area: "work", attribute: "office", value: "Room 4", as_of: "2026-10-05", sources: ["gmail:f000000000000006"] } as never);
  expect(r.outcome).toBe("inbox");
  const [f] = open(root);
  const v = verdict(root, { kind: "proposal", key: `proposal:${f}`, ref: f } as never, loadEscalation(root), { notes: loadBrain(root) });
  expect("never" in v).toBe(true);
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.held_by_ambiguity).toBe(1);
  expect(m.asks).toBe(1);
  expect(m.asks_by_kind.held_by_ambiguity).toBe(1);
  expect(m.not_conflict).toBe(1);
  expect(counts(m).held_by_ambiguity).toBe(1);
}, 60_000);

test("G603: a decided copy by a name that fits pages, one of which holds its fact, stays decided", () => {
  const root = makeBrain();
  write(root, { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "office", value: "Room 4", as_of: "2026-10-05", sources: ["gmail:f000000000000007"] } as never);
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", "c1.md"), "---\nvia: import\nby: planner\n---\nx\n");
  writeFileSync(join(root, "inbox", "decided", "2026-10-06-planner-c1.yaml"), "by: auto-decide\ndecision: accept\ncapture: inbox/captures/c1.md\nreason: \"captured: a new fact\"\nrequest: { agent: planner, kind: fact, title: Jan Roy, type: person, attribute: office, value: Room 4, as_of: 2026-10-05, sources: [\"gmail:f000000000000007\"] }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: a decided copy"]);
  expect(reopenLostAccepts(root)).toEqual([]);
  expect(existsSync(join(root, "inbox", "2026-10-06-planner-c1.yaml"))).toBe(false);
});

test("G603: a decided copy by a name that fits pages, none holding its fact, still reopens", () => {
  const root = makeBrain();
  mkdirSync(join(root, "inbox", "decided"), { recursive: true });
  mkdirSync(join(root, "inbox", "captures"), { recursive: true });
  writeFileSync(join(root, "inbox", "captures", "c1.md"), "---\nvia: import\nby: planner\n---\nx\n");
  writeFileSync(join(root, "inbox", "decided", "2026-10-06-planner-c1.yaml"), "by: auto-decide\ndecision: accept\ncapture: inbox/captures/c1.md\nreason: \"captured: a new fact\"\nrequest: { agent: planner, kind: fact, title: Jan Roy, type: person, attribute: office, value: Room 9, as_of: 2026-10-05, sources: [\"gmail:f000000000000008\"] }\n");
  git(root, ["add", "-A"]); git(root, ["commit", "-q", "-m", "fixture: a decided copy"]);
  expect(reopenLostAccepts(root)).toEqual(["2026-10-06-planner-c1.yaml"]);
});
