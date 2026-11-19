// SPDX-License-Identifier: AGPL-3.0-only
// scripts/longmemeval.ts: scored the way the benchmark's own retrieval code scores it, on a tiny
// made-up file (the real dataset is never in the repo).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corpusOf, devIds, priorRestRuns, rankSessions, recallAt, skipReason, sliceOf, table, targetsOf, type Item } from "../scripts/longmemeval";

const filler = (n: number) => Array.from({ length: n }, (_, i) => [{ role: "user", content: `Help me plan a garden bed number ${i} with tomatoes and basil.` }, { role: "assistant", content: "Sure, here is a plan." }]);
function item(id: string, over: Partial<Item> = {}): Item {
  const hay = filler(6);
  hay[3] = [{ role: "user", content: "I finally adopted a greyhound called Pepper last weekend.", has_answer: true } as never, { role: "assistant", content: "Congratulations!" }];
  return {
    question_id: id, question_type: "single-session-user", question: "What is the name of the greyhound I adopted?", question_date: "2023/05/30 (Tue) 10:00",
    haystack_session_ids: hay.map((_, i) => (i === 3 ? "answer_a1" : `s_${i}`)), haystack_dates: hay.map(() => "2023/05/20 (Sat) 02:21"), haystack_sessions: hay, ...over,
  };
}

describe("longmemeval retrieval bench", () => {
  test("a session's text is its user turns; an evidence session with no marked user turn is not a target", () => {
    const it = item("q1");
    it.haystack_session_ids[1] = "answer_b2"; // evidence id, but no user turn marked
    const c = corpusOf(it);
    expect(c[3].text).toBe("I finally adopted a greyhound called Pepper last weekend.");
    expect(c[3].text).not.toContain("Congratulations");
    expect(c[1].id).toBe("noans_b2");
    expect(targetsOf(c)).toEqual(["answer_a1"]);
  });

  test("abstention and assistant-only evidence are skipped, as the benchmark skips them", () => {
    expect(skipReason(item("q1_abs"))).toBe("abstention");
    const a = item("q2");
    a.haystack_sessions[3] = [{ role: "user", content: "Tell me about dogs." }, { role: "assistant", content: "Greyhounds are fast.", has_answer: true } as never];
    expect(skipReason(a)).toBe("no-user-target");
    expect(skipReason(item("q3"))).toBeUndefined();
  });

  test("recall any and all at k", () => {
    expect(recallAt(["x", "a", "y"], ["a", "b"], 2)).toEqual({ any: true, all: false });
    expect(recallAt(["x", "a", "b"], ["a", "b"], 3)).toEqual({ any: true, all: true });
    expect(recallAt(["x"], [], 5)).toEqual({ any: false, all: false });
  });

  test("our ranker puts the session that says it first", () => {
    const { ranked, targets } = rankSessions(item("q1"));
    expect(targets).toEqual(["answer_a1"]);
    expect(ranked[0]).toBe("answer_a1");
  });

  test("the dev slice is fixed by the ids, and the rest is everything else", () => {
    const items = Array.from({ length: 80 }, (_, i) => item(`q${i}`));
    const a = devIds(items), b = devIds([...items].reverse());
    expect(a.size).toBe(50);
    expect([...a].sort()).toEqual([...b].sort());
    expect(sliceOf(items, "dev").length + sliceOf(items, "rest").length).toBe(80);
    expect(sliceOf(items, "rest").some((i) => a.has(i.question_id))).toBe(false);
  });

  test("held-out runs are counted per dataset file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-lme-state-"));
    const prev = process.env.PB_LME_STATE;
    process.env.PB_LME_STATE = dir;
    try {
      expect(priorRestRuns("h1")).toBe(0);
      writeFileSync(join(dir, "longmemeval-rest-runs.jsonl"), JSON.stringify({ data: "h1" }) + "\n" + JSON.stringify({ data: "h2" }) + "\n");
      expect(priorRestRuns("h1")).toBe(1);
      expect(priorRestRuns("h3")).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.PB_LME_STATE; else process.env.PB_LME_STATE = prev;
    }
  });

  test("the table counts skipped questions apart from scored ones", () => {
    const t = table([{ id: "a", type: "t", r5any: true, r10any: true, r5all: true, r10all: true }, { id: "b", type: "t", skipped: "abstention" }]);
    expect(t.at(-1)).toBe("| all | 1 | 1 | 100% | 100% | 100% | 100% |");
  });
});
