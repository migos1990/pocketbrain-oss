// SPDX-License-Identifier: AGPL-3.0-only
// Audit v7, medium-high (G552): Undo on a "Show" line (a `seen` diary row) fell through to the
// new-fact branch, so it deleted the fact and kept it in history as never right, on the 30-day
// sign-in too. Undo of Show is its inverse: the value is held again for the owner, nothing else moves.
// A diary kind with no undo of its own (kept, seen-like rows) never deletes a fact.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { readNote } from "../src/core";
import { markSeen } from "../src/seen";
import { readDiary, appendDiary, diaryRow } from "../src/diary";
import { undoFact } from "../src/undo";
import { loadBrain, type FactRecord } from "../src/brain";

const rec = (root: string, attr: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.facts![attr] as (FactRecord & { unseen?: boolean }) | undefined;
const hist = (root: string, attr: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!.fm.history?.[attr] ?? [];
const sees = (root: string, needle: string) => JSON.stringify(readNote(root, "planner", "people/jane-roy")).includes(needle);

test("Undo of Show holds the value again; it never deletes the fact or marks it never right (G552)", () => {
  const root = makeBrain();
  expect(write(root, { agent: "planner", id: "people/jane-roy", attribute: "home_town", value: "Rimouski-Est", as_of: "2026-10-05", sources: ["gmail:f000000000000002"], verification: "verified-by-source", sensitivity: "private" } as never).outcome).toBe("committed");
  expect(markSeen(root, "people/jane-roy#home_town").outcome).toBe("seen");
  const seen = readDiary(root).at(-1)!;
  expect(seen.kind).toBe("seen");
  expect(rec(root, "home_town")?.unseen).toBeUndefined();
  const r = undoFact(root, seen.undo_token);
  expect(r.outcome).toBe("undone");
  const now = rec(root, "home_town");
  expect(now?.value).toBe("Rimouski-Est");
  expect(now?.valid_to).toBeUndefined();
  expect(now?.unseen).toBe(true);
  expect(hist(root, "home_town").some((h) => h.ended_by?.correction)).toBe(false);
  expect(sees(root, "Rimouski-Est")).toBe(false);
  // Twice is once.
  expect(undoFact(root, seen.undo_token).outcome).toBe("already_undone");
});

test("a kept line has nothing to undo: the owner's word stays (G552)", () => {
  const root = makeBrain();
  const before = rec(root, "role")?.value;
  // A kept row whose value happens to equal the live one must still never delete it.
  const row = diaryRow({ at: new Date().toISOString(), factKey: "people/jane-roy#role", title: "Jane Roy", kind: "kept", from: undefined, to: before, incoming: { value: before, as_of: "2026-10-01", sources: ["gmail:f000000000000009"], verification: "verified-by-source", by: "planner", recorded: "2026-10-01" } as never, rank: 3, sensitivity: "personal" });
  appendDiary(root, row, row.at.slice(0, 7));
  expect(undoFact(root, row.undo_token).outcome).toBe("not_undoable");
  expect(rec(root, "role")?.value).toBe(before);
});
