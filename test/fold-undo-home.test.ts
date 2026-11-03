// SPDX-License-Identifier: AGPL-3.0-only
// The home's Undo for a fold is the fold's own (audit v11). The diary catch-up used to turn a fold
// commit into one line per moved fact, each with a fact Undo that took back one value and left the
// two pages folded. A fold is now one line that says two pages became one, and its Undo undoes the
// fold, after later writes too; undone from the command line, the line stops offering it.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { foldTwins, undoFold, foldLog } from "../src/fold";
import { catchUpDiary } from "../src/diary-catchup";
import { readDiary } from "../src/diary";
import { undoFact } from "../src/undo";
import { pageLines } from "../src/dashboard/home";

const blind = (root: string, attribute: string, value: string) =>
  write(root, { agent: "planner", type: "project", title: "Garden planning", area: "personal", attribute, value, as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source" } as never);
const active = (root: string) => loadBrain(root).filter((n) => /garden-planning/.test(n.fm.id) && n.fm.status === "active");
const now = new Date("2026-10-08T14:00:00Z");

function folded() {
  const root = makeBrain();
  blind(root, "status", "active");
  blind(root, "next_step", "book a session");
  catchUpDiary(root, now);
  const r = foldTwins(root, { apply: true });
  catchUpDiary(root, now);
  return { root, fold: r.folds[0]! };
}

test("a fold is one diary line, and its Undo undoes the fold even after a later write", () => {
  const { root, fold } = folded();
  const rows = readDiary(root).filter((x) => x.commit === fold.commit);
  expect(rows.map((x) => x.kind)).toEqual(["folded"]);
  const line = pageLines(root, loadRules(root), loadBrain(root), fold.keep).find((l) => l.token === rows[0]!.undo_token)!;
  expect(line.what).toMatch(/one page/);
  expect(line.undo).toBe("undo");
  write(root, { agent: "owner", id: fold.keep, attribute: "budget_note", value: "seeds first", as_of: "2026-10-08", sources: ["owner:2026-10-08/home"], verification: "confirmed-by-owner" } as never, { owner: true });
  const u = undoFact(root, rows[0]!.undo_token);
  expect(u.outcome).toBe("undone");
  expect(active(root)).toHaveLength(2);
  const again = pageLines(root, loadRules(root), loadBrain(root), fold.keep).find((l) => l.token === rows[0]!.undo_token);
  expect(again?.undo).toBe("undone");
  // The undo's own commit makes no fact lines of its own on a later catch-up.
  catchUpDiary(root, now);
  const undoCommit = foldLog(root).find((f) => f.undone === fold.commit)!.undo_commit!;
  expect(undoCommit).toMatch(/^[0-9a-f]{40}$/);
  expect(readDiary(root).filter((x) => x.commit === undoCommit)).toHaveLength(0);
});

test("a fold undone from the command line stops offering Undo on the home", () => {
  const { root, fold } = folded();
  const row = readDiary(root).find((x) => x.commit === fold.commit)!;
  undoFold(root, fold.commit!);
  const line = pageLines(root, loadRules(root), loadBrain(root), fold.keep).find((l) => l.token === row.undo_token);
  expect(line?.undo).toBe("undone");
});

test("a fold's line follows either page's privacy now, as every other line does", () => {
  for (const which of ["keep", "drop"] as const) {
    const { root, fold } = folded();
    const row = readDiary(root).find((x) => x.commit === fold.commit)!;
    const id = which === "keep" ? fold.keep : fold.drop;
    const lineWith = (fm: Record<string, unknown>) => pageLines(root, loadRules(root), loadBrain(root).map((n) => n.fm.id === id ? { ...n, fm: { ...n.fm, ...fm } } : n) as never, fold.keep).find((l) => l.token === row.undo_token)!.what;
    // Private now, with a plain name: the line names it, as a held card would.
    expect(lineWith({ sensitivity: "private" })).toContain("Garden planning");
    // Private now, with a name shaped like health, money or legal: no name.
    expect(lineWith({ sensitivity: "private", title: "Divorce lawyer" })).toMatch(/^Two pages only you can see/);
  }
});
