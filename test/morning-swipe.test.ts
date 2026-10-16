// SPDX-License-Identifier: AGPL-3.0-only
// The morning swipe (docs/decision-deck.md, "The morning swipe"): each fact a pull or capture
// proposed is one card with its source and the quote it came from; keep, drop, edit or later; the
// seconds spent on these cards are what `pocketbrain fill` grades against 2 minutes a day.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { makeBrain } from "./fixture";
import { buildDeck, recordSwipe } from "../src/deck";
import { fill, renderFill } from "../src/fill";
import { decideProposal } from "../src/write";

// makeBrain pins today to 2026-10-08.
function pulled(root: string, name: string, ref: string, quote: string, x: Record<string, unknown> = {}) {
  mkdirSync(join(root, "inbox"), { recursive: true });
  const file = `2026-10-08-capture-${name}.yaml`;
  writeFileSync(join(root, "inbox", file), YAML.stringify({
    proposed: "2026-10-08", by: "capture", reason: `capture inbox/captures/x.md: new fact; quote: "${quote}"`, checks: ["capture"], capture: "inbox/captures/x.md",
    request: { agent: "capture", kind: "fact", id: "people/jane-roy", attribute: "role", value: "Associate dean", as_of: "2026-10-08", sources: [ref], ...x },
  }));
  // In git like a real capture's proposal, so the owner's answer commits (src/write.ts commitPaths).
  Bun.spawnSync(["git", "-C", root, "add", "inbox"]);
  Bun.spawnSync(["git", "-C", root, "-c", "user.name=capture", "-c", "user.email=c@x", "commit", "-qm", `capture ${name}`]);
  return file;
}

test("a pulled fact is one card: its source, the fact, the quote, and keep / drop / edit / later", () => {
  const root = makeBrain();
  const file = pulled(root, "a1", "granola:n1@2026-10-08T09:00:00Z", "Jane is associate dean from Monday");
  const c = buildDeck(root, new Date()).cards.find((x) => x.key === `proposal:${file}`)!;
  expect(c.tag).toBe("From granola");
  expect(c.lines).toEqual(expect.arrayContaining([
    expect.objectContaining({ label: "role", value: "Associate dean" }),
    expect.objectContaining({ label: "Quote", value: "Jane is associate dean from Monday" }),
  ]));
  expect(c.choices.map((x) => x.id)).toEqual(["accept", "reject", "later", "edit"]);
  expect(c.choices.find((x) => x.id === "edit")).toMatchObject({ action: "", dir: "tap", href: "/note/people/jane-roy#f-role" });
  expect(c.lines.some((l) => l.label === "Why it waits")).toBe(false); // the quote is the why
});

test("a private pulled fact shows neither value nor quote", () => {
  const root = makeBrain();
  const file = pulled(root, "p1", "gmail:f000000000000006", "Jane's diagnosis came back", { sensitivity: "private" });
  const c = buildDeck(root, new Date()).cards.find((x) => x.key === `proposal:${file}`)!;
  expect(c.lines).toEqual([]);
  expect(JSON.stringify(c)).not.toContain("diagnosis");
});

test("seconds on pulled cards are the owner's review minutes, and fill grades them", () => {
  const root = makeBrain();
  const a = pulled(root, "k1", "granola:n1@2026-10-08T09:00:00Z", "q1");
  const b = pulled(root, "k2", "granola:n2@2026-10-08T09:00:00Z", "q2");
  decideProposal(root, a, "accept");
  decideProposal(root, b, "reject");
  recordSwipe(root, `proposal-accept:${a}`, 30_000);
  recordSwipe(root, `proposal-reject:${b}`, 45_000);
  recordSwipe(root, "dispute-decide:c-0001", 600_000); // not a pulled fact: not review time
  const f = fill(root, 7);
  expect(f.reviewMinutes).toBeCloseTo(1.25);
  expect(f.verdict.minutes).toBe("pass");
  expect(renderFill(f)).toContain("1.3 min on the deck");
});
