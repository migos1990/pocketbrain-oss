// SPDX-License-Identifier: AGPL-3.0-only
// No word list may decide what a thing is, where it belongs or who reads it (the owner's rule,
// 2026-11-12; G850). Every word list in src/ is registered in test/word-lists.ts with what it may
// do. A new one fails here until it is registered under a class that decides nothing, and the
// lists that decide today, and the ones nobody has classed yet, may only become fewer.
// What this does not catch: a decision made by matching words without a list (a shared title
// word, a substring, a prefix). The gaps for those are G851 to G861 in evals/gaps.ts.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { wordLists } from "./word-list-scan";
import { WORD_LISTS, CEILING } from "./word-lists";

const SRC = join(import.meta.dir, "..", "src");
const found: string[] = [];
for (const f of readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).sort())
  for (const k of wordLists(readFileSync(join(SRC, f), "utf8"))) found.push(`${f.replace(/\\/g, "/")}#${k}`);
const count = (c: string) => Object.values(WORD_LISTS).filter((x) => x.class === c).length;

test("the scan finds a quoted list and a regex alternation, and skips comments and code names", () => {
  const src = [
    'const TRAVEL = words(["flight", "hotel", "ferry", "booking", "layover"].join("|"));',
    "const KIN = /^(?:mother|father|sister|brother)$/i;",
    '// const OLD = ["flight", "hotel", "ferry", "booking", "layover"];',
    'const SCHEME = /^(gmail|gcal|gdoc):/;',
    'const two = ["alpha", "beta"];',
  ].join("\n");
  expect([...wordLists(src)]).toEqual(["TRAVEL", "KIN"]);
});

test("a list spread over lines is named by the const above it", () => {
  expect([...wordLists('const EVENT = words([\n  "appointment", "webinar", "consultation", "versus", "seminar",\n].join("|"));')]).toEqual(["EVENT"]);
});

test("every word list in src/ is registered in test/word-lists.ts", () => {
  expect(found.filter((k) => !WORD_LISTS[k])).toEqual([]);
});

test("test/word-lists.ts has no entry whose list is gone", () => {
  expect(Object.keys(WORD_LISTS).filter((k) => !found.includes(k))).toEqual([]);
});

test("a list that decides carries its gap id, and every other class says why", () => {
  const bad = Object.entries(WORD_LISTS).filter(([, x]) => x.class === "decides" ? !/^G\d+: /.test(x.why ?? "") : x.class !== "not-reviewed" && !x.why?.trim());
  expect(bad.map(([k]) => k)).toEqual([]);
});

test("lists that decide, and lists nobody has classed, only become fewer", () => {
  expect(count("decides")).toBeLessThanOrEqual(CEILING.decides);
  expect(count("not-reviewed")).toBeLessThanOrEqual(CEILING["not-reviewed"]);
  // The ceilings follow the counts down: lowering a count without lowering its ceiling leaves room to add one back.
  expect(CEILING).toEqual({ decides: count("decides"), "not-reviewed": count("not-reviewed") });
  expect(CEILING.decides).toBeLessThanOrEqual(5);
  expect(CEILING["not-reviewed"]).toBeLessThanOrEqual(236);
});
