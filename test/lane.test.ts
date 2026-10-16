// SPDX-License-Identifier: AGPL-3.0-only
// Lanes (scripts/lane.ts): what each file counts as, and the ceiling: a file no rule names is
// "other", never quietly backend or ui.
import { test, expect } from "bun:test";
import { laneOf, lanes } from "../scripts/lane";

test("each file lands in its lane", () => {
  const table: [string, string][] = [
    ["src/dashboard/server.ts", "ui"],
    ["src/browser.ts", "ui"],
    ["test/ui/door-start.aria.yml", "ui"],
    ["test/dashboard-edit.test.ts", "ui"],
    ["test/browser.test.ts", "ui"],
    ["src/write.ts", "backend"],
    ["test/write.test.ts", "backend"],
    ["package.json", "backend"],
    ["bun.lock", "backend"],
    ["examples/brain/people/jane-roy.md", "backend"],
    ["evals/cases/agents.ts", "evals"],
    [".github/workflows/ci.yml", "harness"],
    [".claude/hooks/guard.ts", "harness"],
    ["scripts/deploy.ts", "harness"],
    ["docs/release.md", "docs"],
    ["README.md", "docs"],
    ["CHANGELOG.md", "docs"],
    ["examples/video/film/assets/mark.png", "other"],
    ["rules/policy.yaml", "other"],
    ["notes.txt", "other"],
  ];
  expect(table.map(([p]) => [p, laneOf(p)])).toEqual(table);
});

test("a change lists its lanes once, in a fixed order", () => {
  expect(lanes(["docs/a.md", "src/write.ts", "src/dashboard/data.ts", "src/core.ts"])).toEqual(["ui", "backend", "docs"]);
  expect(lanes([])).toEqual([]);
});
