// SPDX-License-Identifier: AGPL-3.0-only
// By the owner's typed yes (2026-11-16): an assistant's fact on a page it can't fully see used to
// wait as an ask in Settings (held_by_access, G598, G618). It contradicts nothing, so it is a guess:
// a Not confirmed line on the home, in no count, kept with Keep. It still waits in the inbox as
// before and never expires, so its writer learns nothing new about the page from what happens to it.
import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { git } from "../src/git";
import { loadBrain, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { ownerAsks } from "../src/waiting";
import { unconfirmedLines } from "../src/dashboard/home";
import { keepGuesses } from "../src/keep-guess";
import { runAuto } from "../src/filing";

const FILE = "2026-10-08-planner-acc00001.yaml", MONEY = "2026-10-08-planner-acc00002.yaml", OWNS = "2026-10-08-planner-acc00003.yaml";
function brain() {
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["add", "rules/escalation.yaml"]); git(root, ["commit", "-q", "-m", "owner: file all"]);
  mkdirSync(join(root, "inbox"), { recursive: true });
  return root;
}
const card = (root: string, file: string, attribute: string, value: string, sources = ["gmail:f0000000000000e1"]) =>
  writeFileSync(join(root, "inbox", file), YAML.stringify({ proposed: "2026-10-08", by: "planner", reason: `the owner decides people/jane-roy#${attribute} (not_in_your_view)`, request: { agent: "planner", kind: "fact", id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources, verification: "verified-by-source" } }));
const lines = (root: string) => unconfirmedLines(root, loadRules(root), new Map(loadBrain(root).map((n) => [n.fm.id, n])), ownerAsks(root));

test("an assistant's fact on a page it can't fully see is a Not confirmed line, in no count", () => {
  const root = brain();
  const before = ownerAsks(root).total;
  card(root, FILE, "office", "Room 12 beside the library stairs");
  const asks = ownerAsks(root);
  expect(asks.by.held_by_access).toBeUndefined();
  expect(asks.total).toBe(before);
  expect(asks.settings).toBe(0);
  expect([...asks.byAccess]).toEqual([FILE]);
  const l = lines(root);
  expect(l).toHaveLength(1);
  expect(l[0]!.from).toContain("Not confirmed");
  expect(l[0]!.keep?.file).toBe(FILE);
});

test("it waits as before: the hub's tick neither files it nor lets it expire", () => {
  const root = brain();
  card(root, FILE, "office", "Room 12 beside the library stairs");
  expect(ownerAsks(root).queues.expiring.has(FILE)).toBe(false);
  runAuto(root, new Date("2026-12-20T15:00:00Z"));
  expect(existsSync(join(root, "inbox", FILE))).toBe(true);
  expect(loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.office).toBeUndefined();
});

test("Keep files it as the owner's accept", () => {
  const root = brain();
  card(root, FILE, "office", "Room 12 beside the library stairs");
  const k = lines(root)[0]!.keep!;
  expect(keepGuesses(root, [k]).kept).toBe(1);
  expect((loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts!.office as FactRecord).value).toBe("Room 12 beside the library stairs");
  expect(lines(root)).toHaveLength(0);
});

test("what still asks: a money-shaped one, and one that says it is the owner's word", () => {
  const root = brain();
  card(root, MONEY, "fee", "Owes $4,200 for the spring invoice");
  card(root, OWNS, "office", "Room 12 beside the library stairs", ["owner:2026-10-05/say"]);
  const asks = ownerAsks(root);
  expect(asks.by.held_by_access).toBe(2);
  expect(asks.byAccess.size).toBe(0);
  expect(lines(root)).toHaveLength(0);
});

test("the north star reports them apart from asks", async () => {
  const { measure, report } = await import("../scripts/north-star");
  const root = brain();
  card(root, FILE, "office", "Room 12 beside the library stairs");
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  expect(m.held_by_access).toBe(0);
  expect(m.access_guess).toBe(1);
  expect(report(m, "x")).toContain("1 more shown as Not confirmed (not asks)");
});
