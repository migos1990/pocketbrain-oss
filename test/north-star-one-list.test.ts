// SPDX-License-Identifier: AGPL-3.0-only
// One counted list (audit v10, 2026-11-01; the owner left the choice to the coordinator with
// "i trust u", and it chose this): the north star's asks are every item that waits for the owner,
// the held ones included, and home_asks is the number the owner's home shows (waitingCount), held
// values and all, not only its conflicts. The held lines stay as the breakdown of why.
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain } from "./fixture";
import { write } from "../src/write";
import { git } from "../src/git";
import { waitingCount } from "../src/dashboard/home";
import { unseenFacts } from "../src/seen";

test("home_asks is the home's own count, held values included", async () => {
  const { measure } = await import("../scripts/north-star");
  const root = makeBrain();
  writeFileSync(join(root, "rules", "escalation.yaml"), "health: { url: null }\nauto_decide: { file: all }\n");
  git(root, ["add", "rules/escalation.yaml"]); git(root, ["commit", "-q", "-m", "owner: file all"]);
  // An assistant's private value is saved unseen: the home shows it until the owner taps Show.
  expect(write(root, { agent: "planner", kind: "fact", id: "people/jane-roy", attribute: "office", value: "Room 9", sensitivity: "private", as_of: "2026-10-05", sources: ["gmail:f000000000000004"] } as never).outcome).toBe("committed");
  expect(unseenFacts(root).length).toBeGreaterThan(0);
  const now = new Date();
  const m = measure(root, new Date(now.getTime() - 86_400_000).toISOString(), now);
  const shown = waitingCount(root, new Date(now.getTime() + 36 * 3_600_000));
  expect(shown).toBeGreaterThan(0);
  expect(m.home_asks).toBe(shown);
  // The held lines are the breakdown of asks: each equals its own entry in asks_by_kind.
  for (const k of ["held_by_access", "held_by_capture", "held_by_ambiguity"] as const) expect(m[k]).toBe(m.asks_by_kind[k] ?? 0);
}, 60_000);

test("the north star's definition says a change to what it counts needs the owner's typed word", () => {
  const head = readFileSync(join(import.meta.dir, "..", "scripts", "north-star.ts"), "utf8").slice(0, 6000);
  expect(head).toMatch(/what it counts[^]*owner's (own )?typed word/i);
});
