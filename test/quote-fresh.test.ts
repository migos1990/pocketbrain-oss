// SPDX-License-Identifier: AGPL-3.0-only
// A source's kept words (G451) can carry a private, money, health or legal value even when the
// reference sits under an everyday sentence: one mail gives several facts. On the owner's page the
// words of an item that any such fact cites open only after a sign-in in the last 10 minutes, like
// the value itself (spec §8, audit v4).
import { test, expect } from "bun:test";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { putQuote, keepQuote } from "../src/quotes";
import { renderTouchedPages } from "../src/wiki";
import { loadState } from "../src/dashboard/data";
import { ownerPage } from "../src/dashboard/html-page";

const REF = "gmail:f00000000000000a";
const WORDS = "Jane is program dean; her fee is 1200 dollars a year";

function page(fee: boolean) {
  const root = makeBrain();
  const W = (attribute: string, value: string) => write(root, { agent: "planner", id: "people/jane-roy", attribute, value, as_of: "2026-10-05", sources: [REF], verification: "verified-by-source" } as never);
  W("role", "program dean");
  if (fee) W("fee", "1200 dollars a year");
  putQuote(root, "p1", WORDS);
  keepQuote(root, "p1", [REF]);
  renderTouchedPages(root, "2000-01-01T00:00:00Z");
  const s = loadState(root, new Date());
  const n = s.notes.find((x) => x.fm.id === "people/jane-roy")!;
  return { stale: ownerPage(s, "t", n, []), fresh: ownerPage(s, "t", n, [], { fresh: true }) };
}

test("words an item shares with a money fact open only after a fresh sign-in", () => {
  const { stale, fresh } = page(true);
  expect(fresh).toContain(WORDS);
  expect(stale).not.toContain("1200 dollars");
  expect(stale).toContain(`action="/action/sign-in-again"`);
});

test("words of an everyday item show as before", () => {
  const { stale } = page(false);
  expect(stale).toContain(WORDS);
});
