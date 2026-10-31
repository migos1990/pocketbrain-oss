// SPDX-License-Identifier: AGPL-3.0-only
// The golden set runner (src/golden.ts, docs/prove-the-loop.md#the-golden-set).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { runGolden, loadGolden } from "../src/golden";

const readsLog = (root: string) => { try { return readFileSync(join(root, "log", "reads.jsonl"), "utf8"); } catch { return ""; } };

describe("pocketbrain golden", () => {
  test("the sample brain's five questions pass for every listed agent", () => {
    const root = makeBrain();
    const r = runGolden(root);
    expect(r.rows.length).toBe(6);
    expect(r.rows.filter((x) => x.grade === "fail")).toEqual([]);
    expect(r.text).toContain("6/6");
  });

  test("output names no question, answer or value", () => {
    const root = makeBrain();
    const r = runGolden(root);
    for (const s of ["Course A", "Grade the midterm", "coordinator", "advisor", "bank"]) expect(r.text).not.toContain(s);
  });

  test("asking doesn't count as the agent's reads", () => {
    const root = makeBrain();
    const before = readsLog(root);
    runGolden(root);
    expect(readsLog(root)).toBe(before);
  });

  test("a next step past its date fails as stale, not served as current", () => {
    const root = makeBrain();
    const f = join(root, "projects", "course-a.md");
    writeFileSync(f, readFileSync(f, "utf8").replace("value: Grade the midterm, as_of: 2026-10-01", "value: Grade the midterm by 2026-10-05, as_of: 2026-10-07"));
    const w01 = runGolden(root, { agent: "planner" }).rows.find((x) => x.id === "w01")!;
    expect(w01.freshness).toBe("stale");
    expect(w01.grade).toBe("fail");
  });

  test("a stale or due fact says why, and that nothing asks the owner about it, without its value", () => {
    const root = makeBrain();
    // Freshness is never asked, file all on or not (G452, outside review v5): it waits under Needs a look.
    writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: ask }\n");
    const f = join(root, "projects", "course-a.md");
    const orig = readFileSync(f, "utf8");
    writeFileSync(f, orig.replace("value: Grade the midterm, as_of: 2026-10-01", "value: Grade the midterm by 2026-10-05, as_of: 2026-10-01"));
    const dated = runGolden(root, { agent: "planner" }).rows.find((x) => x.id === "w01")!;
    expect(dated.why).toContain("its date passed 3 days ago");
    expect(dated.why).toContain("it waits under Needs a look, nothing asks");
    // No date in it, just old: due by its shelf life, asked as Still the plan?
    writeFileSync(f, orig.replace("as_of: 2026-10-01, sources", "as_of: 2026-09-20, sources"));
    const old = runGolden(root, { agent: "planner" });
    const w01 = old.rows.find((x) => x.id === "w01")!;
    expect(w01.grade).toBe("watch");
    expect(w01.why).toContain("last checked 18 days ago (shelf life 14d); no date in it ends it");
    expect(w01.why).toContain("nothing asks");
    expect(old.text).not.toContain("Grade the midterm");
    // A date in an attribute that doesn't end on its date: named, and nothing asks.
    const j = join(root, "people", "jane-roy.md");
    const person = readFileSync(j, "utf8");
    writeFileSync(j, person.replace(/role: \{ value: ([^,]+), as_of: [0-9-]+/, "role: { value: $1 until 2026-10-02, as_of: 2025-01-01"));
    const w02 = runGolden(root, { agent: "planner" }).rows.find((x) => x.id === "w02")!;
    expect(w02.grade).toBe("fail");
    expect(w02.why).toContain("role names a date but doesn't end on it (only next_step, due and deadline do)");
    expect(w02.why).toContain("nothing asks");
  });

  test("a wrong answer, a note outside the view and a missing file fail", () => {
    const root = makeBrain();
    const file = join(root, "evals", "other.yaml");
    writeFileSync(file, "questions:\n  - { id: a1, as: [planner], q: \"What's next on Course A?\", want: [projects/course-a], expect: next_step, answer: Submit grades }\n  - { id: a2, as: [planner], q: Who is my financial advisor?, want: [people/paul-advisor], expect: role }\n");
    const rows = runGolden(root, { file }).rows;
    expect(rows.map((r) => r.grade)).toEqual(["fail", "fail"]);
    expect(runGolden(root, { file: join(root, "nope.yaml") }).rows).toEqual([]);
  });

  test("questions with no q or no wanted note are dropped; as defaults to claude", () => {
    const root = makeBrain();
    const file = join(root, "evals", "x.yaml");
    writeFileSync(file, "questions:\n  - { id: b1, q: hi }\n  - { q: hello, want: projects/course-a }\n");
    expect(loadGolden(file)).toEqual([{ id: "w2", as: ["claude"], q: "hello", want: ["projects/course-a"], expect: "body" }]);
  });
});
