// SPDX-License-Identifier: AGPL-3.0-only
// The pack says each fact once (audit v12, next-level D6): a topic pack gives a note's facts as its
// bullets and leaves out the hub's sentences that only restate them ("From its facts", G699); the
// sentences that say something the bullets don't (how its pages are tied) stay. An agent whose
// words no note in its view holds is told plainly that it isn't in its view, with at most three
// notes that share only related words, instead of a page of weak hits (G700).
import { test, expect } from "bun:test";
import { makeDemoBrain } from "./fixture";
import { contextPack } from "../src/core";

const block = (pack: string, id: string) => {
  const i = pack.indexOf(`\`${id}\``);
  const j = pack.indexOf("\n### ", i + 1);
  return i < 0 ? "" : pack.slice(i, j < 0 ? undefined : j);
};

test("a topic pack gives each fact once: the bullets, not the hub's sentences restating them (G699)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "claude", "Atlas launch");
  const atlas = block(pack, "projects/atlas-launch");
  expect(atlas).toContain("**status** [current]: in beta");
  expect(atlas).not.toContain("Atlas launch is in beta.");
  expect(atlas).not.toContain("Due for Atlas launch");
  expect(pack).not.toContain("[^pf-");
  // "See also" is the Connected line's job.
  expect(pack).not.toMatch(/See also \[\[/);
  // How its pages are tied is the Connected line's too: the whole hub block leaves the pack (G768).
  expect(atlas).not.toContain("[^p-rel-");
  expect(atlas).toContain("Connected: ");
  // The person's own paragraph stays whole.
  expect(atlas).toContain("The Atlas launch is the big one this fall");
}, 60_000);

test("words no note in the view holds get a plain not-in-your-view line and at most three related notes (G700)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "gemini", "the tile delivery");
  const head = pack.split("\n### ")[0]!;
  expect(head).toContain("Not in your view:");
  expect(head).toContain("not in my view");
  expect((pack.match(/\n### /g) ?? []).length).toBeLessThanOrEqual(3);
  // A question the view does hold gets no such line.
  expect(contextPack(root, "gemini", "Pinecrest pilot")).not.toContain("Not in your view:");
}, 60_000);

test("a paragraph left out because it only restates facts is not counted as more to read (G699)", async () => {
  const { root } = await makeDemoBrain();
  const pack = contextPack(root, "claude", "Atlas launch");
  // Short pages come whole: nothing is left to read, though their "From its facts" was dropped.
  for (const id of ["projects/atlas-launch", "people/hannah-becker"]) expect(block(pack, id)).not.toContain("more paragraph");
});
