// SPDX-License-Identifier: AGPL-3.0-only
// Day one with no model key (next-level D7, audit v12 "The first hour", G708, G709): ordinary
// sentences about the owner themself ("I live in…", "My plate is…", "Our rent is…", "Remind me
// to…", "My dentist is Dr Lam, next visit 12 Dec") land on the owner's own page or the page they
// name, where before seven of ten bounced with "I didn't catch who or what that's about"; and the
// facts `init` starts a brain with are on the home's diary from the first day.
import { test, expect, beforeAll, setDefaultTimeout } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDemoBrain } from "./fixture";
import { ownerSay, ownerSayModel, parseTells } from "../src/owner-say";
import { makeModel } from "../src/model";
import { loadBrain } from "../src/brain";
import { readDiary } from "../src/diary";
import { initBrain } from "../src/init";

// Each test here is several owner sentences, each one a commit on the demo brain: 2 s on a fast
// machine, over bun's 5 s limit on a slow CI runner (PR 174, twice on 2026-11-14). A test that
// runs out of time has its git child killed, which reads as a refused sentence.
setDefaultTimeout(30_000);

const ME = "people/robin-lefebvre";
let root: string;
beforeAll(async () => { root = (await makeDemoBrain()).root; }, 60_000);
const fact = (id: string, attr: string) => JSON.stringify(loadBrain(root).find((n) => n.fm.id === id)?.fm.facts?.[attr] ?? null);
const byTitle = (title: string) => loadBrain(root).find((n) => n.fm.title === title);

test("a sentence about the owner lands on the owner's own page (G708)", () => {
  const cases: [string, string, string][] = [
    ["I live in Toronto", "city", "Toronto"],
    ["I prefer meetings after 10", "prefers", "meetings after 10"],
    ["I teach Product Strategy at Lakeview College on Tuesdays", "teaches", "Product Strategy at Lakeview College on Tuesdays"],
    ["My plate is ABC 123", "plate", "ABC 123"],
    ["Remind me to renew the passport", "next_step", "renew the passport"],
  ];
  for (const [said, attr, value] of cases) {
    const r = ownerSay(root, said, { fresh: true });
    expect([said, r.kind]).toEqual([said, "say.noted"]);
    expect(fact(ME, attr)).toContain(value);
  }
  // Teaching is said beside the owner's role, never over it.
  expect(fact(ME, "role")).toContain("director of product");
});

test("a money sentence with a thousands comma is one fact on the owner's page", () => {
  expect(parseTells("Our rent is 1,850 a month")).toHaveLength(1);
  const r = ownerSay(root, "Our rent is 1,850 a month", { fresh: true });
  expect(r.kind).not.toBe("say.didnt-catch");
  expect(fact(ME, "rent")).toContain("1,850 a month");
});

test("my dentist is a person page tied to the owner, and its next visit is that page's next step", () => {
  const r = ownerSay(root, "My dentist is Dr Lam, next visit 12 Dec", { fresh: true });
  expect(r.kind).toBe("say.noted");
  const lam = byTitle("Dr Lam");
  expect(lam?.fm.type).toBe("person");
  expect(fact(lam!.fm.id, "relationship")).toContain("Robin Lefebvre's dentist");
  expect(fact(lam!.fm.id, "next_step")).toMatch(/visit[^"]*12 Dec/);
  // and the box finds them again by that role.
  expect(ownerSay(root, "who is my dentist?", { fresh: true }).text).toContain("Dr Lam");
});

test("a person's number is their phones", () => {
  const r = ownerSay(root, "Maya Chen's number is 514 555 0199", { fresh: true });
  expect(r.kind).toBe("say.noted");
  expect(fact("people/maya-chen", "phones")).toContain("+15145550199"); // normalized as phones are
  expect(fact("people/maya-chen", "number")).toBe("null");
});

test("init's facts are on the diary from day one (G709)", () => {
  const fresh = mkdtempSync(join(tmpdir(), "pb-dayone-"));
  initBrain(fresh, { owner: "Noor Haddad", text: [join(import.meta.dir, "..", "examples", "seed", "notes.txt")], token: false });
  const rows = readDiary(fresh);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every((r) => r.kind === "new")).toBe(true);
  const facts = loadBrain(fresh).reduce((s, n) => s + Object.keys(n.fm.facts ?? {}).length, 0);
  expect(rows.length).toBe(facts);
  // In the init commit itself: nothing left to commit.
  expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: fresh }).stdout.toString().trim()).toBe("");
});

test("with a model, a sentence about the owner is still read by the patterns, never sent", async () => {
  const calls: unknown[] = [];
  const model = makeModel({ provider: "fake", model: "fake-reader" }, { fake: (req) => { calls.push(req); return JSON.stringify({ kind: "tell", facts: [{ name: "I", attribute: "city", value: "Ottawa" }] }); } });
  const r = await ownerSayModel(root, "I live in Ottawa", { fresh: true }, model);
  expect(r.kind).toBe("say.noted");
  expect(fact(ME, "city")).toContain("Ottawa");
  expect(calls).toHaveLength(0);
});
