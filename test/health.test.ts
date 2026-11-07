// SPDX-License-Identifier: AGPL-3.0-only
// Brain health in the week report (src/health.ts, docs/real-use-bar.md): facts with no live source,
// stale facts that change over time, conflicts open more than a week, notes nobody read in 90 days.
// One number per line, the one action that improves it, last week's number beside it.
import { test, expect } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { brainHealth, healthLines, withTrend } from "../src/health";
import { week } from "../src/measure";

// makeBrain pins today to 2026-10-08. person.role has a 180-day shelf life, project.next_step 14.
function note(root: string, path: string, fm: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), `---\n${fm.trim()}\n---\nbody\n`);
}
function seed(root: string) {
  for (const d of ["people", "projects", "decisions", "money"]) rmSync(join(root, d), { recursive: true, force: true });
  note(root, "people/ann.md", `
id: people/ann
type: person
title: Ann
area: work
sensitivity: personal
status: active
created: 2026-05-01
updated: 2026-05-01
by: helper
facts:
  role: { value: Editor, as_of: 2025-06-01, sources: ["agent:helper"], verification: self-reported, by: helper, recorded: 2026-05-01 }
  org: { value: Acme, as_of: 2026-05-01, sources: ["gmail:f000000000000001"], verification: verified-by-source, by: helper, recorded: 2026-05-01 }`);
  note(root, "people/ben.md", `
id: people/ben
type: person
title: Ben
area: work
sensitivity: personal
status: active
created: 2026-05-01
updated: 2026-05-01
by: helper
facts:
  role: { value: Chair, as_of: 2026-09-01, sources: ["agent:helper"], verification: confirmed-by-owner, by: helper, recorded: 2026-09-01 }
  phones:
    items:
      - { value: "+15145550100", as_of: 2026-05-01, sources: ["gmail:f000000000000002"], verification: verified-by-source, by: helper, recorded: 2026-05-01 }
      - { value: "+15145550101", as_of: 2026-05-01, sources: ["gmail:f000000000000003"], verification: verified-by-source, by: helper, recorded: 2026-05-01, recheck: { why: gone, ref: "gmail:f000000000000003", at: 2026-10-01 } }
      - { value: "+15145550102", as_of: 2026-05-01, sources: ["unverified"], verification: unverified, by: helper, recorded: 2026-05-01, valid_to: 2026-06-01 }`);
  note(root, "projects/pub.md", `
id: projects/pub
type: project
title: Pub
area: work
sensitivity: personal
status: active
created: 2026-10-01
updated: 2026-10-01
by: helper
facts:
  next_step: { value: Draft, as_of: 2026-09-01, sources: ["gmail:f000000000000004"], verification: verified-by-source, by: helper, recorded: 2026-10-01 }`);
  const dispute = (id: string, created: string, status: string) => note(root, `disputes/${id}.md`, `
id: disputes/${id}
type: dispute
title: people/ann#org
area: work
sensitivity: personal
status: ${status}
created: ${created}
updated: ${created}
by: reflect
fact_key: people/ann#org`);
  dispute("c-0001", "2026-09-20", "open");
  dispute("c-0002", "2026-10-05", "open");
  dispute("c-0003", "2026-09-01", "resolved");
  mkdirSync(join(root, "log"), { recursive: true });
  appendFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-06-01T10:00:00Z", agent: "helper", op: "search", ids: ["*"] }) + "\n");
  appendFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-09-30T10:00:00Z", agent: "helper", op: "read", ids: ["people/ben"] }) + "\n");
}

test("four numbers: no live source, stale volatile facts, conflicts older than a week, notes nobody read", () => {
  const root = makeBrain();
  seed(root);
  const h = Object.fromEntries(brainHealth(root).map((l) => [l.key, l]));
  // ann.role (an agent's own word), ben's phone whose source vanished; the owner's word and exact refs are live,
  // the ended phone doesn't count at all
  expect(h.unsourced).toMatchObject({ count: 2, of: 6 });
  // ann.role and pub.next_step are past twice their shelf life; ben.role is fresh; org and phones have none
  expect(h.stale).toMatchObject({ count: 2, of: 3 });
  expect(h["old-disputes"]).toMatchObject({ count: 1, of: 2 });
  // pub is too new to have been missed for 90 days; ben was read
  expect(h.unread).toMatchObject({ count: 1, of: 2 });
  expect(h.unread.since).toBeUndefined();
});

test("each line is one number with its one fix, no fact value, and last week's number beside it", () => {
  const root = makeBrain();
  seed(root);
  const first = healthLines(withTrend(root, brainHealth(root, undefined, "2026-10-01"), "2026-10-01"));
  expect(first.join("\n")).not.toContain("last week");
  const text = healthLines(withTrend(root, brainHealth(root), "2026-10-08")).join("\n");
  expect(text).toContain("## Brain health");
  expect(text).toContain("- Facts with no live source: 33% (2 of 6; last week 33%). Fix: run pocketbrain sources backfill");
  expect(text).toContain(`- Stale facts that change over time: 67% (2 of 3; last week`);
  expect(text).toContain(`Fix: mark them Still true or change them under the Brain's To recheck.`);
  expect(text).toContain(`- Conflicts open more than 7 days: 50% (1 of 2`);
  expect(text).toContain(`Fix: settle them from Waiting on you on the home.`);
  for (const secret of ["Editor", "Acme", "Chair", "+1514", "gmail:f0", "Ann", "Ben"]) expect(text).not.toContain(secret);
  // a line with nothing wrong carries no fix
  for (const l of text.split("\n").filter((x) => x.includes(": 0% ("))) expect(l).not.toContain("Fix:");
});

test("too little read history says no data instead of calling every note unread", () => {
  const root = makeBrain();
  seed(root);
  writeFileSync(join(root, "log", "reads.jsonl"), JSON.stringify({ at: "2026-09-30T10:00:00Z", agent: "helper", op: "read", ids: ["people/ben"] }) + "\n");
  const text = healthLines(brainHealth(root)).join("\n");
  expect(text).toContain("- Notes no assistant read in 90 days: no data yet (reads logged since 2026-09-30).");
});

test("pocketbrain week carries the brain health section", () => {
  const root = makeBrain();
  seed(root);
  const w = week(root, "2026-10-08");
  expect(w.text).toContain("## Brain health");
  expect(w.text).toContain("Conflicts open more than 7 days: 50% (1 of 2)");
});

test("people and projects with no wiki summary: a fifth line, filled by the Gardener", () => {
  const root = makeBrain();
  const line = () => brainHealth(root).find((l) => l.key === "no-summary")!;
  // jane-roy, paul-advisor, course-a and course-b: none has a summary yet
  expect(line()).toMatchObject({ count: 4, of: 4 });
  expect(healthLines([line()]).join("\n")).toContain("- People and projects with no wiki summary: 100% (4 of 4). Fix: nothing by hand: the Gardener writes them from their facts");
  const f = join(root, "projects", "course-a.md");
  writeFileSync(f, readFileSync(f, "utf8").replace("title: Course A", "title: Course A\nsummary: A course in its grading weeks."));
  expect(line()).toMatchObject({ count: 3, of: 4 });
});

test("Gardener writes the hub refused: a sixth line, from the call log, last 7 days, pages and facts alike", () => {
  const root = makeBrain();
  const line = () => brainHealth(root, undefined, "2026-10-22").find((l) => l.key === "gardener-refused")!;
  expect(line()).toMatchObject({ count: 0, of: 0 });
  mkdirSync(join(root, "log"), { recursive: true });
  const call = (at: string, refused?: string) => JSON.stringify({ at: `${at}T07:30:00Z`, agent: "gardener", tool: "wiki_sync", ...(refused ? { refused } : {}) });
  writeFileSync(join(root, "log", "calls.jsonl"), [call("2026-10-10", "the text carries"), call("2026-10-18", "the text carries"), call("2026-10-19"), call("2026-10-20", "the text carries"), JSON.stringify({ at: "2026-10-20T07:30:00Z", agent: "gardener", tool: "remember", refused: "id … contains an agent name" }), JSON.stringify({ at: "2026-10-20T07:30:00Z", agent: "planner", tool: "remember", refused: "x" }), JSON.stringify({ at: "2026-10-20T07:30:00Z", agent: "gardener", tool: "search", refused: "x" })].join("\n") + "\n");
  expect(line()).toMatchObject({ count: 3, of: 4 });
  expect(healthLines([line()]).join("\n")).toContain("- Gardener writes the hub refused in 7 days: 75% (3 of 4)");
});
