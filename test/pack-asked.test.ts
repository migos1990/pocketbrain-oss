// SPDX-License-Identifier: AGPL-3.0-only
// The pack answers the question asked (next-level move 1, G768): what the usefulness number
// (src/usefulness.ts) counts as noise leaves it when no question needs it. The hub's "From its
// facts" block goes (the bullets and the Connected line already say it), a note's references are
// one line, the related words the lexicon added aren't printed, Connected names at most five, the
// best three notes come whole and the next five as one line, and the week comes only for a topic
// about time ("next" alone is not).
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { contextPack } from "../src/core";

const block = (pack: string, id: string) => {
  const i = pack.search(new RegExp(`^### .*\`${id.replace(/[/.-]/g, "\\$&")}\`$`, "m"));
  const j = pack.indexOf("\n### ", i + 1);
  return i < 0 ? "" : pack.slice(i, j < 0 ? undefined : j);
};

test("a topic pack has no hub block, one references line per note, at most five connected (G768)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "claude", "who is Maya");
  const maya = block(pack, "people/maya-chen");
  expect(maya).toContain("**role** [current]: design lead");
  // The person's own paragraph stays, with what it cites.
  expect(maya).toContain("She is the one to ask before anything ships with a new screen.");
  expect(pack).not.toContain("From its facts");
  expect(pack).not.toContain("[^p-rel-");
  // No footnote definition on a line of its own: one References line per note.
  expect(pack).not.toMatch(/^\[\^[^\]\s]+\]:/m);
  expect(maya).toMatch(/^References: \[\^1\] Email, 2026-08-10 \(gmail:000000000000d005\)$/m);
  const conn = maya.split("\n").find((l) => l.startsWith("Connected: "))!;
  expect((conn.match(/`[^`]+`/g) ?? []).length).toBeLessThanOrEqual(5);
  expect(conn).toMatch(/and \d+ more \(read this note for all\)$/);
  // The best three notes whole, the next three as their facts alone (no sources: the Cite as line
  // names them) with their Connected line, the next ones as one line of titles and ids. The fourth
  // here holds an answer (Maya's org is a software company): it comes.
  expect((pack.match(/\n### /g) ?? []).length).toBe(6);
  const org = block(pack, "orgs/harbourline");
  expect(org).toContain("- **kind** [current]: software company\n");
  expect(org).toContain("Cite as: ");
  expect(org).toContain("Connected: ");
  expect(pack).toMatch(/\n\nAlso matching, not shown \(read one by id if it helps\): [^\n]+ `[^`]+`(, [^\n]+ `[^`]+`)*\n$/);
}, 60_000);

test("the lexicon's related words aren't printed on a matched note (G768)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "claude", "Atlas launch semaine");
  expect(pack).not.toContain("and related words");
}, 60_000);

test("the week comes for a topic about time, not for 'next' alone (G768)", async () => {
  const { root } = await makeDemoBrain();
  expect(contextPack(root, "claude", "what's next for Atlas")).not.toContain("## Your week");
  expect(contextPack(root, "claude", "prochaine étape Atlas")).not.toContain("## Your week");
  expect(contextPack(root, "claude", "what's coming up this week")).toContain("## Your week");
}, 60_000);

test("a match the character budget leaves out is named on the also line, never dropped unnamed (G768)", async () => {
  const { carve, grantFor } = await import("../src/carve");
  const { loadBrain } = await import("../src/brain");
  const { loadRules } = await import("../src/rules");
  const { buildIndex, pack } = await import("../src/retrieve");
  const { root } = await makeDemoBrain();
  const ru = loadRules(root);
  const idx = buildIndex(carve(loadBrain(root), ru, grantFor(ru, "claude")), ru);
  const full = pack(idx, "who is Maya");
  const tight = pack(idx, "who is Maya", { budget: 1 });
  expect(tight.ids).toEqual(full.ids.slice(0, 1));
  // Every match of the full pack is still there: given, or named on the also line, in rank order.
  expect([...tight.ids, ...tight.also.map((a) => a.id)]).toEqual([...full.ids, ...full.also.map((a) => a.id)]);
}, 60_000);

test("a who question opens with the person, not the org they work at (G774)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "claude", "who do I ask to move a room at Lakeshore?");
  const first = pack.match(/^### .*`([^`]+)`$/m)?.[1];
  expect(first).toBe("people/isabelle-roy");
  // The org still comes, below the people.
  expect(pack).toContain("`orgs/lakeshore-college`");
}, 60_000);

test("'anything new about X' is about X: an agent that can't see X is told so (G775)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "gemini", "anything new about the kitchen?");
  expect(pack).not.toMatch(/^### /m);
  expect(pack).toContain("Nothing in your view matches.");
  // The words alone still find what they name for an agent that can see it.
  expect(contextPack(root, "claude", "anything new about the kitchen?")).toContain("`projects/kitchen-renovation`");
}, 60_000);

test("a week question the week answers gets no notes that share only related words (G775)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "gemini", "what's on my plate this week?");
  expect(pack).toContain("## Your week");
  expect(pack).toContain("review the second round of mockups on 9 October");
  expect(pack).not.toContain("Not in your view");
  expect(pack).not.toMatch(/^### /m);
  expect(pack).not.toMatch(/The \d+ best matches/);
}, 60_000);
