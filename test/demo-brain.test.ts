// SPDX-License-Identifier: AGPL-3.0-only
// The demo brain (scripts/demo-brain.ts, outside review 2026-10-29 item 2, G509): the brain the
// owner's screens and the UI tests are designed against. It must stay what its tables say, stay
// the size of a life, and the UI tests must never fall back to the 7-note sample brain.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseFiles, readDir, DEMO_DIR, factCount, weekMail } from "../scripts/demo-brain";
import { makeDemoBrain } from "./fixture";
import { loadBrain, parseNote } from "../src/brain";
import { citedProse, inboundLinks } from "../scripts/north-star";
import { unseenFacts } from "../src/seen";

test("examples/demo-brain is exactly what scripts/demo-brain.ts writes from its tables", async () => {
  const want = await baseFiles(), got = readDir(DEMO_DIR);
  expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
  const differ = Object.keys(want).filter((k) => got[k] !== want[k]);
  expect(differ).toEqual([]); // after editing scripts/demo-data.ts: bun scripts/demo-brain.ts
});

test("the demo brain is the size of a life: 60 people, about 500 facts, every page cited and almost all linked", () => {
  const notes = Object.entries(readDir(DEMO_DIR)).filter(([p]) => p.endsWith(".md") && !p.startsWith("rules/") && p.includes("/")).map(([p, t]) => parseNote(t, p));
  const by = (d: string) => notes.filter((n) => n.fm.id.startsWith(`${d}/`)).length;
  expect(by("people")).toBe(61); // 60 and the owner
  expect(by("projects")).toBe(14);
  expect(by("decisions")).toBe(10);
  expect(by("orgs")).toBe(12);
  expect(by("money")).toBe(2);
  expect(factCount(notes) + weekMail().length).toBeGreaterThanOrEqual(500);
  expect(notes.filter((n) => !citedProse(n)).map((n) => n.fm.id)).toEqual([]);
  const inbound = inboundLinks(notes);
  expect(notes.filter((n) => (inbound.get(n.fm.id) ?? 0) > 0).length / notes.length).toBeGreaterThanOrEqual(0.9);
});

test("nobody in the demo brain is reachable: every address is example.org or brain.example, and no phone number", () => {
  const text = Object.values(readDir(DEMO_DIR)).join("\n") + readFileSync(join(import.meta.dir, "..", "scripts", "demo-data.ts"), "utf8");
  const addresses = [...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0]);
  expect(addresses.filter((a) => !/@(example\.org|brain\.example|pocketbrain\.local)$/.test(a))).toEqual([]);
  expect(text.replace(/\b[0-9a-f]{16}\b/g, "").match(/\+?\d[\d ().-]{8,}\d/g)?.filter((x) => x.replace(/\D/g, "").length >= 10) ?? []).toEqual([]);
});

test("the replayed week ends on a day an owner meets: three conflicts, one private value held, an assistant with something wrong", async () => {
  const { root, conflicts } = await makeDemoBrain();
  expect(conflicts.length).toBe(3);
  expect(unseenFacts(root).map((u) => u.page)).toEqual(["people/helene-lefebvre"]);
  const memsync = readFileSync(join(root, "log", "memsync.jsonl"), "utf8");
  expect(memsync).toContain("people/isabelle-roy#role");
  expect(loadBrain(root).length).toBeGreaterThan(100);
  // One sender's two mails of the same day (G662): the later one is the next step, the earlier is
  // history, and neither is a conflict.
  const lectures = loadBrain(root).find((n) => n.fm.id === "projects/guest-lecture-series")!;
  expect((lectures.fm.facts!.next_step as { value: string }).value).toBe("send Zoe the slides for 17 November");
  expect(JSON.stringify(lectures.fm.history?.next_step ?? [])).toContain("confirm the projector for 17 November");
}, 60_000);

test("the UI tests are designed against the demo brain, never the 7-note sample", () => {
  for (const f of ["ui-rig.ts", "ui-regression.test.ts", "ui-quality.test.ts", "ui-rig-home.test.ts"]) {
    const src = readFileSync(join(import.meta.dir, f), "utf8");
    expect(`${f}: ${/\bmakeBrain\(|jane-roy|course-a/.test(src)}`).toBe(`${f}: false`);
  }
});
