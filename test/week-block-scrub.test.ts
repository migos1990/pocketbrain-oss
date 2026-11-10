// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13 slice audit, medium (G764): the Your week block of a pack printed a fact's raw value.
// A visible next step holding a value a private record hides read "[withheld]" on read, search and
// the topic pack, and the value itself in a pack with a week topic, when reads don't come from
// cells (the CLI's --as, serve --no-cells). The block now scrubs each line like any other text.
import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { contextPack, readNote } from "../src/core";

test("G764 the week block withholds a carved value in a next step, as a read does", () => {
  const root = makeBrain();
  // money/main-bank holds "Maple Trust Bank", out of helper's view; the step is on a page it reads.
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  next_step: { value: "call Maple Trust Bank on 10 October", as_of: 2026-10-07, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-07 }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "owner: course c"], { cwd: root });
  expect(JSON.stringify(readNote(root, "helper", "projects/course-c"))).not.toContain("Maple Trust");
  const pack = contextPack(root, "helper", "what is due this week?");
  expect(pack).toContain("## Your week");
  expect(pack).toContain("Course C (projects/course-c): call [withheld] on 10 October");
  expect(pack).not.toContain("Maple Trust");
  // The one who may see the bank reads the step whole.
  expect(contextPack(root, "steward", "what is due this week?")).toContain("call Maple Trust Bank on 10 October");
});

// Slice audit of G764 (2026-11-09): a bare id of a page out of view is redacted in the week block
// as on a read, and a line whose words are withheld whole is left out, day and all.
test("G764 the week block redacts a bare page id and leaves out a line withheld whole", () => {
  const root = makeBrain();
  const src = `as_of: 2026-10-07, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-07`;
  const page = (id: string, title: string, step: string) => writeFileSync(join(root, `${id}.md`), `---\nid: ${id}\ntype: project\ntitle: ${title}\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  next_step: { value: "${step}", ${src} }\n---\n`);
  page("projects/course-c", "Course C", "money/main-bank");
  page("projects/course-d", "Course D", "Fees with Maple-Trust-Bank");
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "owner: courses"], { cwd: root });
  const pack = contextPack(root, "helper", "what is due this week?");
  expect(pack).toContain("## Your week");
  expect(pack).not.toContain("money/main-bank");
  // A step that is only a link to a page out of view is no line at all, as for any hidden link.
  expect(pack.slice(pack.indexOf("## Your week")).split("\n\n")[0]).not.toContain("(projects/course-c)");
  const week = pack.slice(pack.indexOf("## Your week")).split("\n\n")[0]!;
  expect(week).not.toContain("(projects/course-d)");
  // A section whose every line was left out prints no heading either (slice audit, cosmetic).
  for (const h of ["Past due:", "This week:", "Coming up:", "Next steps with no date:"]) { const at = week.split("\n").indexOf(h); if (at >= 0) expect(week.split("\n")[at + 1] ?? "", h).toMatch(/^- /); }
  expect(week).not.toContain("Maple Trust");
});
