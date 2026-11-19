// SPDX-License-Identifier: AGPL-3.0-only
// A start changes nothing it has no reason to (G1012). The hub's start runs repairs for what older
// code left behind (START_REPAIRS in src/start.ts). On 2026-11-19 one of them took 26 things the
// hub had set aside on purpose for things it had lost and handed them back to the owner at every
// restart (G1006, G1007). Each repair was tested on the shape it repairs; none on a brain where the
// owner had since settled, undone and set things aside. This runs the whole list, as start does:
// on a week today's code made, then after each kind of settling, twice. Every run must leave the
// brain's commit, its files, the inbox and what waits on the owner exactly as they were.
import { test, expect } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeDemoBrain } from "./fixture";
import { START_REPAIRS } from "../src/start";
import { ownerConflicts, ownerDecide, ownerKeepBoth } from "../src/core";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { setAsideMachineMail } from "../src/receipt-pages";
import { recordMachineMail } from "../src/louis";
import { ownerAsks } from "../src/waiting";
import { adoptHandEdits } from "../src/wiki";

const sh = (cwd: string, ...cmd: string[]) => Bun.spawnSync(cmd, { cwd }).stdout.toString().trim();
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort() : []);
const state = (root: string) => ({
  head: sh(root, "git", "rev-parse", "HEAD"),
  dirty: sh(root, "git", "status", "--porcelain", "--", ".", ":!log"),
  inbox: list(join(root, "inbox")),
  decided: list(join(root, "inbox", "decided")).length,
  asks: ownerAsks(root).total,
});
// What `start` does before it serves: hand edits adopted, then every repair, in order.
const start = (root: string) => { adoptHandEdits(root); return START_REPAIRS.map((r) => [r.name, r.run(root)] as const).filter(([, n]) => n); };
const startChangesNothing = (root: string, when: string) => {
  const before = state(root);
  for (const nth of ["first", "second"]) {
    expect({ when, start: nth, did: start(root) }).toEqual({ when, start: nth, did: [] });
    expect({ when, start: nth, ...state(root) }).toEqual({ when, start: nth, ...before });
  }
};

test("G1012 a start, and a second one, change nothing on a week today's code made, nor after the owner settled, undid and set things aside", async () => {
  const { root, conflicts } = await makeDemoBrain();
  startChangesNothing(root, "the replayed week");

  // The owner answers one question and keeps both sides of another.
  const open = ownerConflicts(root).map((c) => c.id);
  expect(open.length).toBeGreaterThanOrEqual(2);
  expect(conflicts.length).toBeGreaterThan(0);
  ownerDecide(root, open[0]!, 1);
  startChangesNothing(root, "after an answer");
  ownerKeepBoth(root, open[1]!);
  startChangesNothing(root, "after keep both");

  // The owner undoes the newest line that can be undone.
  const undone = readDiary(root).reverse().map((r) => r.undo_token).filter((t): t is string => !!t).map((t) => undoFact(root, t)).find((r) => r.outcome === "undone");
  expect(undone?.outcome).toBe("undone");
  startChangesNothing(root, "after an Undo");

  // The hub sets aside what came only from machine mail: every mail a capture the hub accepted cites.
  const refs = new Set<string>();
  for (const f of list(join(root, "inbox", "decided"))) {
    const p = YAML.parse(readFileSync(join(root, "inbox", "decided", f), "utf8")) ?? {};
    if (p.decision === "accept" && p.by === "auto-decide" && typeof p.capture === "string") for (const s of p.request?.sources ?? []) if (typeof s === "string" && s.startsWith("gmail:")) refs.add(s);
  }
  expect(refs.size).toBeGreaterThan(0);
  recordMachineMail(root, [...refs]);
  const aside = setAsideMachineMail(root, true);
  expect(aside.facts).toBeGreaterThan(0);
  startChangesNothing(root, "after machine mail was set aside");

  // And an Undo of one of those set-asides.
  const back = readDiary(root).reverse().filter((r) => r.kind === "set_aside" || r.why === "machine").map((r) => r.undo_token).filter((t): t is string => !!t).map((t) => undoFact(root, t)).find((r) => r.outcome === "undone");
  if (back) startChangesNothing(root, "after a set-aside was undone");
}, 120_000);
