// SPDX-License-Identifier: AGPL-3.0-only
// The use-it check on a clone (2026-10-27): a page started from the box, its role confirmed, then
// (1) the line was cut from the home by the 7-line cap, so the owner couldn't see or undo what they
// had just typed; (2) after Undo the page's prose still said the role; (3) the page stayed, empty.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { loadBrain } from "../src/brain";
import { loadRules } from "../src/rules";
import { readDiary, appendDiary, diaryRow } from "../src/diary";
import { homeView, SINCE_CAP } from "../src/dashboard/home";
import { undoFact } from "../src/undo";

// A new name with "is a <role>" starts its page in personal right away (Louis, 2026-10-29, G474).
function startPage(root: string) {
  expect(ownerSay(root, "Zed Quorum is a ski instructor").kind).toBe("say.noted");
  return loadBrain(root).find((x) => x.fm.title === "Zed Quorum")!;
}

test("what the owner just said shows on the home whatever the cap", () => {
  const root = makeBrain();
  const now = new Date();
  // A busy day of less certain lines from assistants, all after the owner's.
  startPage(root);
  for (let i = 0; i < SINCE_CAP + 3; i++) {
    appendDiary(root, { ...diaryRow({ at: new Date(now.getTime() + 1000 * (i + 1)).toISOString(), factKey: `people/jane-roy#note_${i}`, title: "Jane Roy", kind: "new", from: undefined, to: `guess ${i}`, incoming: { value: `guess ${i}`, as_of: "2026-10-01", sources: ["agent:planner"], verification: "unverified", confidence: "inferred", by: "planner", recorded: "2026-10-01" }, rank: 1, sensitivity: "personal" }) }, now.toISOString().slice(0, 7));
  }
  const v = homeView(root, loadRules(root), loadBrain(root), new Date(now.getTime() + 60_000));
  expect(v.since[0]!.what).toContain("Zed");
});

test("undo of the only fact on a page started from the box takes the page and its text away", () => {
  const root = makeBrain();
  const n = startPage(root);
  const row = readDiary(root).find((r) => r.fact_key === `${n.fm.id}#role`)!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  expect(loadBrain(root).find((x) => x.fm.id === n.fm.id)).toBeUndefined();
  expect(Bun.spawnSync(["git", "status", "--porcelain", "--", n.path], { cwd: root }).stdout.toString()).toBe("");
  expect(Bun.spawnSync(["git", "ls-files", "--", n.path], { cwd: root }).stdout.toString()).toBe("");
});

test("after undo a page that keeps other facts no longer tells the undone value", () => {
  const root = makeBrain();
  const n = startPage(root);
  expect(ownerSay(root, "Zed Quorum works at Bay Institute").kind).toBe("say.noted");
  const row = readDiary(root).find((r) => r.fact_key === `${n.fm.id}#role`)!;
  expect(undoFact(root, row.undo_token).outcome).toBe("undone");
  const after = loadBrain(root).find((x) => x.fm.id === n.fm.id)!;
  expect(after.body).not.toContain("ski instructor");
});
