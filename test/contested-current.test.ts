// SPDX-License-Identifier: AGPL-3.0-only
// Audit v13, 2026-11-09 (G757; a regression from the pack-once change, G699): a value with a
// conflict waiting beside it reached an assistant marked [current] and nothing else. The only place
// that said "A different value is waiting to be checked." was the hub's sentence, which the pack
// now drops as a restatement of the bullet; and the week block stated one side as plain fact.
// Now the fact's own line carries the mark on every read, and the week's line says it too, until
// the owner settles it.
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { ownerDecide, ownerConflicts, readNote, contextPack } from "../src/core";

const WAITS = "a different value is waiting to be checked";
const bullet = (text: string, attr: string) => text.split("\n").find((l) => l.startsWith(`- **${attr}**`)) ?? "";
const weekLines = (text: string) => { const at = text.indexOf("## Your week"); return at < 0 ? [] : text.slice(at).split("\n\n")[0]!.split("\n").filter((l) => l.startsWith("- ")); };

test("G757 a contested value's own line says so in a pack, a read and the view; a settled one doesn't", async () => {
  const { root } = await makeDemoBrain();
  const c = ownerConflicts(root).find((x) => x.id === "c-0001")!;
  expect(c.fact_key).toBe("projects/atlas-launch#next_step");
  const pack = contextPack(root, "claude", "Atlas launch");
  expect(bullet(pack, "next_step")).toContain(`[current; ${WAITS}]`);
  // A fact nobody contests keeps its plain mark.
  expect(bullet(pack, "status")).toMatch(/\[current\]/);
  const md = (readNote(root, "claude", "projects/atlas-launch") as { markdown: string }).markdown;
  expect(bullet(md, "next_step")).toContain(WAITS);
  ownerDecide(root, "c-0001", c.sides[0]!.n);
  expect(contextPack(root, "claude", "Atlas launch")).not.toContain(WAITS);
}, 120_000);

test("G757 the week block says a contested step is contested, never as plain fact", async () => {
  const { root } = await makeDemoBrain();
  const week = weekLines(contextPack(root, "claude", "what's next this week?"));
  const atlas = week.filter((l) => l.includes("(projects/atlas-launch)"));
  expect(atlas.length).toBeGreaterThan(0);
  for (const l of atlas) expect(l.toLowerCase()).toContain(WAITS);
  // Only a page with a conflict open carries the mark, and the week has lines without one.
  const open = new Set(ownerConflicts(root).map((x) => x.fact_key.split("#")[0]));
  const marked = week.filter((l) => l.toLowerCase().includes(WAITS));
  for (const l of marked) expect([...open].some((id) => l.includes(`(${id})`)), l).toBe(true);
  expect(marked.length).toBeLessThan(week.length);
  const c = ownerConflicts(root).find((x) => x.id === "c-0001")!;
  ownerDecide(root, "c-0001", c.sides[0]!.n);
  expect(weekLines(contextPack(root, "claude", "what's next this week?")).filter((l) => l.includes("(projects/atlas-launch)")).join("\n").toLowerCase()).not.toContain(WAITS);
}, 120_000);

test("G757 every assistant that reads the fact gets the mark, not only the first", async () => {
  const { root, tokens } = await makeDemoBrain();
  let seen = 0;
  for (const agent of Object.keys(tokens)) {
    let md = "";
    try { md = (readNote(root, agent, "projects/atlas-launch") as { markdown: string }).markdown; } catch { continue; }
    const line = bullet(md, "next_step");
    if (!line) continue;
    seen++;
    expect(line).toContain(WAITS);
  }
  expect(seen).toBeGreaterThan(0);
}, 120_000);

// Slice audit of G757 (2026-11-09): a list item a conflict waits beside read as plainly current,
// and the conflict's own id reached an assistant in the read's JSON.
test("G757 a contested list item is marked, and no read carries the conflict's id", () => {
  const { makeBrain } = require("./fixture") as typeof import("./fixture");
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const root = makeBrain();
  const src = `as_of: 2026-10-07, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-07`;
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  next_step: { value: Book the room, contested: c-9001, ${src} }\n  rooms:\n    items:\n      - { value: Hall B, contested: c-9002, ${src} }\n      - { value: Hall C, ${src} }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "owner: course c"], { cwd: root });
  const r = readNote(root, "helper", "projects/course-c") as { markdown: string };
  const lines = r.markdown.split("\n");
  expect(lines.find((l) => l.includes("Hall B"))).toContain(WAITS);
  expect(lines.find((l) => l.includes("Hall C"))).not.toContain(WAITS);
  expect(JSON.stringify(r)).not.toMatch(/c-900[12]/);
  expect(contextPack(root, "helper", "Course C")).not.toMatch(/c-900[12]/);
});

// The other way a conflict is stored (progress check on audit v13): two candidates under one
// dispute. Neither is the fact's plain current value in a pack, a read or the week block.
test("G757 a fact stored as two candidates is never served as current", () => {
  const { makeBrain } = require("./fixture") as typeof import("./fixture");
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const root = makeBrain();
  const src = `as_of: 2026-10-07, sources: ["gmail:f000000000000009"], verification: verified-by-source, by: steward, recorded: 2026-10-07`;
  writeFileSync(join(root, "projects", "course-c.md"), `---\nid: projects/course-c\ntype: project\ntitle: Course C\narea: work\nsensitivity: personal\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\nby: steward\nfacts:\n  next_step:\n    dispute: c-9003\n    candidates:\n      - { value: book the hall on 10 October, ${src} }\n      - { value: book the hall on 12 October, ${src} }\n---\n`);
  Bun.spawnSync(["git", "add", "-A"], { cwd: root });
  Bun.spawnSync(["git", "-c", "user.name=louis", "-c", "user.email=l@x", "commit", "-qm", "owner: course c"], { cwd: root });
  for (const text of [contextPack(root, "helper", "Course C"), (readNote(root, "helper", "projects/course-c") as { markdown: string }).markdown, contextPack(root, "helper", "what is due this week?")]) {
    const lines = text.split("\n").filter((l) => /book the hall on 1[02] October/.test(l));
    for (const l of lines) { expect(l).not.toContain("[current]"); expect(l).not.toMatch(/^- (?:\S+ \S+: )?Course C \(projects\/course-c\): book the hall on 1[02] October \(/); }
  }
  const pack = contextPack(root, "helper", "Course C");
  expect(pack).toMatch(/next_step\*\* \[disputed/);
});
