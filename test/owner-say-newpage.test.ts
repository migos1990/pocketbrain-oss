// SPDX-License-Identifier: AGPL-3.0-only
// Starting a page from the box. Since Louis's read of 2026-10-29 (G474) an unknown name starts its
// page at once with what was said: in the area of a page the sentence names, else personal, with
// Undo. Only a brain with no personal area still asks where the page lives, one chip per area.
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { ownerSay } from "../src/owner-say";
import { loadBrain, type FactRecord } from "../src/brain";
import { loadRules } from "../src/rules";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

test("an unknown name starts its page in personal with the told fact, and Undo takes it back", () => {
  const root = makeBrain();
  const before = loadBrain(root).length;
  const r = ownerSay(root, "Zed Quorum works at Bay Institute");
  expect(r.kind).toBe("say.noted");
  expect(r.text).toContain("New page for Zed Quorum in personal");
  const n = loadBrain(root).find((x) => x.fm.title === "Zed Quorum")!;
  expect(n.fm.type).toBe("person");
  expect(n.fm.area).toBe("personal");
  expect(String((n.fm.facts!.org as FactRecord).value)).toContain("Bay Institute");
  expect((n.fm.facts!.org as FactRecord).verification).toBe("confirmed-by-owner");
  expect(r.undo_token).toBeTruthy();
  expect(loadBrain(root).length).toBe(before + 1);
});

test("a new name beside a known page starts in that page's area; on a page, the page's area", () => {
  const root = makeBrain();
  ownerSay(root, "Zed Quorum works at Course A");
  expect(loadBrain(root).find((x) => x.fm.title === "Zed Quorum")!.fm.area).toBe("work");
  ownerSay(root, "Ann Lime is a tutor", { page: "projects/course-a" });
  expect(loadBrain(root).find((x) => x.fm.title === "Ann Lime")!.fm.area).toBe("work");
});

test("a brain with no personal area still asks where the page lives; nothing is made until a chip is tapped", () => {
  const root = makeBrain();
  const f = join(root, "rules", "policy.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^  personal: \{ owner: steward \}\n/m, ""));
  const before = loadBrain(root).length;
  const r = ownerSay(root, "Zed Quorum works at Bay Institute");
  expect(r.kind).toBe("say.new-page");
  expect(loadBrain(root).length).toBe(before);
  const areas = Object.keys(loadRules(root).policy.areas);
  expect(areas).not.toContain("personal");
  expect(r.chips!.map((c) => c.say)).toEqual(areas.map((a) => `new page in ${a}: Zed Quorum works at Bay Institute`));
  const made = ownerSay(root, r.chips![0]!.say);
  expect(made.kind).toBe("say.noted");
  expect(loadBrain(root).find((x) => x.fm.title === "Zed Quorum")!.fm.area).toBe(areas[0]);
});

test("a next step starts a project page; a bare 'X is Y' still asks about the role first", () => {
  const root = makeBrain();
  const p = ownerSay(root, "new page in work: Garden Plan: next step is order seeds");
  expect(p.kind).toBe("say.noted");
  expect(loadBrain(root).find((x) => x.fm.title === "Garden Plan")!.fm.type).toBe("project");
  expect(ownerSay(root, "new page in work: Zed Quorum is tired").kind).toBe("say.confirm-role");
  expect(ownerSay(root, "new page in nowhere: Zed Quorum works at Bay").kind).toBe("say.didnt-catch");
});
