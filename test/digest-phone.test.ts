// SPDX-License-Identifier: AGPL-3.0-only
// The digest on a phone (owner, 2026-10-24: "bad UIs on phone", a screenshot of the week's pipe
// tables shown as raw text): a table is never pipes on the page; the week's day columns become one
// block per measure, a measure that didn't move says so in words, and "a / b / c" counts are split
// into one labelled measure each, so "6/8/0" never stands alone.
import { test, expect } from "bun:test";
import { miniMarkdown, digestPage } from "../src/dashboard/html";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { loadState } from "../src/dashboard/data";

const WEEK = [
  "# pocketBrain week, 2026-10-16 to 2026-10-22", "",
  "| | 10-16 | 10-17 | 10-18 | 10-19 | 10-20 | 10-21 | 10-22 |", "|---|---|---|---|---|---|---|---|",
  "| Re-explained | 0 | 0 | 0 | 0 | 0 | 0 | 0 |",
  "| Stale / due / disputed handed out | 6/8/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |",
  "| Your minutes | – | – | – | 3 | – | – | – |", "",
  "## Verdicts", "",
  "| Measure | Value | Verdict |", "|---|---|---|",
  "| Hub reachable | 99% of 400 checks | continue |", "",
].join("\n");

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the week's tables read as words on a phone, not pipes", () => {
  const html = miniMarkdown(WEEK);
  expect(html).not.toContain("|");
  const words = text(html);
  expect(words).toContain("Re-explained 0 every day");
  // Split into one labelled measure each; the day with a value names its day.
  expect(words).toContain("Stale handed out");
  expect(words).toContain("Due handed out");
  expect(words).toContain("Disputed handed out 0 every day");
  expect(words).not.toContain("6/8/0");
  expect(html).toMatch(/Oct 16[^]*?>6</);
  expect(words).toContain("Your minutes");
  expect(words).not.toContain("–");
  // A plain table is one line per row, its columns named.
  expect(words).toContain("Hub reachable: 99% of 400 checks · continue");
});

test("the digest page counts what waits as the home page does, and shows no ids, hashes or commands", () => {
  const root = makeBrain();
  expect(write(root, { agent: "helper", id: "projects/course-a", attribute: "next_step", value: "Book the room", as_of: "2026-10-07", sources: ["gmail:f000000000000005"], verification: "verified-by-source" } as never).outcome).toBe("inbox");
  const daily = [
    "# pocketBrain digest, 2026-10-08", "",
    "## Needs you (27)", "",
    "- **Proposal** 2026-10-08-capture-92ef41f9.yaml from helper: `projects/course-a#next_step` = \"Book the room\". `inbox --accept` or `--reject`.", "",
    "## Done automatically (1)", "",
    "- fe4a16b0 auto-fix: link to `projects/course-a` repaired", "",
    "Each is one commit; `git revert <hash>` or `undo --run <id>` takes it back.", "",
    "## Numbers", "", "- Writes: 3 (inbox 3)", "",
  ].join("\n");
  const s = loadState(root);
  const html = digestPage(s, "x", { file: "2026-10-08.md", text: daily }).body;
  const words = text(html);
  expect(words).not.toContain("Needs you (27)");
  expect(words).toContain("1 waiting on you");
  expect(words).not.toMatch(/\b[0-9a-f]{8}\b/);
  expect(words).not.toContain("#next_step");
  expect(words).not.toContain("--accept");
  expect(words).not.toContain("git revert");
  expect(words).toContain("Undo any of these in History");
  expect(words).toContain("link to Course A repaired");
});
