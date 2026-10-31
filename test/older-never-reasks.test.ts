// SPDX-License-Identifier: AGPL-3.0-only
// Older sources never re-ask (phone UI spec §4.6, owner 2026-10-26): once the owner has said a
// value, a source dated before it goes to history as superseded, with no conflict; the diary shows
// one line per fact per day ("3 older emails still say …; I kept your word"). Only a source dated
// after the owner's word opens a conflict.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { ownerSay } from "../src/owner-say";
import { loadBrain, type FactRecord } from "../src/brain";
import { readDiary } from "../src/diary";
import { homeView } from "../src/dashboard/home";
import { loadRules } from "../src/rules";

const jane = (root: string) => loadBrain(root).find((n) => n.fm.id === "people/jane-roy")!;
const disputes = (root: string) => loadBrain(root).filter((n) => n.fm.type === "dispute");
const email = (root: string, value: string, as_of: string, n: number) =>
  write(root, { agent: "planner", id: "people/jane-roy", attribute: "role", value, as_of, sources: [`gmail:f00000000000001${n}`], verification: "verified-by-source" } as never);

test("owner's word on Monday, three older emails on Tuesday: no conflict, one line", () => {
  process.env.PB_NOW = "2026-10-08T14:00:00Z";
  const root = makeBrain();
  expect(ownerSay(root, "Jane Roy's role is program director on 2026-10-08").kind).toBe("say.noted");
  for (const [i, d] of ["2026-10-02", "2026-10-04", "2026-10-07"].entries()) {
    const r = email(root, "Course coordinator", d, i);
    expect(r.outcome).not.toBe("disputed");
  }
  expect(disputes(root)).toHaveLength(0);
  const f = jane(root).fm.facts!.role as FactRecord;
  expect(f.value).toBe("program director");
  expect((jane(root).fm.history!.role as FactRecord[]).filter((h) => h.value === "Course coordinator" && h.sources.some((s) => String(s).startsWith("gmail:f00000000000001"))).length).toBeGreaterThan(0);
  const kept = readDiary(root).filter((r) => r.kind === "kept");
  expect(kept).toHaveLength(3);
  const lines = homeView(root, loadRules(root), loadBrain(root), new Date("2026-10-08T15:00:00Z"), { all: true }).since.filter((l) => l.what.includes("I kept your word"));
  expect(lines.map((l) => l.what)).toEqual(["3 older emails still say Jane's role is Course coordinator; I kept your word."]);
  delete process.env.PB_NOW;
});

test("a source dated after the owner's word still asks", () => {
  process.env.PB_NOW = "2026-10-08T14:00:00Z";
  const root = makeBrain();
  ownerSay(root, "Jane Roy's role is program director on 2026-10-03");
  expect(email(root, "Dean", "2026-10-07", 1).outcome).toBe("disputed");
  expect(disputes(root)).toHaveLength(1);
  delete process.env.PB_NOW;
});


// UI thread, audit v5 midday item 3: the owner's own earlier word ("chair last week") after their
// newer one ("dean") opened a conflict between two of their own words, both sides "you said".
// The owner's word dated before their live word is an earlier value: history, never a conflict.
// The same day, the latest thing they typed is their word now.
test("the owner's own earlier word goes to history, never a conflict against their newer word", () => {
  process.env.PB_NOW = "2026-10-08T14:00:00Z";
  const root = makeBrain();
  expect(ownerSay(root, "Jane Roy's role is dean").kind).toBe("say.noted");
  ownerSay(root, "Jane Roy's role is chair last week");
  expect(disputes(root)).toHaveLength(0);
  expect((jane(root).fm.facts!.role as FactRecord).value).toBe("dean");
  expect((jane(root).fm.history!.role as FactRecord[]).some((h) => h.value === "chair")).toBe(true);
  expect(readDiary(root).filter((r) => r.kind === "conflict")).toHaveLength(0);
  const lines = homeView(root, loadRules(root), loadBrain(root), new Date("2026-10-08T15:00:00Z"), { all: true }).since.map((l) => l.what);
  expect(lines).toContain("Jane's role was chair earlier, kept as history.");
  delete process.env.PB_NOW;
});

test("the same day, the owner's latest word replaces their earlier one", () => {
  process.env.PB_NOW = "2026-10-08T14:00:00Z";
  const root = makeBrain();
  ownerSay(root, "Jane Roy's role is dean");
  process.env.PB_NOW = "2026-10-08T15:00:00Z";
  ownerSay(root, "Jane Roy's role is chair");
  expect(disputes(root)).toHaveLength(0);
  expect((jane(root).fm.facts!.role as FactRecord).value).toBe("chair");
  delete process.env.PB_NOW;
});
